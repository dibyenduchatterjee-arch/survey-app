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
import shutil
import uuid as uuidlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import audit
from app.core.config import get_settings
from app.core.crypto import encrypt_bytes
from app.db.models import Assignment, Form, FormVersion, MediaFile, RepeatRow, Submission, User
from app.forms.validate import Failure, validate_submission


# Request-size limits shared by every route that accepts a submission.
MAX_MEDIA_PARTS = 20
MAX_SUBMISSION_JSON_BYTES = 1024 * 1024


def lenient_dt(v: Any) -> datetime | None:
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


class IntakeRefused(Exception):
    """A submission that must not be stored. Raised before anything is written."""

    # EVERY refusal means the server stored nothing, so the client must KEEP the record
    # (`retain_on_device` is always True) and surface it; `code` says why. A client must
    # never delete a submission because of a refusal. Codes: bad_uuid, account_inactive,
    # not_assigned, form_version_unknown, uuid_in_use, file_too_large, media_slot_unknown,
    # file_type_mismatch.
    retain_on_device = True

    def __init__(self, status_code: int, code: str, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.code = code
        self.detail = detail

    def body(self) -> dict:
        return {"code": self.code, "message": self.detail, "retain_on_device": self.retain_on_device}


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



# ---- intake -------------------------------------------------------------------------


def _canonical_uuid(raw: str) -> str:
    """The client's id as a lower-case canonical UUID: the only form that reaches a path."""
    try:
        return str(uuidlib.UUID(raw.strip()))
    except (ValueError, AttributeError):
        raise IntakeRefused(422, "bad_uuid", "uuid must be a UUID") from None


def _existing(db: Session, uid: str) -> Submission | None:
    return db.scalar(select(Submission).where(Submission.uuid == uid))


def _replay(existing: Submission, user: User) -> tuple[Submission, bool]:
    if existing.submitted_by != user.id:  # reveal nothing about someone else's submission
        raise IntakeRefused(409, "uuid_in_use", "This submission id is already in use")
    return existing, False


# Question types that take an upload. The one list: routes import it, they do not copy it.
MEDIA_QUESTION_TYPES = frozenset({"image", "audio", "video", "file"})

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


def walk_nodes(nodes: list[dict]):
    for n in nodes:
        yield n
        yield from walk_nodes(n.get("children", []))


def _media_questions(spec: dict) -> dict[str, str]:
    """Question name -> its type, for every question that takes an upload."""
    return {n["name"]: n["type"] for n in walk_nodes(spec["nodes"]) if n["type"] in MEDIA_QUESTION_TYPES}


def _repeat_names(spec: dict) -> set[str]:
    return {n["name"] for n in walk_nodes(spec["nodes"]) if n["type"] == "repeat"}


def _normalise(value: Any) -> Any:
    """A select_multiple list becomes the canonical space-separated string, at any depth."""
    if isinstance(value, dict):
        return {k: _normalise(v) for k, v in value.items()}
    if isinstance(value, list):
        if all(isinstance(i, str) for i in value):
            return " ".join(value)
        return [_normalise(i) for i in value]
    return value


CLOCK_SKEW = timedelta(minutes=5)  # a device clock may run this far ahead of the server
CLOCK_MAX_AGE = timedelta(days=30)  # and a visit may wait this long to be synced


def validation_clock(finished_at: datetime | None, received_at: datetime) -> tuple[datetime, Failure | None]:
    """The `now` a submission is validated against, and a failure if the device clock is off.

    Validation reflects when the data was COLLECTED: a visit entered on Monday and synced on
    Wednesday must not be flagged for a date that was valid when it was typed (`. <= today()`).
    So the device-reported `finished_at` is used when it is sane: not more than CLOCK_SKEW
    after `received_at`, and not more than CLOCK_MAX_AGE before it. A missing one falls back
    to `received_at` silently. An implausible one falls back to `received_at` AND is reported
    as a rule "error" failure, so a supervisor can see why.
    This does not make the device clock trusted for ordering or expiry: `received_at`, the
    server's own clock, still governs both. A naive `finished_at` is read as UTC, as it is
    stored.
    """
    if finished_at is None:
        return received_at, None
    if finished_at.tzinfo is None:
        finished_at = finished_at.replace(tzinfo=UTC)
    if finished_at > received_at + CLOCK_SKEW:
        reason = "is in the future"
    elif finished_at < received_at - CLOCK_MAX_AGE:
        reason = f"is more than {CLOCK_MAX_AGE.days} days old"
    else:
        return finished_at, None
    return received_at, Failure(
        "", "error",
        f"The device clock was implausible (finished_at {finished_at.isoformat()} {reason}); "
        "the submission was validated against the server's receipt time",
    )


def _validate(spec: dict, data: dict, repeats: dict, now: datetime | None = None) -> list[Failure]:
    try:
        failures = validate_submission(spec, data, repeats, now or datetime.now(UTC))
    except Exception:  # noqa: BLE001 - a crash here must not lose the visit
        failures = [Failure("", "error", "Server-side validation could not run for this submission")]
    known = _repeat_names(spec)
    failures += [
        Failure(name, "error", "Not a repeat in this version of the form")
        for name in repeats
        if name not in known
    ]
    return failures


def resolve_form_version(
    db: Session, user: User, form_id: str, version: str, uuid: str | None = None
) -> FormVersion:
    """The form version a submission is for, with unknown-form masking built in.

    An enumerator is told 403 not_assigned for a form that does not exist and for one they
    are not assigned, so form ids cannot be probed; staff get 404 form_version_unknown for
    a form or version that does not exist. A version that exists but is not (or no longer)
    published IS returned: the visit happened, store_submission flags it. If `uuid` is
    one this user already submitted, its own form version is returned so a replay still
    reaches store_submission and gets its original receipt even after an assignment change.
    """
    if uuid is not None:
        try:
            prior = _existing(db, _canonical_uuid(uuid))
        except IntakeRefused:
            prior = None  # store_submission reports the bad uuid
        if prior is not None and prior.submitted_by == user.id:
            return db.get(FormVersion, prior.form_version_id)
    form = db.scalar(select(Form).where(Form.form_id == form_id))
    if user.role == "enumerator" and (
        form is None
        or db.scalar(select(Assignment.id).where(Assignment.user_id == user.id, Assignment.form_id == form.id))
        is None
    ):
        raise IntakeRefused(403, "not_assigned", "Forbidden")  # unknown and unassigned look the same
    fv = (
        db.scalar(select(FormVersion).where(FormVersion.form_id == form.id, FormVersion.version == version))
        if form is not None
        else None
    )
    if fv is None:
        raise IntakeRefused(404, "form_version_unknown", "Form or version not found")
    return fv


def _check_media(media: dict[str, MediaPart], spec: dict) -> dict[str, tuple[str, str]]:
    """Size, slot and magic-byte checks for media parts; (extension, content type) by name."""
    settings = get_settings()
    for part in media.values():
        if len(part.data) > settings.max_media_bytes:
            raise IntakeRefused(413, "file_too_large", "A file is larger than the media size limit")
    slots = _media_questions(spec)
    sniffed: dict[str, tuple[str, str]] = {}
    for name, part in media.items():
        if name not in slots:
            raise IntakeRefused(422, "media_slot_unknown", "A file was sent for a question that takes no upload")
        kind = _sniff(part.data, slots[name])
        if kind is None:
            raise IntakeRefused(415, "file_type_mismatch", f"A file's contents are not an accepted {slots[name]} format")
        sniffed[name] = kind
    return sniffed


def _attach_new_media(
    db: Session, existing: Submission, user: User, media: dict[str, MediaPart], request: Request,
    _retry: bool = True,
) -> Submission:
    """A same-user replay may carry files for slots the stored submission has no file for.

    ODK Collect splits a submission with several attachments across POSTs that share one
    instance id; a retry after a partly uploaded batch does the same. Files for slots with
    NO existing MediaFile row are stored and attached. An existing row is NEVER replaced, so
    the same payload twice changes nothing. The submission row, its data and its receipt are
    untouched (no re-validation). Refusals (size, slot, bytes) happen before anything is
    written; a later failure rolls the rows back and removes only the files written here.

    There is deliberately no assignment check here: a replay of something we already hold is
    always answered, even if the assignment was removed since (the replay-always rule in
    store_submission). The caller has already matched the submitter to the owner.
    """
    media = {name: part for name, part in media.items() if part.data}
    if not media:
        return existing
    held = {
        row.question_name: row.filename
        for row in db.scalars(select(MediaFile).where(MediaFile.submission_id == existing.id))
    }
    new = {name: part for name, part in media.items() if name not in held}
    if not new:
        return existing
    fv = db.get(FormVersion, existing.form_version_id)
    sniffed = _check_media(new, fv.json_spec)

    def position(filename: str) -> int:
        stem = filename.split(".")[0]
        return int(stem) if stem.isdigit() else 0

    next_index = max([len(held), *(position(f) for f in held.values())]) + 1
    stored = {name: f"{next_index + i}.{sniffed[name][0]}" for i, name in enumerate(sorted(new))}
    folder = Path(get_settings().media_root) / existing.uuid
    written: list[Path] = []
    try:
        for name in sorted(new):
            ext, content_type = sniffed[name]
            db.add(
                MediaFile(
                    submission_id=existing.id,
                    question_name=name,
                    filename=stored[name],
                    content_type=content_type,
                    size=len(new[name].data),
                    storage_path=f"{existing.uuid}/{stored[name]}",
                    sha256=hashlib.sha256(new[name].data).hexdigest(),
                )
            )
        try:
            db.flush()  # the unique (submission, question) constraint decides a concurrent attach
        except IntegrityError:
            db.rollback()
            if not _retry:
                raise
            # A concurrent replay won a slot. Nothing of ours was written; look again and
            # attach whatever is still missing.
            return _attach_new_media(db, existing, user, media, request, _retry=False)
        folder.mkdir(parents=True, exist_ok=True)
        for name in sorted(new):
            path = folder / stored[name]
            with path.open("xb") as fh:  # exclusive: never overwrite a file someone else wrote
                written.append(path)
                fh.write(encrypt_bytes(new[name].data))
        audit.record(
            db, user.id, "submission.media_attach", "submission", existing.uuid, request,
            {"media": len(new)},
        )
        db.commit()
    except BaseException:
        db.rollback()
        for path in written:
            path.unlink(missing_ok=True)
        raise
    return existing


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

    Raises IntakeRefused (status_code, code, detail) for anything that must not be stored; in
    that case nothing has been written. `created` is False for a replay of a uuid this
    user already submitted. `media` maps question name -> file. `meta` carries the
    device-reported extras (device id, device clock, gps).
    """
    settings = get_settings()
    uid = _canonical_uuid(uuid)
    meta = meta or SubmissionMeta()

    if not user.is_active:
        raise IntakeRefused(403, "account_inactive", "Forbidden")
    # A replay of something we already hold ALWAYS returns the original receipt, even if the
    # assignment was removed since. (Fast path only; the unique constraint is the real guard.)
    existing = _existing(db, uid)
    if existing is not None and existing.submitted_by == user.id:
        return _attach_new_media(db, existing, user, media, request), False
    if user.role == "enumerator" and db.scalar(
        select(Assignment.id).where(
            Assignment.user_id == user.id, Assignment.form_id == form_version.form_id
        )
    ) is None:
        raise IntakeRefused(403, "not_assigned", "Forbidden")
    if existing is not None:
        return _replay(existing, user)  # someone else's id: 409, nothing revealed

    # A zero-byte part is how a browser says "no file chosen": absent, not an error.
    media = {name: part for name, part in media.items() if part.data}
    sniffed = _check_media(media, form_version.json_spec)

    spec = form_version.json_spec
    data = _normalise(data)
    repeats = {name: [_normalise(r) for r in rows] for name, rows in repeats.items()}
    received_at = datetime.now(UTC)  # the server's clock, never the device's
    now, clock_failure = validation_clock(meta.finished_at, received_at)
    failures = _validate(spec, data, repeats, now)
    if clock_failure:
        failures.append(clock_failure)
    if form_version.published_at is None:
        # The visit happened; refusing it would lose it. Store it, flagged, for a supervisor.
        failures.append(
            Failure("form_version", "error", "The form version was not published when this submission arrived")
        )

    folder = Path(settings.media_root) / uid
    wrote_files = False
    try:
        sub = Submission(
            uuid=uid,
            form_version_id=form_version.id,
            submitted_by=user.id,
            received_at=received_at,  # the server's clock, never the device's
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
            _replay(winner, user)  # someone else's id: 409
            return _attach_new_media(db, winner, user, media, request), False
        for name, rows in repeats.items():
            for i, row in enumerate(rows, start=1):  # 1-based, as in the failure paths
                db.add(RepeatRow(submission_id=sub.id, repeat_name=name, row_index=i, data_json=row))
        # On disk a file is <position>.<ext>, never the question name (client-influenced: it could
        # collide case-insensitively on Windows, be a reserved name like CON, or overflow the
        # path limit). The real question name lives in the MediaFile row.
        stored = {name: f"{i}.{sniffed[name][0]}" for i, name in enumerate(sorted(media), start=1)}
        for name in sorted(media):
            ext, content_type = sniffed[name]
            db.add(
                MediaFile(
                    submission_id=sub.id,
                    question_name=name,
                    filename=stored[name],
                    content_type=content_type,
                    size=len(media[name].data),
                    storage_path=f"{uid}/{stored[name]}",
                    sha256=hashlib.sha256(media[name].data).hexdigest(),
                )
            )
        db.flush()
        if media:
            wrote_files = True  # we own this uuid now: the flush above won it
            folder.mkdir(parents=True, exist_ok=True)
            for name in sorted(media):
                (folder / stored[name]).write_bytes(encrypt_bytes(media[name].data))
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


