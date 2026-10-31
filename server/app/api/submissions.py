"""Submission intake: the one place field data enters the system.

TWO RULES GOVERN THIS MODULE
    1. A submission that reaches the server is never lost. One that fails validation is
       stored with status "flagged" and its failures recorded; it is not rejected and
       not corrected. The only things refused outright are ones that are unsafe to store
       (too big, not an image, an unknown media slot, a malformed id) or that the caller
       may not make (not assigned) - and a refusal leaves NOTHING behind: no row, no file.
    2. The same submission arriving twice is one submission. The client-generated UUID is
       the idempotency key and the database's unique constraint is what enforces it; the
       lookup before the insert is only a fast path. A replay returns the original receipt.

`store_submission()` carries every intake rule, so the OpenRosa endpoint (Task 12) and
this JSON endpoint share one idempotency rule and one validation path by construction.
The routes only translate HTTP to and from it.

ORDER (the tests pin it): uuid shape -> assignment -> replay lookup -> published ->
size -> media slot and magic bytes -> validation -> ONE transaction that writes the
submission, its repeat rows and its media rows, then the encrypted files, then commits.
Everything before the transaction can only refuse, and so leaves nothing. The submission
row is flushed FIRST inside the transaction: if two retries race, the loser fails on the
unique constraint before it has written a single file, so it can never delete or
overwrite the winner's. Any failure after that rolls back the rows and removes the files.

MULTIPART REQUEST for POST /api/submissions
    part "submission"   JSON text (or a file part holding JSON), <= 1 MiB: a SubmissionIn
    part "<question>"   one file per upload question (image/audio/video/file) of the form; the PART NAME is the
                        question name, the client's file name is ignored. <= 20 parts.
Responses: 201 on first receipt, 200 on a replay, both the same Receipt body.
"""

import hashlib
import math
import shutil
import uuid as uuidlib
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
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
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import audit
from app.core.config import get_settings
from app.core.crypto import encrypt_bytes
from app.core.rbac import require_role
from app.db.models import Assignment, Form, FormVersion, MediaFile, RepeatRow, Submission, User
from app.db.session import get_session
from app.forms.validate import Failure, validate_submission

router = APIRouter(prefix="/api", tags=["submissions"])

MAX_MEDIA_PARTS = 20
MAX_SUBMISSION_JSON_BYTES = 1024 * 1024
_STATUSES = Literal["received", "flagged", "approved", "rejected"]
_anyone = require_role("admin", "supervisor", "enumerator")
_staff = frozenset({"admin", "supervisor"})


class IntakeRefused(Exception):
    """A submission that must not be stored. Raised before anything is written."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class MediaPart:
    """An uploaded file. `filename` is informational only and never used for storage."""

    filename: str
    data: bytes


@dataclass(frozen=True)
class SubmissionMeta:
    """Device-reported extras. Stored as-is, never trusted for ordering or expiry."""

    device_id: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    gps_lat: float | None = None
    gps_lon: float | None = None
    gps_accuracy: float | None = None


# ---- request / response models ----------------------------------------------------


def _lenient_dt(v: Any) -> datetime | None:
    """A device clock or timezone setting can be wrong; that must never cost the visit."""
    if isinstance(v, str):
        try:
            v = datetime.fromisoformat(v.strip())
        except ValueError:
            return None
    if not isinstance(v, datetime):
        return None
    try:
        if not 1970 <= v.astimezone(UTC).year <= 2200:
            return None
    except (OverflowError, ValueError, OSError):
        return None
    return v


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
    started_at: Annotated[datetime | None, BeforeValidator(_lenient_dt)] = None
    finished_at: Annotated[datetime | None, BeforeValidator(_lenient_dt)] = None
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


# ---- intake -------------------------------------------------------------------------


def _canonical_uuid(raw: str) -> str:
    """The client's id as a lower-case canonical UUID: the only form that reaches a path."""
    try:
        return str(uuidlib.UUID(raw.strip()))
    except (ValueError, AttributeError):
        raise IntakeRefused(422, "uuid must be a UUID") from None


def _existing(db: Session, uid: str) -> Submission | None:
    return db.scalar(select(Submission).where(Submission.uuid == uid))


def _replay(existing: Submission, user: User) -> tuple[Submission, bool]:
    if existing.submitted_by != user.id:  # reveal nothing about someone else's submission
        raise IntakeRefused(409, "This submission id is already in use")
    return existing, False


# What each media question type accepts, decided by the BYTES (the client's file name and
# content type are ignored). A file whose bytes do not match its question's type is refused.
_IMAGE = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}


def _sniff_image(d: bytes) -> str | None:
    if d[:3] == b"\xff\xd8\xff":
        return "jpg"
    if d[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if d[:4] == b"RIFF" and d[8:12] == b"WEBP":
        return "webp"
    return None


def _sniff_container(d: bytes, kind: str) -> str | None:
    """Recorded audio/video: webm (EBML), mp4/m4a/3gp (ftyp), plus audio-only ogg/mp3/wav."""
    if d[:4] == b"\x1a\x45\xdf\xa3":  # Matroska/WebM, e.g. webm+opus from a browser
        return "webm"
    if d[4:8] == b"ftyp":  # ISO base media: what Android and iOS recorders produce
        return "m4a" if kind == "audio" else "mp4"
    if kind != "audio":
        return None
    if d[:4] == b"OggS":
        return "ogg"
    if d[:3] == b"ID3" or (len(d) > 1 and d[0] == 0xFF and d[1] & 0xE0 == 0xE0):  # mp3 / ADTS aac
        return "mp3"
    if d[:4] == b"RIFF" and d[8:12] == b"WAVE":
        return "wav"
    return None


_TYPES = {
    "webm": {"audio": "audio/webm", "video": "video/webm"},
    "mp4": {"video": "video/mp4"},
    "m4a": {"audio": "audio/mp4"},
    "ogg": {"audio": "audio/ogg"},
    "mp3": {"audio": "audio/mpeg"},
    "wav": {"audio": "audio/wav"},
}
# Phase 1 allow-list for a generic `file` question: images, PDF, and zip-based documents
# (xlsx/docx/zip). Nothing else, and never anything a server might execute.
_FILE_OTHER = {"pdf": "application/pdf", "zip": "application/zip"}


def _sniff(data: bytes, kind: str) -> tuple[str, str] | None:
    """(extension, content type) for `data` as a question of type `kind`, or None."""
    if kind == "image" or kind == "file":
        ext = _sniff_image(data)
        if ext:
            return ext, _IMAGE[ext]
    if kind in ("audio", "video"):
        ext = _sniff_container(data, kind)
        return (ext, _TYPES[ext][kind]) if ext else None
    if kind == "file":
        if data[:5] == b"%PDF-":
            return "pdf", _FILE_OTHER["pdf"]
        if data[:4] == b"PK\x03\x04":
            return "zip", _FILE_OTHER["zip"]
    return None


def _walk(nodes: list[dict]):
    for n in nodes:
        yield n
        yield from _walk(n.get("children", []))


def _media_questions(spec: dict) -> dict[str, str]:
    """Question name -> its type, for every question that takes an upload."""
    return {n["name"]: n["type"] for n in _walk(spec["nodes"]) if n["type"] in ("image", "audio", "video", "file")}


def _repeat_names(spec: dict) -> set[str]:
    return {n["name"] for n in _walk(spec["nodes"]) if n["type"] == "repeat"}


def _normalise(value: Any) -> Any:
    """A select_multiple list becomes the canonical space-separated string, at any depth."""
    if isinstance(value, dict):
        return {k: _normalise(v) for k, v in value.items()}
    if isinstance(value, list):
        if all(isinstance(i, str) for i in value):
            return " ".join(value)
        return [_normalise(i) for i in value]
    return value


def _validate(spec: dict, data: dict, repeats: dict) -> list[Failure]:
    try:
        failures = validate_submission(spec, data, repeats, datetime.now(UTC))
    except Exception:  # noqa: BLE001 - a crash here must not lose the visit
        failures = [Failure("", "error", "Server-side validation could not run for this submission")]
    known = _repeat_names(spec)
    failures += [
        Failure(name, "error", "Not a repeat in this version of the form")
        for name in repeats
        if name not in known
    ]
    return failures


def store_submission(
    db: Session,
    form_version: FormVersion,
    user: User,
    data: dict,
    repeats: dict[str, list[dict]],
    media: dict[str, MediaPart],
    uuid: str,
    request: Request,
    *,
    meta: SubmissionMeta | None = None,
) -> tuple[Submission, bool]:
    """Apply every intake rule and store the submission. Returns (submission, created).

    Raises IntakeRefused (status_code, detail) for anything that must not be stored; in
    that case nothing has been written. `created` is False for a replay of a uuid this
    user already submitted. `media` maps question name -> file. `meta` carries the
    device-reported extras (device id, device clock, gps).
    """
    settings = get_settings()
    uid = _canonical_uuid(uuid)
    meta = meta or SubmissionMeta()

    if not user.is_active:
        raise IntakeRefused(403, "Forbidden")
    if user.role == "enumerator" and db.scalar(
        select(Assignment.id).where(
            Assignment.user_id == user.id, Assignment.form_id == form_version.form_id
        )
    ) is None:
        raise IntakeRefused(403, "Forbidden")

    existing = _existing(db, uid)  # fast path only; the unique constraint is the real guard
    if existing is not None:
        return _replay(existing, user)
    if form_version.published_at is None:
        raise IntakeRefused(404, "Form or version not found")

    for part in media.values():
        if len(part.data) > settings.max_media_bytes:
            raise IntakeRefused(413, "A file is larger than the media size limit")
    slots = _media_questions(form_version.json_spec)
    sniffed: dict[str, tuple[str, str]] = {}
    for name, part in media.items():
        if name not in slots:
            raise IntakeRefused(422, "A file was sent for a question that takes no upload")
        kind = _sniff(part.data, slots[name])
        if kind is None:
            raise IntakeRefused(415, f"A file's contents are not an accepted {slots[name]} format")
        sniffed[name] = kind

    spec = form_version.json_spec
    data = _normalise(data)
    repeats = {name: [_normalise(r) for r in rows] for name, rows in repeats.items()}
    failures = _validate(spec, data, repeats)

    folder = Path(settings.media_root) / uid
    wrote_files = False
    try:
        sub = Submission(
            uuid=uid,
            form_version_id=form_version.id,
            submitted_by=user.id,
            received_at=datetime.now(UTC),  # the server's clock, never the device's
            device_id=meta.device_id,
            started_at=meta.started_at,
            finished_at=meta.finished_at,
            status="flagged" if failures else "received",
            data_json=data,
            failures_json=[
                {"question": f.question, "rule": f.rule, "message": f.message} for f in failures
            ]
            or None,
            gps_lat=meta.gps_lat,
            gps_lon=meta.gps_lon,
            gps_accuracy=meta.gps_accuracy,
        )
        db.add(sub)
        try:
            db.flush()  # the idempotency decision, before any file exists
        except IntegrityError:
            db.rollback()
            winner = _existing(db, uid)
            if winner is None:
                raise
            return _replay(winner, user)
        for name, rows in repeats.items():
            for i, row in enumerate(rows, start=1):  # 1-based, as in the failure paths
                db.add(RepeatRow(submission_id=sub.id, repeat_name=name, row_index=i, data_json=row))
        for name in sorted(media):
            ext, content_type = sniffed[name]
            db.add(
                MediaFile(
                    submission_id=sub.id,
                    question_name=name,
                    filename=f"{name}.{ext}",
                    content_type=content_type,
                    size=len(media[name].data),
                    storage_path=f"{uid}/{name}.{ext}",
                    sha256=hashlib.sha256(media[name].data).hexdigest(),
                )
            )
        db.flush()
        if media:
            wrote_files = True  # we own this uuid now: the flush above won it
            folder.mkdir(parents=True, exist_ok=True)
            for name in sorted(media):
                (folder / f"{name}.{sniffed[name][0]}").write_bytes(encrypt_bytes(media[name].data))
        audit.record(
            db, user.id, "submission.create", "submission", uid, request,
            {"status": sub.status, "failures": len(failures), "media": len(media)},
        )
        db.commit()
    except BaseException:
        db.rollback()
        if wrote_files:
            shutil.rmtree(folder, ignore_errors=True)
        raise
    return sub, True


# ---- duplicates -----------------------------------------------------------------------

_NOT_ANSWERS = frozenset({"calculate", "note", "geopoint", "image", "audio", "video", "file"})


def _canon(v: Any, drop: frozenset[str] = frozenset()) -> Any:
    """Comparable form of an answer: trimmed, case-folded, blanks removed."""
    if isinstance(v, dict):
        items = {k: c for k, x in v.items() if k not in drop and (c := _canon(x, drop)) is not None}
        return tuple(sorted(items.items())) or None
    if isinstance(v, list):
        return tuple(c for x in v if (c := _canon(x, drop)) is not None) or None
    if v is None:
        return None
    if isinstance(v, str):
        return " ".join(v.split()).casefold() or None
    return str(v)


def likely_duplicates(db: Session, submission: Submission) -> list[Submission]:
    """Other submissions of the same form that look like the same visit. Reports only.

    The key is per form: `settings.duplicate_keys[form_id]`, a list of top-level question
    names (env DUPLICATE_KEYS as JSON). With none configured, the default is every
    top-level answer (not calculates, notes, gps or media) PLUS all repeat rows, so two
    households visited by the same ASHA are not mistaken for one. Text is compared
    trimmed and case-folded; blank answers are ignored; a key with no answered value
    matches nothing. Nothing is ever deleted or changed.

    TWO MODES. Default (no configured key): catches EXACT RE-ENTRY only - the same filled
    form arriving under two UUIDs (finalise tapped twice, an app bug). geopoint and media
    differ on every submission, so they are excluded from the key; device metadata is not
    in the answers at all. Near-duplicates (the same household entered twice with slightly
    different answers) are caught only by a CONFIGURED key naming the identifying
    questions. Per-form configuration belongs on the form record (Phase 2).

    Scans the form's submissions in Python (O(n) in the form's size): fine for the
    single-submission detail view that calls it. NEVER call it per row from a list
    endpoint.
    """
    fv = db.get(FormVersion, submission.form_version_id)
    form = db.get(Form, fv.form_id)
    spec = fv.json_spec
    configured = get_settings().duplicate_keys.get(form.form_id)
    skip = frozenset(n["name"] for n in _walk(spec["nodes"]) if n["type"] in _NOT_ANSWERS)
    names = configured or [
        n["name"]
        for n in _top_level(spec["nodes"])
        if n["type"] not in _NOT_ANSWERS | {"repeat", "group"}
    ]

    def top_key(data: dict) -> tuple:
        return tuple(_canon(data.get(n)) for n in names)

    def repeat_key(sub_id: int, rows: dict[int, list]) -> Any:
        return None if configured else _canon(rows.get(sub_id, []), skip)

    def rows_of(ids: list[int]) -> dict[int, list]:
        out: dict[int, list] = {i: [] for i in ids}
        q = select(RepeatRow).where(RepeatRow.submission_id.in_(ids)).order_by(
            RepeatRow.repeat_name, RepeatRow.row_index
        )
        for r in db.scalars(q):
            out[r.submission_id].append({r.repeat_name: r.data_json})
        return out

    mine = top_key(submission.data_json)
    if all(v is None for v in mine):
        return []
    candidates = db.execute(
        select(Submission.id, Submission.data_json)
        .join(FormVersion, Submission.form_version_id == FormVersion.id)
        .where(FormVersion.form_id == fv.form_id, Submission.id != submission.id)
    ).all()
    ids = [i for i, d in candidates if top_key(d) == mine]
    if not ids:
        return []
    if not configured:
        rows = rows_of([submission.id, *ids])
        want = repeat_key(submission.id, rows)
        ids = [i for i in ids if repeat_key(i, rows) == want]
    return list(
        db.scalars(select(Submission).where(Submission.id.in_(ids)).order_by(Submission.received_at, Submission.id))
    )


def _top_level(nodes: list[dict]):
    """Questions outside any repeat (groups are flat in the data)."""
    for n in nodes:
        if n["type"] == "repeat":
            continue
        if n["type"] == "group":
            yield from _top_level(n.get("children", []))
        else:
            yield n


# ---- routes -----------------------------------------------------------------------------


def _refuse(e: IntakeRefused) -> HTTPException:
    return HTTPException(status_code=e.status_code, detail=e.detail)


async def _read_part(part: UploadFile, limit: int) -> bytes:
    return await part.read(limit + 1)  # one byte over the cap is enough to know it is over


def _intake(db: Session, user: User, body: SubmissionIn, media: dict[str, MediaPart], request: Request):
    form = db.scalar(select(Form).where(Form.form_id == body.form_id))
    if user.role == "enumerator" and (
        form is None
        or db.scalar(select(Assignment.id).where(Assignment.user_id == user.id, Assignment.form_id == form.id))
        is None
    ):
        raise _refuse(IntakeRefused(403, "Forbidden"))  # unknown and unassigned look the same
    fv = (
        db.scalar(select(FormVersion).where(FormVersion.form_id == form.id, FormVersion.version == body.version))
        if form is not None
        else None
    )
    if fv is None:
        raise _refuse(IntakeRefused(404, "Form or version not found"))
    meta = SubmissionMeta(
        device_id=body.device_id,
        started_at=body.started_at,
        finished_at=body.finished_at,
        gps_lat=body.gps_lat,
        gps_lon=body.gps_lon,
        gps_accuracy=body.gps_accuracy,
    )
    try:
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
