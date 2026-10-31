"""Form upload, publish, versioning and pre-loaded datasets.

Conversion and compilation live in app.forms; this module only wires them to HTTP.

Upload is all-or-nothing: the XLSForm is converted and compiled *before* any row is
added, and the Form/FormVersion/audit rows are then written in a single commit, so a
rejected upload leaves nothing behind. Form versions are immutable: publishing only
moves the `is_current` flag, and every older version stays servable so a device that
started a draft on it can finish.
"""

import csv
import io
import re
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, File, HTTPException, Path, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import and_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from app.core import audit
from app.core.access import granted_to, has_form_grant
from app.core.config import Settings, get_settings
from app.core.rbac import current_user, require_role
from app.db.models import Dataset, Form, FormVersion, User
from app.db.session import get_session
from app.forms.autometa import inject_auto_metadata
from app.forms.compile import FormCompileError, compile_spec
from app.forms.expr import UnsupportedExpression
from app.forms.xlsform import XLSFormError, to_xform

router = APIRouter(prefix="/api", tags=["forms"])

MAX_UPLOAD_BYTES = 5 * 1024 * 1024
_ZIP_MAGIC = b"PK\x03\x04"  # an .xlsx is a zip
_DATASET_NAME = r"^[A-Za-z0-9_-]{1,150}$"
_MAX_VERSIONS_PER_DAY = 99

_manager = require_role("admin", "supervisor")


class UploadResult(BaseModel):
    form_id: str
    version: str
    warnings: list[str]


class PublishRequest(BaseModel):
    version: str = Field(pattern=r"^\d{10}$")


class PublishResult(BaseModel):
    form_id: str
    version: str
    is_current: bool


class FormSummary(BaseModel):
    form_id: str
    title: str
    current_version: str | None


class DatasetSummary(BaseModel):
    name: str
    version: int


class DatasetOut(BaseModel):
    name: str
    version: int
    rows: list[dict[str, str]]


def _read_capped(file: UploadFile) -> bytes:
    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File is larger than the 5 MB limit")
    return data


def _next_version(db: Session, form: Form | None, today: str) -> str:
    last = 0
    if form is not None and form.id is not None:
        existing = db.scalars(
            select(FormVersion.version).where(
                FormVersion.form_id == form.id, FormVersion.version.like(f"{today}%")
            )
        ).all()
        last = max((int(v[8:]) for v in existing), default=0)
    if last >= _MAX_VERSIONS_PER_DAY:
        raise HTTPException(status_code=409, detail="Too many versions uploaded today")
    return f"{today}{last + 1:02d}"


def _title_of(spec: dict, fallback: str) -> str:
    titles = [t for t in spec.get("title", {}).values() if t]
    return (titles[0] if titles else fallback)[:255]


@router.post("/forms", response_model=UploadResult, status_code=201)
def upload_form(
    request: Request,
    file: UploadFile = File(...),
    user: User = Depends(_manager),
    db: Session = Depends(get_session),
) -> UploadResult:
    data = _read_capped(file)
    if not data.startswith(_ZIP_MAGIC):  # the file's bytes, not the client's claim
        raise HTTPException(status_code=415, detail="Not an .xlsx spreadsheet")

    # Everything that can fail on bad input runs before the first database write.
    try:
        xform_xml = to_xform(data)
        spec = inject_auto_metadata(compile_spec(xform_xml))
    except XLSFormError as e:
        raise HTTPException(
            status_code=422, detail={"error": "invalid_xlsform", "messages": e.messages}
        ) from None
    except UnsupportedExpression as e:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "unsupported_expression",
                "question": getattr(e, "question", None),
                "message": str(e),
            },
        ) from None
    except FormCompileError as e:
        raise HTTPException(
            status_code=422, detail={"error": "form_not_supported", "message": str(e)}
        ) from None

    form_key = spec.get("form_id", "")
    if not form_key or len(form_key) > 150:
        raise HTTPException(
            status_code=422,
            detail={"error": "invalid_xlsform", "messages": ["The form needs a form_id (settings sheet)."]},
        )

    today = datetime.now(UTC).strftime("%Y%m%d")
    for attempt in range(3):  # a concurrent upload can take our sequence number
        form = db.scalar(select(Form).where(Form.form_id == form_key))
        version = _next_version(db, form, today)
        spec["version"] = version
        if form is None:
            form = Form(form_id=form_key, title=_title_of(spec, form_key), created_by=user.id)
            db.add(form)
        else:
            form.title = _title_of(spec, form.title)
        db.add(
            FormVersion(
                form=form,
                version=version,
                xlsform_blob=data,
                xform_xml=xform_xml,
                json_spec=spec,
                published_by=user.id,
                is_current=False,
            )
        )
        try:
            db.flush()
            audit.record(db, user.id, "form.upload", "form", form_key, request, {"version": version})
            db.commit()
        except IntegrityError:
            db.rollback()
            if attempt == 2:
                raise HTTPException(status_code=409, detail="Upload conflicted, try again") from None
            continue
        except Exception:
            db.rollback()
            raise
        return UploadResult(form_id=form_key, version=version, warnings=[])
    raise AssertionError("unreachable")  # pragma: no cover


@router.post("/forms/{form_id}/publish", response_model=PublishResult)
def publish_form(
    form_id: str,
    body: PublishRequest,
    request: Request,
    user: User = Depends(_manager),
    db: Session = Depends(get_session),
) -> PublishResult:
    form = db.scalar(select(Form).where(Form.form_id == form_id))
    # Looked up under this form, so a version of another form can never be published here.
    version = (
        db.scalar(
            select(FormVersion).where(
                FormVersion.form_id == form.id, FormVersion.version == body.version
            )
        )
        if form is not None
        else None
    )
    if form is None or version is None:
        raise HTTPException(status_code=404, detail="Form or version not found")
    try:
        form.publish(version)
        version.published_by = user.id
        audit.record(db, user.id, "form.publish", "form", form.form_id, request, {"version": version.version})
        db.commit()
    except Exception:
        db.rollback()
        raise
    return PublishResult(form_id=form.form_id, version=version.version, is_current=True)


@router.get("/forms", response_model=list[FormSummary])
def list_forms(
    user: User = Depends(current_user), db: Session = Depends(get_session)
) -> list[FormSummary]:
    # One query, scalar columns only: devices poll this on every reconnect, so it must
    # never load a version's blob or spec.
    cur = aliased(FormVersion)
    published = (
        select(FormVersion.id)
        .where(FormVersion.form_id == Form.id, FormVersion.published_at.is_not(None))
        .exists()
    )
    query = (
        select(Form.form_id, Form.title, cur.version)
        .outerjoin(cur, and_(cur.form_id == Form.id, cur.is_current.is_(True)))
        .where(published)
        .order_by(Form.id)
    )
    if user.role == "enumerator":  # never learns that other forms exist
        query = query.where(granted_to(user.id))
    return [
        FormSummary(form_id=fid, title=title, current_version=ver)
        for fid, title, ver in db.execute(query).all()
    ]


@router.get("/forms/{form_id}/versions/{version}/spec")
def get_spec(
    form_id: str,
    version: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_session),
) -> dict:
    not_found = HTTPException(status_code=404, detail="Form or version not found")
    form = db.scalar(select(Form).where(Form.form_id == form_id))
    if form is None:
        raise not_found
    row = db.scalar(
        select(FormVersion).where(FormVersion.form_id == form.id, FormVersion.version == version)
    )
    if row is None or row.published_at is None:  # never served before it is published
        raise not_found
    if user.role == "enumerator":
        if not has_form_grant(db, user.id, form.id):
            raise not_found
    return row.json_spec


def _parse_csv(data: bytes) -> list[dict[str, str]]:
    if not data or data.startswith(_ZIP_MAGIC) or b"\x00" in data:
        raise ValueError("Not a CSV text file")
    try:
        text = data.decode("utf-8-sig")  # explicit: the platform default cannot hold Devanagari
    except UnicodeDecodeError:
        raise ValueError("The CSV must be saved as UTF-8") from None
    reader = csv.DictReader(io.StringIO(text, newline=""))
    header = reader.fieldnames
    if not header or any(not h.strip() for h in header) or len(set(header)) != len(header):
        raise ValueError("The first row must be unique, non-empty column names")
    rows = []
    for n, row in enumerate(reader, start=2):
        if None in row or None in row.values():
            raise ValueError(f"Row {n} does not have {len(header)} columns")
        rows.append(row)
    return rows


@router.post("/datasets/{name}", response_model=DatasetOut)
def upload_dataset(
    request: Request,
    name: str = Path(pattern=_DATASET_NAME),
    file: UploadFile = File(...),
    user: User = Depends(_manager),
    db: Session = Depends(get_session),
) -> DatasetOut:
    data = _read_capped(file)
    try:
        rows = _parse_csv(data)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    try:
        ds = db.scalar(select(Dataset).where(Dataset.name == name))
        if ds is None:
            ds = Dataset(name=name, csv_blob=data, version=1)
            db.add(ds)
        else:
            ds.csv_blob = data
            ds.version += 1
        db.flush()
        audit.record(db, user.id, "dataset.upload", "dataset", name, request, {"version": ds.version, "rows": len(rows)})
        db.commit()
    except Exception:
        db.rollback()
        raise
    return DatasetOut(name=name, version=ds.version, rows=rows)


class ClientConfig(BaseModel):
    max_media_bytes: int


@router.get("/config", response_model=ClientConfig)
def client_config(
    user: User = Depends(current_user),
    settings: Settings = Depends(get_settings),
) -> ClientConfig:
    """Only settings a client genuinely needs; never secrets, paths or Drive config."""
    return ClientConfig(max_media_bytes=settings.max_media_bytes)


@router.get("/datasets", response_model=list[DatasetSummary])
def list_datasets(
    user: User = Depends(current_user),  # same as GET /datasets/{name}: any signed-in user
    db: Session = Depends(get_session),
) -> list[DatasetSummary]:
    """Names and versions only; the rows are fetched per name."""
    rows = db.execute(select(Dataset.name, Dataset.version).order_by(Dataset.name)).all()
    return [DatasetSummary(name=n, version=v) for n, v in rows]


@router.get("/datasets/{name}", response_model=DatasetOut)
def get_dataset(
    name: str = Path(pattern=_DATASET_NAME),
    user: User = Depends(current_user),
    db: Session = Depends(get_session),
) -> DatasetOut:
    ds = db.scalar(select(Dataset).where(Dataset.name == name))
    if ds is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return DatasetOut(name=ds.name, version=ds.version, rows=_parse_csv(ds.csv_blob))
