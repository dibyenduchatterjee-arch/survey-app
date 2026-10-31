"""Export jobs: build the CSVs (and the media zip), put them in Drive, refresh the Sheet.

POST /api/exports {form_id | project_id, date_from?, date_to?}
                                     -> 202 {job_id}; the work runs in a FastAPI BackgroundTask
GET  /api/exports/{job_id}           -> the job: status, drive_file_id, sheet_id, row_count, error
GET  /api/exports/{job_id}/download  -> the main CSV (one form) or a zip of every form's files (a
                                        project), streamed once the job is done

FILTERS. `form_id` (one form) and `project_id` (every form in the project) are alternatives; both,
or neither, is a 422. `date_from` / `date_to` are ISO days (YYYY-MM-DD), both inclusive, and filter
on `Submission.received_at`, the server's own clock, never the device's. A day is an INDIA day (the
`form_timezone` setting, Asia/Kolkata): the person asking means Indian dates, and an ASHA's 04:00
visit on 1 November is 22:30 UTC on 31 October. The CSV carries that same day in its
`received_date_ist` column (and `received_at_ist`, plus `received_at_utc`), so the file can be
checked against the range.
Who may export what is decided only by `app.core.access` (`staff_can_see_form` /
`staff_can_see_project`); a refusal is the same 404 as a form or project that does not exist.
A range that matches nothing is not an error: the job is done with row_count 0, the CSV has its
header row only, and the job says so in `message`.

A PROJECT EXPORT is `build_csvs` run once per form, each file named `<form_id>_..._<stamp>`, plus one
media zip for the whole project. The download is those same files in one zip, built on request
(whether or not Drive is configured); in Drive each file is uploaded on its own as for one form.

Supervisor and admin only. A job's status moves pending -> running -> done | failed, and a failed
job keeps its error text and is never deleted: the person who asked needs to see why.

The Google clients arrive through dependencies (`get_drive_uploader`, `get_sheet_writer`) and the
background task opens its own session through `get_job_session`, so tests substitute all three and
nothing reaches Google. Missing Google settings are a 503 at request time that names the setting.

DOWNLOAD IS GATED BY US, NOT BY DRIVE. The route fetches the file from Drive with the service
account and streams the bytes to the authenticated caller, so a login plus our role check is the
only way in. The Drive id and url stay in the job status as information, never as the access path:
a Drive link would depend on Drive sharing, which this app does not control.

BEFORE GOOGLE IS CONFIGURED the export still works. With neither GOOGLE_SERVICE_ACCOUNT_FILE nor
DRIVE_FOLDER_ID set, a job only validates and counts (status done, no Drive id) and the download
route builds the main CSV from the current data and serves it directly, under the same login and
role checks, with the same UTF-8 BOM. Setting just one of the two is a half-finished setup and is
still a loud 503 naming the missing setting. Nothing is written to disk: the CSV is built on
request, so a download holds the data as it is when you click, not when the job ran.

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
from datetime import UTC, date, datetime, time, timedelta
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import audit
from app.core.access import staff_can_see_form, staff_can_see_project
from app.core.config import Settings, get_settings
from app.core.rbac import require_role
from app.db.models import ExportJob, Form, FormVersion, Project, Submission, User
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


def get_drive_uploader() -> DriveUploader | None:
    """None when Drive is not configured at all: exports are then served by this server."""
    settings = get_settings()
    if not settings.google_service_account_file and not settings.drive_folder_id:
        return None
    try:
        return DriveUploader(build_google_client(settings, "drive"))
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

    form_id: Annotated[str, StringConstraints(min_length=1, max_length=150)] | None = None
    project_id: int | None = Field(default=None, strict=True)
    date_from: date | None = None
    date_to: date | None = None

    @field_validator("date_from", "date_to", mode="before")
    @classmethod
    def _iso_day(cls, v: object) -> object:
        """Only YYYY-MM-DD: not a timestamp, not a datetime, not DD/MM/YYYY (which is ambiguous)."""
        if v is not None and not (isinstance(v, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", v)):
            raise ValueError("must be a date written YYYY-MM-DD")
        return v

    @model_validator(mode="after")
    def _consistent(self) -> "ExportRequest":
        if self.form_id is not None and self.project_id is not None:
            raise ValueError(
                "Give form_id (one form) or project_id (every form in the project), not both: "
                "a project export already includes all of its forms"
            )
        if self.form_id is None and self.project_id is None:
            raise ValueError("Give form_id (one form) or project_id (every form in a project)")
        if self.date_from and self.date_to and self.date_to < self.date_from:
            raise ValueError("date_to is earlier than date_from: the range would be empty by mistake")
        return self


class JobStarted(BaseModel):
    job_id: int


class JobOut(BaseModel):
    job_id: int
    form_id: str | None  # one form, or null for a project export
    project_id: int | None
    project_name: str | None
    date_from: date | None
    date_to: date | None
    status: str
    requested_at: datetime
    drive_file_id: str | None
    drive_url: str | None  # information only; access is through /download
    sheet_id: str | None
    row_count: int | None
    message: str | None  # set when the job is done and matched nothing
    error: str | None


def _range_text(date_from: date | None, date_to: date | None) -> str:
    if date_from and date_to:
        return f"{date_from.isoformat()} to {date_to.isoformat()}"
    if date_from:
        return f"from {date_from.isoformat()}"
    if date_to:
        return f"up to {date_to.isoformat()}"
    return "all dates"


def _job_out(job: ExportJob, form_key: str | None, project_name: str | None) -> JobOut:
    at = job.requested_at if job.requested_at.tzinfo else job.requested_at.replace(tzinfo=UTC)
    message = None
    if job.status == "done" and job.row_count == 0:
        what = f"project {project_name}" if job.project_id is not None else f"form {form_key}"
        message = (
            f"No submissions matched ({what}, {_range_text(job.date_from, job.date_to)}). "
            "The CSV holds the column headings only."
        )
    return JobOut(
        job_id=job.id,
        form_id=form_key,
        project_id=job.project_id,
        project_name=project_name,
        date_from=job.date_from,
        date_to=job.date_to,
        status=job.status,
        requested_at=at,
        drive_file_id=job.drive_file_id,
        drive_url=f"https://drive.google.com/file/d/{job.drive_file_id}/view" if job.drive_file_id else None,
        sheet_id=job.sheet_id,
        row_count=job.row_count,
        message=message,
        error=job.error,
    )


# ---- the job -----------------------------------------------------------------------------


def _stamped(name: str, form_id: str, stamp: str) -> str:
    """`<stem>_<stamp><ext>`; the error report, which has no form prefix, gets one."""
    stem, dot, ext = name.rpartition(".")
    if stem == "export_errors":
        stem = f"{form_id}_export_errors"
    return f"{stem}_{stamp}{dot}{ext}"


def _safe_name(text: str, fallback: str) -> str:
    """A file or header name: ASCII letters, digits and _.- only (a Devanagari name falls back)."""
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", text)
    return safe if re.search(r"[A-Za-z0-9]", safe) else fallback


def _sheet_rows(main_csv: bytes) -> list[list[str]]:
    return list(csv.reader(io.StringIO(main_csv.decode("utf-8-sig"), newline="")))


def _error_text(e: BaseException) -> str:
    text = str(e) if isinstance(e, (GoogleError, ExportConfigError)) else f"{type(e).__name__}: {e}"
    return redact(text)[:2000]


def _bounds(
    date_from: date | None, date_to: date | None, tz: str
) -> tuple[datetime | None, datetime | None]:
    """[start, end) as UTC instants for inclusive calendar days in zone `tz`.

    Start is local midnight of date_from, end is local midnight after date_to; both are then
    converted to UTC, because received_at is stored in UTC.
    """
    zone = ZoneInfo(tz)
    start = datetime.combine(date_from, time.min, tzinfo=zone).astimezone(UTC) if date_from else None
    end = None
    if date_to and date_to < date.max:
        end = datetime.combine(date_to + timedelta(days=1), time.min, tzinfo=zone).astimezone(UTC)
    return start, end


Collected = list[tuple[Form, FormVersion, list[Submission]]]


def _load_form_data(
    db: Session, form: Form, date_from: date | None, date_to: date | None
) -> tuple[FormVersion | None, list[Submission]]:
    version = db.scalars(
        select(FormVersion)
        .where(FormVersion.form_id == form.id)
        .order_by(FormVersion.is_current.desc(), FormVersion.id.desc())
    ).first()
    query = (
        select(Submission)
        .join(FormVersion, Submission.form_version_id == FormVersion.id)
        .where(FormVersion.form_id == form.id)
        .order_by(Submission.id)
    )
    start, end = _bounds(date_from, date_to, get_settings().form_timezone)
    if start is not None:
        query = query.where(Submission.received_at >= start)
    if end is not None:
        query = query.where(Submission.received_at < end)
    return version, list(db.scalars(query))


def _load_export_data(db: Session, job: ExportJob) -> Collected:
    """Every form the job covers with its spec and the submissions inside the job's range.

    A single form with no uploaded version fails the job with a reason. In a project such a form
    is skipped (nothing can have been collected on it); a project with none left fails the same way.
    """
    if job.form_id is not None:
        forms = [db.get(Form, job.form_id)]
    else:
        forms = list(db.scalars(select(Form).where(Form.project_id == job.project_id).order_by(Form.id)))
    out: Collected = []
    for form in forms:
        version, subs = _load_form_data(db, form, job.date_from, job.date_to)
        if version is not None:
            out.append((form, version, subs))
    if not out:
        raise GoogleError(
            "This form has no uploaded version, so there is nothing to export"
            if job.form_id is not None
            else "No form in this project has an uploaded version, so there is nothing to export"
        )
    return out


def _form_files(form: Form, version: FormVersion, subs: list[Submission], stamp: str) -> dict[str, bytes]:
    """`build_csvs` output with each file stamped and named for its form; the main file is first."""
    built = build_csvs(version.json_spec, subs, get_settings().form_timezone)
    spec_id = next(iter(built)).removesuffix(".csv")  # the id inside the spec, which names the files
    named = {}
    for n, d in built.items():
        if spec_id != form.form_id and n.startswith(spec_id):
            n = form.form_id + n[len(spec_id) :]  # the form's own id, so two forms never share a name
        named[_stamped(n, form.form_id, stamp)] = d
    return named


def _bundle(files: dict[str, bytes], media: tuple[str, bytes] | None) -> bytes:
    """One zip of a project's files (and its media zip, when it has any) for the download."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)
        if media is not None:
            z.writestr(media[0], media[1])
    return buf.getvalue()


def _has_files(media_zip: bytes) -> bool:
    return bool(zipfile.ZipFile(io.BytesIO(media_zip)).namelist())


def _project_slug(db: Session, project_id: int) -> str:
    p = db.get(Project, project_id)
    return _safe_name(p.name if p else "", f"project_{project_id}")


def run_export(
    job_id: int,
    session_factory: SessionFactory,
    uploader: DriveUploader | None,
    sheets: SheetWriter | None,
    folder_id: str | None,
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
            collected = _load_export_data(db, job)
            if uploader is not None:
                stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
                first = True
                for form, version, subs in collected:
                    files = _form_files(form, version, subs, stamp)
                    main_name = next(iter(files))  # build_csvs puts the main file first
                    for name, data in files.items():
                        mime = "text/plain" if name.endswith(".txt") else "text/csv"
                        file_id = uploader.upload(folder_id, name, data, mime)
                        if name == main_name and first:
                            job.drive_file_id = file_id
                            db.commit()  # keep the id even if a later step fails
                            first = False
                    if sheets is not None and sheet_id:
                        sheets.replace(sheet_id, form.form_id, _sheet_rows(files[main_name]))
                        job.sheet_id = sheet_id
                media_zip = build_media_zip([s for _, _, subs in collected for s in subs])
                if _has_files(media_zip):
                    owner = collected[0][0].form_id if job.form_id is not None else _project_slug(db, job.project_id)
                    uploader.upload(folder_id, f"{owner}_media_{stamp}.zip", media_zip, "application/zip")
            else:
                for _, version, subs in collected:
                    build_csvs(version.json_spec, subs, get_settings().form_timezone)  # fail now, not at download, if it cannot be built
            job.row_count = sum(len(subs) for _, _, subs in collected)
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
    uploader: DriveUploader | None = Depends(get_drive_uploader),
    sheets: SheetWriter | None = Depends(get_sheet_writer),
    session_factory: SessionFactory = Depends(get_job_session),
    db: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> JobStarted:
    if uploader is not None and not settings.drive_folder_id:
        raise HTTPException(status_code=503, detail="DRIVE_FOLDER_ID is not set: exports need a Drive folder")
    detail: dict = {}
    if body.form_id is not None:
        form = db.scalars(select(Form).where(Form.form_id == body.form_id)).first()
        if form is None or not staff_can_see_form(db, user, form.id):  # same 404 either way
            raise HTTPException(status_code=404, detail="Form not found")
        scope = {"form_id": form.id}
        detail["form_id"] = form.form_id
    else:
        if db.get(Project, body.project_id) is None or not staff_can_see_project(db, user, body.project_id):
            raise HTTPException(status_code=404, detail="Project not found")  # same 404 either way
        scope = {"project_id": body.project_id}
        detail["project_id"] = body.project_id
    if body.date_from:
        detail["date_from"] = body.date_from.isoformat()
    if body.date_to:
        detail["date_to"] = body.date_to.isoformat()
    job = ExportJob(**scope, date_from=body.date_from, date_to=body.date_to, requested_by=user.id, status="pending")
    db.add(job)
    db.flush()
    audit.record(db, user.id, "export.start", "export_job", job.id, request, detail)
    db.commit()
    background.add_task(
        run_export, job.id, session_factory, uploader, sheets, settings.drive_folder_id, settings.google_sheet_id
    )
    return JobStarted(job_id=job.id)


def _load(db: Session, user: User, job_id: int) -> tuple[ExportJob, str | None, str | None]:
    """The job, its form_id (one form) and project name (a project); one 404 for missing and not-yours."""
    job = db.get(ExportJob, job_id)
    if job is not None:
        if job.form_id is not None:
            allowed = staff_can_see_form(db, user, job.form_id)
        else:
            allowed = job.project_id is not None and staff_can_see_project(db, user, job.project_id)
        if allowed:
            form_key = db.scalar(select(Form.form_id).where(Form.id == job.form_id)) if job.form_id else None
            project = db.get(Project, job.project_id) if job.project_id else None
            return job, form_key, project.name if project else None
    raise HTTPException(status_code=404, detail="Export job not found")


@router.get("/exports/{job_id}", response_model=JobOut)
def get_export(job_id: int, user: User = Depends(_staff), db: Session = Depends(get_session)) -> JobOut:
    job, form_key, project_name = _load(db, user, job_id)
    return _job_out(job, form_key, project_name)


@router.get("/exports/{job_id}/download")
def download_export(
    job_id: int,
    user: User = Depends(_staff),
    uploader: DriveUploader | None = Depends(get_drive_uploader),
    db: Session = Depends(get_session),
) -> Response:
    """One form: its main CSV, byte for byte (the BOM is what makes Devanagari open in Excel).
    A project: a zip of every form's files. Either way within the job's date range.

    A form's CSV comes from Drive when the job put it there, otherwise it is built here from the
    current data. A project's zip is always built here.
    """
    job, form_key, project_name = _load(db, user, job_id)
    if job.status != "done":
        detail = job.error if job.status == "failed" and job.error else f"Export is {job.status}, not done"
        raise HTTPException(status_code=409, detail=detail)
    requested = job.requested_at if job.requested_at.tzinfo else job.requested_at.replace(tzinfo=UTC)
    stamp = requested.strftime("%Y%m%dT%H%M%SZ")
    if job.date_from and job.date_to:
        span = f"_{job.date_from.isoformat()}_to_{job.date_to.isoformat()}"
    elif job.date_from:
        span = f"_from_{job.date_from.isoformat()}"
    elif job.date_to:
        span = f"_to_{job.date_to.isoformat()}"
    else:
        span = ""
    if job.form_id is None:
        slug = _safe_name(project_name or "", f"project_{job.project_id}")
        try:
            collected = _load_export_data(db, job)
            files: dict[str, bytes] = {}
            for form, version, subs in collected:
                files.update(_form_files(form, version, subs, stamp))
            media_zip = build_media_zip([s for _, _, subs in collected for s in subs])
            media = (f"{slug}_media_{stamp}.zip", media_zip) if _has_files(media_zip) else None
            data = _bundle(files, media)
        except Exception as e:  # noqa: BLE001 - say why, never a bare 500
            raise HTTPException(status_code=500, detail=_error_text(e)) from None
        return Response(
            content=data,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{slug}{span}_{stamp}.zip"'},
        )
    if job.drive_file_id:
        if uploader is None:
            raise HTTPException(status_code=503, detail="This export is in Drive, and Drive is no longer configured")
        try:
            data = uploader.download(job.drive_file_id)
        except GoogleError as e:
            raise HTTPException(status_code=502, detail=_error_text(e)) from None
    else:
        try:
            _, version, subs = _load_export_data(db, job)[0]
            data = next(iter(build_csvs(version.json_spec, subs, get_settings().form_timezone).values()))
        except Exception as e:  # noqa: BLE001 - say why, never a bare 500
            raise HTTPException(status_code=500, detail=_error_text(e)) from None
    safe = _safe_name(form_key, "form")  # a header value, never raw text
    return Response(
        content=data,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{safe}{span}_{stamp}.csv"'},
    )
