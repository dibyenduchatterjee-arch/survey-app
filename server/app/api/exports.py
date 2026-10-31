"""Export jobs: build the CSVs (and the media zip), put them in Drive, refresh the Sheet.

POST /api/exports {form_id}          -> 202 {job_id}; the work runs in a FastAPI BackgroundTask
GET  /api/exports/{job_id}           -> the job: status, drive_file_id, sheet_id, row_count, error
GET  /api/exports/{job_id}/download  -> the main CSV itself, streamed once the job is done

Supervisor and admin only. A job's status moves pending -> running -> done | failed, and a failed
job keeps its error text and is never deleted: the person who asked needs to see why.

The Google clients arrive through dependencies (`get_drive_uploader`, `get_sheet_writer`) and the
background task opens its own session through `get_job_session`, so tests substitute all three and
nothing reaches Google. Missing Google settings are a 503 at request time that names the setting.

DOWNLOAD IS GATED BY US, NOT BY DRIVE. The route fetches the file from Drive with the service
account and streams the bytes to the authenticated caller, so a login plus our role check is the
only way in. The Drive id and url stay in the job status as information, never as the access path:
a Drive link would depend on Drive sharing, which this app does not control.

DOWNLOAD IS GATED BY US, NOT BY DRIVE. The route fetches the file from Drive with the service
account and streams the bytes to the authenticated caller, so a login plus our role check is the
only way in. The Drive id and url stay in the job status as information, never as the access path:
a Drive link would depend on Drive sharing, which this app does not control.

The CSV files are uploaded exactly as `build_csvs` produced them (UTF-8 with BOM); only the Sheet
rows are decoded from them.
"""

import csv
import io
import logging
import re
import zipfile
from collections.abc import Callable
from contextlib import AbstractContextManager
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, Response
from pydantic import BaseModel, ConfigDict, StringConstraints
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import audit
from app.core.access import staff_can_see_form
from app.core.access import staff_can_see_form
from app.core.config import Settings, get_settings
from app.core.rbac import require_role
from app.db.models import ExportJob, Form, FormVersion, Submission, User
from app.db.session import SessionLocal, get_session
from app.export.csv_export import build_csvs
from app.export.drive import DriveUploader, ExportConfigError, GoogleError, build_google_client, redact
from app.export.media import build_media_zip
from app.export.sheets import SheetWriter

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["exports"])
_staff = require_role("admin", "supervisor")

SessionFactory = Callable[[], AbstractContextManager[Session]]


# ---- dependencies (overridden in tests) --------------------------------------------------


def _unavailable(e: ExportConfigError) -> HTTPException:
    return HTTPException(status_code=503, detail=str(e))


def get_drive_uploader() -> DriveUploader:
    try:
        return DriveUploader(build_google_client(get_settings(), "drive"))
    except ExportConfigError as e:
        raise _unavailable(e) from None


def get_sheet_writer() -> SheetWriter | None:
    """None when no Sheet is configured: the export then goes to Drive only."""
    settings = get_settings()
    if not settings.google_sheet_id:
        return None
    try:
        return SheetWriter(build_google_client(settings, "sheets"))
    except ExportConfigError as e:
        raise _unavailable(e) from None


def get_job_session() -> SessionFactory:
    return SessionLocal


# ---- models ------------------------------------------------------------------------------


class ExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    form_id: Annotated[str, StringConstraints(min_length=1, max_length=150)]


class JobStarted(BaseModel):
    job_id: int


class JobOut(BaseModel):
    job_id: int
    form_id: str
    status: str
    requested_at: datetime
    drive_file_id: str | None
    drive_url: str | None  # information only; access is through /download
    sheet_id: str | None
    row_count: int | None
    error: str | None


def _job_out(job: ExportJob, form_id: str) -> JobOut:
    at = job.requested_at if job.requested_at.tzinfo else job.requested_at.replace(tzinfo=UTC)
    return JobOut(
        job_id=job.id,
        form_id=form_id,
        status=job.status,
        requested_at=at,
        drive_file_id=job.drive_file_id,
        drive_url=f"https://drive.google.com/file/d/{job.drive_file_id}/view" if job.drive_file_id else None,
        sheet_id=job.sheet_id,
        row_count=job.row_count,
        error=job.error,
    )


# ---- the job -----------------------------------------------------------------------------


def _stamped(name: str, form_id: str, stamp: str) -> str:
    """`<stem>_<stamp><ext>`; the error report, which has no form prefix, gets one."""
    stem, dot, ext = name.rpartition(".")
    if stem == "export_errors":
        stem = f"{form_id}_export_errors"
    return f"{stem}_{stamp}{dot}{ext}"


def _sheet_rows(main_csv: bytes) -> list[list[str]]:
    return list(csv.reader(io.StringIO(main_csv.decode("utf-8-sig"), newline="")))


def _error_text(e: BaseException) -> str:
    text = str(e) if isinstance(e, (GoogleError, ExportConfigError)) else f"{type(e).__name__}: {e}"
    return redact(text)[:2000]


def run_export(
    job_id: int,
    session_factory: SessionFactory,
    uploader: DriveUploader,
    sheets: SheetWriter | None,
    folder_id: str,
    sheet_id: str | None,
) -> None:
    """Background task. Never raises: every outcome is written onto the job row."""
    with session_factory() as db:
        job = db.get(ExportJob, job_id)
        if job is None:  # cannot happen: the row was committed before the task was queued
            return
        job.status = "running"
        db.commit()
        try:
            form = db.get(Form, job.form_id)
            version = db.scalars(
                select(FormVersion)
                .where(FormVersion.form_id == form.id)
                .order_by(FormVersion.is_current.desc(), FormVersion.id.desc())
            ).first()
            if version is None:
                raise GoogleError("This form has no uploaded version, so there is nothing to export")
            subs = list(
                db.scalars(
                    select(Submission)
                    .join(FormVersion, Submission.form_version_id == FormVersion.id)
                    .where(FormVersion.form_id == form.id)
                    .order_by(Submission.id)
                )
            )
            files = build_csvs(version.json_spec, subs)
            media_zip = build_media_zip(subs)
            stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")

            main_name = next(iter(files))  # build_csvs puts the main file first
            for name, data in files.items():
                mime = "text/plain" if name.endswith(".txt") else "text/csv"
                file_id = uploader.upload(folder_id, _stamped(name, form.form_id, stamp), data, mime)
                if name == main_name:
                    job.drive_file_id = file_id
                    db.commit()  # keep the id even if a later step fails
            if zipfile.ZipFile(io.BytesIO(media_zip)).namelist():
                uploader.upload(folder_id, f"{form.form_id}_media_{stamp}.zip", media_zip, "application/zip")

            if sheets is not None and sheet_id:
                sheets.replace(sheet_id, form.form_id, _sheet_rows(files[main_name]))
                job.sheet_id = sheet_id
            job.row_count = len(subs)
            job.status = "done"
            job.error = None
            db.commit()
        except Exception as e:  # noqa: BLE001 - whatever went wrong must land on the job
            db.rollback()
            job = db.get(ExportJob, job_id)
            job.status = "failed"
            job.error = _error_text(e)
            db.commit()
            log.warning("export job %s failed: %s", job_id, job.error)


# ---- routes ------------------------------------------------------------------------------


@router.post("/exports", response_model=JobStarted, status_code=202)
def start_export(
    body: ExportRequest,
    request: Request,
    background: BackgroundTasks,
    user: User = Depends(_staff),
    uploader: DriveUploader = Depends(get_drive_uploader),
    sheets: SheetWriter | None = Depends(get_sheet_writer),
    session_factory: SessionFactory = Depends(get_job_session),
    db: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> JobStarted:
    if not settings.drive_folder_id:
        raise HTTPException(status_code=503, detail="DRIVE_FOLDER_ID is not set: exports need a Drive folder")
    form = db.scalars(select(Form).where(Form.form_id == body.form_id)).first()
    if form is None:
        raise HTTPException(status_code=404, detail="Form not found")
    job = ExportJob(form_id=form.id, requested_by=user.id, status="pending")
    db.add(job)
    db.flush()
    audit.record(db, user.id, "export.start", "export_job", job.id, request, {"form_id": form.form_id})
    db.commit()
    background.add_task(
        run_export, job.id, session_factory, uploader, sheets, settings.drive_folder_id, settings.google_sheet_id
    )
    return JobStarted(job_id=job.id)


def _load(db: Session, job_id: int) -> tuple[ExportJob, str]:
    row = db.execute(
        select(ExportJob, Form.form_id).join(Form, ExportJob.form_id == Form.id).where(ExportJob.id == job_id)
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Export job not found")
    return row[0], row[1]


@router.get("/exports/{job_id}", response_model=JobOut)
def get_export(job_id: int, _: User = Depends(_staff), db: Session = Depends(get_session)) -> JobOut:
    job, form_id = _load(db, job_id)
    return _job_out(job, form_id)


@router.get("/exports/{job_id}/download")
def download_export(
    job_id: int,
    user: User = Depends(_staff),
    uploader: DriveUploader = Depends(get_drive_uploader),
    db: Session = Depends(get_session),
) -> Response:
    """Stream the main CSV, byte for byte (the BOM is what makes Devanagari open in Excel)."""
    job, form_key = _load(db, job_id)
    if not staff_can_see_form(db, user, job.form_id):
        raise HTTPException(status_code=404, detail="Export job not found")
    if job.status != "done" or not job.drive_file_id:
        detail = job.error if job.status == "failed" and job.error else f"Export is {job.status}, not done"
        raise HTTPException(status_code=409, detail=detail)
    try:
        data = uploader.download(job.drive_file_id)
    except GoogleError as e:
        raise HTTPException(status_code=502, detail=_error_text(e)) from None
    stamp = job.requested_at.strftime("%Y%m%dT%H%M%SZ")
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", form_key)  # a header value, never raw text
    return Response(
        content=data,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{safe}_{stamp}.csv"'},
    )
