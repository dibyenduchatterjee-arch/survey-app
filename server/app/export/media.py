"""The media bundle: every uploaded file of the given submissions, decrypted, in one zip.

On disk a file is `<submission_uuid>/<index>.<ext>` and encrypted; the question name is
deliberately not in the path. In the export a file is named
`<submission_uuid>_<question_name>.<ext>` - the same string the CSV puts in the question's
cell, so the analyst can join a row to its picture. `media_name()` is the single place that
string is built; both the CSV and the zip call it.

A file that is missing on disk, or whose ciphertext fails authentication, is SKIPPED: never
exported as garbage and never allowed to fail the whole export. The zip then carries
`export_errors.txt` naming each submission uuid and question that could not be read. The CSV
cell for such a file still holds its expected name (the CSV does not read files), so the
manifest is how an analyst learns that entry is absent.

Not pure in one respect: media rows are read through the submissions' own session, because
the models carry no relationship from Submission to MediaFile.
"""

import io
import zipfile
from collections.abc import Sequence
from pathlib import Path

from cryptography.exceptions import InvalidTag
from sqlalchemy import select
from sqlalchemy.orm import object_session

from app.core.config import get_settings
from app.core.crypto import decrypt_bytes
from app.db.models import MediaFile, Submission

_CHUNK = 500


def media_name(submission_uuid: str, media: MediaFile) -> str:
    ext = Path(media.filename).suffix  # includes the dot; stored names are "<index>.<ext>"
    return f"{submission_uuid}_{media.question_name}{ext}"


def media_by_submission(submissions: Sequence[Submission]) -> dict[int, list[MediaFile]]:
    """Submission id -> its MediaFile rows (ordered by id), with one query per 500 submissions."""
    found: dict[int, list[MediaFile]] = {s.id: [] for s in submissions}
    sessions: dict[int, tuple] = {}
    for s in submissions:
        sess = object_session(s)
        if sess is not None:
            sessions.setdefault(id(sess), (sess, []))[1].append(s.id)
    for sess, ids in sessions.values():
        for i in range(0, len(ids), _CHUNK):
            rows = sess.scalars(
                select(MediaFile).where(MediaFile.submission_id.in_(ids[i : i + _CHUNK])).order_by(MediaFile.id)
            )
            for m in rows:
                found[m.submission_id].append(m)
    return found


ERRORS_FILE = "export_errors.txt"


def build_media_zip(submissions: Sequence[Submission]) -> bytes:
    """Every readable file, decrypted. An unreadable one is skipped and listed in export_errors.txt."""
    root = Path(get_settings().media_root)
    buf = io.BytesIO()
    skipped: list[str] = []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for s in submissions:
            for m in media_by_submission([s])[s.id]:
                try:
                    data = decrypt_bytes((root / m.storage_path).read_bytes())
                except (OSError, InvalidTag) as e:
                    if isinstance(e, FileNotFoundError):
                        why = "file missing"
                    elif isinstance(e, InvalidTag):
                        why = "failed authentication (corrupt or tampered)"
                    else:
                        why = "unreadable"
                    skipped.append(f"{s.uuid}\t{m.question_name}\t{media_name(s.uuid, m)}\t{why}")
                    continue
                z.writestr(media_name(s.uuid, m), data)
        if skipped:
            head = "These media files could not be read and are NOT in this bundle.\n"
            head += "submission_uuid\tquestion\texpected_name\treason\n"
            z.writestr(ERRORS_FILE, head + "\n".join(skipped) + "\n")
    return buf.getvalue()
