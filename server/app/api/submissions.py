"""Submission routes: HTTP in, HTTP out. The intake rules live in app.intake.submissions."""

import math
import uuid as uuidlib
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi import Path as PathParam
from fastapi.concurrency import run_in_threadpool
from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    JsonValue,
    StringConstraints,
    ValidationError,
)
from starlette.datastructures import UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.rbac import require_role
from app.db.models import Form, FormVersion, MediaFile, RepeatRow, Submission, User
from app.db.session import get_session
from app.intake.duplicates import likely_duplicates
from app.intake.submissions import (
    MAX_MEDIA_PARTS,
    MAX_SUBMISSION_JSON_BYTES,
    IntakeRefused,
    MediaPart,
    SubmissionMeta,
    lenient_dt,
    resolve_form_version,
    store_submission,
)

router = APIRouter(prefix="/api", tags=["submissions"])

_STATUSES = Literal["received", "flagged", "approved", "rejected"]
_anyone = require_role("admin", "supervisor", "enumerator")
_staff = frozenset({"admin", "supervisor"})


# ---- request / response models ----------------------------------------------------


def _lenient_float(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


class SubmissionIn(BaseModel):
    model_config = ConfigDict(extra="ignore", allow_inf_nan=False)

    uuid: str = Field(min_length=1, max_length=64)
    form_id: str = Field(min_length=1, max_length=150)
    version: str = Field(min_length=1, max_length=50)
    data: dict[str, JsonValue]
    repeats: dict[Annotated[str, StringConstraints(min_length=1, max_length=150)], list[dict[str, JsonValue]]] = {}
    device_id: str | None = Field(default=None, max_length=100)
    started_at: Annotated[datetime | None, BeforeValidator(lenient_dt)] = None
    finished_at: Annotated[datetime | None, BeforeValidator(lenient_dt)] = None
    gps_lat: Annotated[float | None, BeforeValidator(_lenient_float)] = None
    gps_lon: Annotated[float | None, BeforeValidator(_lenient_float)] = None
    gps_accuracy: Annotated[float | None, BeforeValidator(_lenient_float)] = None


class FailureOut(BaseModel):
    question: str
    rule: str
    message: str | None


class Receipt(BaseModel):
    uuid: str
    status: str
    received_at: datetime
    failures: list[FailureOut]


class SubmissionSummary(BaseModel):
    uuid: str
    form_id: str
    version: str
    status: str
    submitted_by: int
    received_at: datetime
    failure_count: int


class SubmissionPage(BaseModel):
    items: list[SubmissionSummary]
    total: int
    page: int
    page_size: int


class MediaOut(BaseModel):
    question_name: str
    content_type: str
    size: int
    sha256: str


class SubmissionDetail(SubmissionSummary):
    data: dict[str, Any]
    repeats: dict[str, list[dict[str, Any]]]
    failures: list[FailureOut]
    media: list[MediaOut]
    device_id: str | None
    started_at: datetime | None
    finished_at: datetime | None
    gps_lat: float | None
    gps_lon: float | None
    gps_accuracy: float | None
    likely_duplicates: list[str]  # uuids; staff only, always [] for an enumerator


def _receipt(s: Submission) -> Receipt:
    return Receipt(
        uuid=s.uuid,
        status=s.status,
        received_at=s.received_at,
        failures=[FailureOut(**f) for f in (s.failures_json or [])],
    )


# ---- routes -----------------------------------------------------------------------------


def _refuse(e: IntakeRefused) -> HTTPException:
    return HTTPException(status_code=e.status_code, detail=e.body())


async def _read_part(part: UploadFile, limit: int) -> bytes:
    return await part.read(limit + 1)  # one byte over the cap is enough to know it is over


def _intake(db: Session, user: User, body: SubmissionIn, media: dict[str, MediaPart], request: Request):
    try:
        fv = resolve_form_version(db, user, body.form_id, body.version, body.uuid)
        meta = SubmissionMeta(
            device_id=body.device_id,
            started_at=body.started_at,
            finished_at=body.finished_at,
            gps_lat=body.gps_lat,
            gps_lon=body.gps_lon,
            gps_accuracy=body.gps_accuracy,
        )
        return store_submission(db, fv, user, body.data, body.repeats, media, body.uuid, request, meta=meta)
    except IntakeRefused as e:
        raise _refuse(e) from None


@router.post("/submissions", response_model=Receipt, status_code=201)
async def create_submission(
    request: Request,
    response: Response,
    user: User = Depends(_anyone),
    db: Session = Depends(get_session),
) -> Receipt:
    cap = get_settings().max_media_bytes
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_MEDIA_PARTS * cap + MAX_SUBMISSION_JSON_BYTES + 65536:
        raise HTTPException(status_code=413, detail="Request is larger than the media size limit allows")
    form = await request.form(max_files=MAX_MEDIA_PARTS + 1, max_fields=8, max_part_size=MAX_SUBMISSION_JSON_BYTES)
    try:
        raw: str | None = None
        media: dict[str, MediaPart] = {}
        for key, value in form.multi_items():
            if key == "submission":
                if raw is not None:
                    raise HTTPException(status_code=422, detail="Send exactly one submission part")
                if isinstance(value, UploadFile):
                    try:
                        raw = (await _read_part(value, MAX_SUBMISSION_JSON_BYTES)).decode("utf-8")
                    except UnicodeDecodeError:
                        raise HTTPException(status_code=422, detail="submission must be UTF-8 JSON") from None
                else:
                    raw = value
            elif isinstance(value, UploadFile):
                if key in media:
                    raise HTTPException(status_code=422, detail="Two files were sent for one question")
                media[key] = MediaPart(value.filename or "", await _read_part(value, cap))
        if raw is None:
            raise HTTPException(status_code=422, detail="The submission part is missing")
    finally:
        await form.close()
    try:
        body = SubmissionIn.model_validate_json(raw)
    except ValidationError as e:
        raise HTTPException(
            status_code=422, detail=e.errors(include_url=False, include_context=False, include_input=False)
        ) from None
    sub, created = await run_in_threadpool(_intake, db, user, body, media, request)
    if not created:
        response.status_code = 200
    return _receipt(sub)


def _summary_query():
    return (
        select(Submission, Form.form_id, FormVersion.version)
        .join(FormVersion, Submission.form_version_id == FormVersion.id)
        .join(Form, FormVersion.form_id == Form.id)
    )


def _summary(s: Submission, form_id: str, version: str) -> SubmissionSummary:
    return SubmissionSummary(
        uuid=s.uuid, form_id=form_id, version=version, status=s.status, submitted_by=s.submitted_by,
        received_at=s.received_at, failure_count=len(s.failures_json or []),
    )


@router.get("/submissions", response_model=SubmissionPage)
def list_submissions(
    form_id: str | None = Query(default=None, max_length=150),
    status: _STATUSES | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    user: User = Depends(_anyone),
    db: Session = Depends(get_session),
) -> SubmissionPage:
    q = _summary_query()
    if user.role == "enumerator":  # an enumerator never sees another's submissions
        q = q.where(Submission.submitted_by == user.id)
    if form_id is not None:
        q = q.where(Form.form_id == form_id)
    if status is not None:
        q = q.where(Submission.status == status)
    total = db.scalar(select(func.count()).select_from(q.order_by(None).subquery()))
    rows = db.execute(
        q.order_by(Submission.received_at.desc(), Submission.id.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    ).all()
    return SubmissionPage(items=[_summary(*r) for r in rows], total=total, page=page, page_size=page_size)


@router.get("/submissions/{uuid}", response_model=SubmissionDetail)
def get_submission(
    uuid: str = PathParam(max_length=64),
    user: User = Depends(_anyone),
    db: Session = Depends(get_session),
) -> SubmissionDetail:
    not_found = HTTPException(status_code=404, detail="Submission not found")
    try:
        uid = str(uuidlib.UUID(uuid))
    except ValueError:
        raise not_found from None
    row = db.execute(_summary_query().where(Submission.uuid == uid)).first()
    # Someone else's submission is "not found", not "forbidden": its existence is not revealed.
    if row is None or (user.role == "enumerator" and row[0].submitted_by != user.id):
        raise not_found
    s = row[0]
    repeats: dict[str, list[dict]] = {}
    for r in db.scalars(
        select(RepeatRow).where(RepeatRow.submission_id == s.id).order_by(RepeatRow.repeat_name, RepeatRow.row_index)
    ):
        repeats.setdefault(r.repeat_name, []).append(r.data_json)
    media = db.scalars(select(MediaFile).where(MediaFile.submission_id == s.id).order_by(MediaFile.question_name))
    return SubmissionDetail(
        **_summary(*row).model_dump(),
        data=s.data_json,
        repeats=repeats,
        failures=[FailureOut(**f) for f in (s.failures_json or [])],
        media=[
            MediaOut(question_name=m.question_name, content_type=m.content_type, size=m.size, sha256=m.sha256)
            for m in media
        ],
        device_id=s.device_id,
        started_at=s.started_at,
        finished_at=s.finished_at,
        gps_lat=s.gps_lat,
        gps_lon=s.gps_lon,
        gps_accuracy=s.gps_accuracy,
        likely_duplicates=[d.uuid for d in likely_duplicates(db, s)] if user.role in _staff else [],
    )

