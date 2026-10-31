"""The media bundle: every uploaded file of the given submissions, decrypted, in one zip.

On disk a file is `<submission_uuid>/<index>.<ext>` and encrypted; the question name is
deliberately not in the path. In the export a file is named
`<submission_uuid>_<question_name>.<ext>` - the same string the CSV puts in the question's
cell, so the analyst can join a row to its picture. `media_name()` is the single place that
string is built; both the CSV and the zip call it.

A file that is missing on disk, or whose ciphertext fails authentication, raises: a CSV cell
naming a file that is not in the bundle (or a damaged picture handed over as genuine) is
worse than an export that stops.

Not pure in one respect: media rows are read through the submissions' own session, because
the models carry no relationship from Submission to MediaFile.
"""

import io
import zipfile
from collections.abc import Sequence
from pathlib import Path

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


def build_media_zip(submissions: Sequence[Submission]) -> bytes:
    root = Path(get_settings().media_root)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for s in submissions:
            for m in media_by_submission([s])[s.id]:
                z.writestr(media_name(s.uuid, m), decrypt_bytes((root / m.storage_path).read_bytes()))
    return buf.getvalue()
