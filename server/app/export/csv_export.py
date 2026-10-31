"""CSV export: one main file, plus one child file per repeat (nested repeats included).

This is the file an M&E analyst opens in Excel, so four things are deliberate.

ENCODING   UTF-8 WITH a byte-order mark and CRLF line ends. Without the BOM, Excel on Windows
           reads the file as the ANSI code page and Devanagari arrives as mojibake.

FILES      `build_csvs()` returns {filename: bytes}, the main file first:
             <form_id>.csv                      one row per submission
             <form_id>_<repeat>.csv             one row per repeat row
             <form_id>_<outer>_<inner>.csv      a repeat nested in another, one file per nesting
           The column list of every file comes from ONE walk of the spec, before any data is
           read, so a repeat nobody answered still produces its header-only file, and a
           nested repeat is never flattened into its parent.

COLUMNS    Main:   uuid, submitted_by, received_at, status, failures, then the form's questions
                   in form order (groups are transparent; repeats and notes are not columns).
                   `submitted_by` is the username (the numeric id if the user row is gone). A geopoint `q` becomes q_lat, q_lon,
                   q_accuracy. A media question's cell is the file's name in the media zip.
           Child:  parent_uuid, [<ancestor>_row_index for each enclosing repeat, outermost
                   first], row_index, then the repeat's questions. A top-level repeat is
                   therefore  parent_uuid, row_index, ...  and a repeat nested one level
                   down is    parent_uuid, <outer>_row_index, row_index, ...  Row indexes are
                   1-based. To join a nested row to its parent row, match
                   (parent_uuid, <outer>_row_index) to (parent_uuid, row_index) in the outer file.

FLAGGED    `status` carries the submission status (received / flagged / approved / rejected).
           `failures` holds every server-side validation failure as `question: message`,
           joined with " | " (a failure with no question is just the message). A clean
           submission has an empty cell, so filtering status = flagged lists what needs review.

SAFETY     A text value that starts with = + - @ (or a tab or CR) is prefixed with ' so Excel
           shows it instead of running it. Real numbers (int/float) are written untouched, so
           -1 stays a number; a text answer "-1" is prefixed, which is the safe direction.

GEOPOINT   PINNED WIRE FORMAT: the ODK string "lat lon altitude accuracy", space-separated,
           decimal degrees and metres; altitude and accuracy may be omitted ("lat lon").
           A dict with lat/latitude, lon/lng/longitude, accuracy is also tolerated. No
           value (None or "") gives three blank cells: GPS not captured. Anything else -
           wrong token count, non-numeric, lat outside +-90, lon outside +-180, negative
           accuracy - is a malformed value: that submission's three cells are blank AND a
           line (submission uuid, question, reason) goes into an extra `export_errors.txt`
           entry of the returned dict, which exists only when something was malformed. One
           bad coordinate never costs the other rows (the same rule as unreadable media).

The repeat rows are read through the submissions' own session (the models carry no
relationship), one query per 500 submissions. No web framework is imported here.
"""

import csv
import io
import json
from collections.abc import Sequence
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import object_session

from app.db.models import RepeatRow, Submission, User
from app.export.media import media_by_submission, media_name

BOM = b"\xef\xbb\xbf"
ERRORS_FILE = "export_errors.txt"
_META = ["uuid", "submitted_by", "received_at", "status", "failures"]
_DANGEROUS = ("=", "+", "-", "@", "\t", "\r")
_NOT_COLUMNS = {"note", "repeat"}
_CHUNK = 500


# ---- spec walk (once, before any data) ---------------------------------------------------


def _questions(nodes: list[dict]) -> list[dict]:
    """Leaf questions in form order, groups flattened, repeats and notes left out."""
    out: list[dict] = []
    for n in nodes:
        if n["type"] == "repeat":
            continue
        if n.get("children"):  # a group
            out.extend(_questions(n["children"]))
        elif n["type"] not in _NOT_COLUMNS:
            out.append(n)
    return out


def _repeats(nodes: list[dict], path: tuple[str, ...] = ()) -> list[tuple[tuple[str, ...], dict]]:
    """Every repeat, outermost first, depth first: (path of repeat names, node)."""
    out: list[tuple[tuple[str, ...], dict]] = []
    for n in nodes:
        if n["type"] == "repeat":
            here = path + (n["name"],)
            out.append((here, n))
            out.extend(_repeats(n.get("children", []), here))
        elif n.get("children"):  # a group can hold a repeat
            out.extend(_repeats(n["children"], path))
    return out


def _columns(questions: list[dict]) -> list[str]:
    cols: list[str] = []
    for q in questions:
        if q["type"] == "geopoint":
            cols += [f"{q['name']}_lat", f"{q['name']}_lon", f"{q['name']}_accuracy"]
        else:
            cols.append(q["name"])
    return cols


# ---- cell values -------------------------------------------------------------------------


def _safe(value: str) -> str:
    return "'" + value if value.startswith(_DANGEROUS) else value


def _text(value: Any) -> str:
    """A cell for any stored answer. Strings are defused; numbers are left as numbers."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        value = " ".join(str(v) for v in value)
    elif isinstance(value, dict):
        value = json.dumps(value, ensure_ascii=False)
    return _safe(str(value))


class GeopointFormatError(ValueError):
    """A stored geopoint is not in the pinned wire format. Names the submission and question."""


def _coord(x: Any, lo: float, hi: float) -> str | None:
    if isinstance(x, bool) or x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return str(x) if lo <= v <= hi else None


def _geo(value: Any, where: str) -> list[str]:
    """[lat, lon, accuracy]. No value at all is blank (no GPS captured); a malformed one raises
    GeopointFormatError, which _cells catches at the row level."""
    if value is None or value == "":
        return ["", "", ""]
    lat = lon = acc = None
    if isinstance(value, str):
        parts = value.split()
        if 2 <= len(parts) <= 4:
            lat, lon = parts[0], parts[1]
            acc = parts[3] if len(parts) == 4 else None
    elif isinstance(value, dict):
        lat = value.get("lat", value.get("latitude"))
        lon = value.get("lon", value.get("lng", value.get("longitude")))
        acc = value.get("accuracy")
    lat, lon = _coord(lat, -90, 90), _coord(lon, -180, 180)
    accuracy = _coord(acc, 0, float("inf")) if acc is not None else ""
    if lat is None or lon is None or accuracy is None:
        raise GeopointFormatError(
            f"{where}: geopoint {value!r} is not 'lat lon [altitude [accuracy]]'"
        )
    return [lat, lon, accuracy]


def _cells(questions: list[dict], data: dict, media: dict[str, str], uuid: str,
           errors: list[str]) -> list[str]:
    row: list[str] = []
    for q in questions:
        name = q["name"]
        if q["type"] == "geopoint":
            try:
                row += _geo(data.get(name), f"submission {uuid}, question {name}")
            except GeopointFormatError as e:
                errors.append(f"{uuid}\t{name}\t{e}")  # this row's GPS only: blank, listed, carry on
                row += ["", "", ""]
        elif q["type"] in ("image", "audio", "video", "file"):
            row.append(media.get(name, ""))
        else:
            row.append(_text(data.get(name)))
    return row


def _failures(sub: Submission) -> str:
    parts = []
    for f in sub.failures_json or []:
        msg = str(f.get("message", ""))
        q = f.get("question", "")
        parts.append(f"{q}: {msg}" if q else msg)
    return _safe(" | ".join(parts))


# ---- loading repeat rows ----------------------------------------------------------------------


def _repeat_rows(submissions: Sequence[Submission]) -> dict[tuple[int, str], list[RepeatRow]]:
    """(submission id, repeat name) -> its stored rows in row order."""
    found: dict[tuple[int, str], list[RepeatRow]] = {}
    sessions: dict[int, tuple] = {}
    for s in submissions:
        sess = object_session(s)
        if sess is not None:
            sessions.setdefault(id(sess), (sess, []))[1].append(s.id)
    for sess, ids in sessions.values():
        for i in range(0, len(ids), _CHUNK):
            rows = sess.scalars(
                select(RepeatRow)
                .where(RepeatRow.submission_id.in_(ids[i : i + _CHUNK]))
                .order_by(RepeatRow.submission_id, RepeatRow.row_index)
            )
            for r in rows:
                found.setdefault((r.submission_id, r.repeat_name), []).append(r)
    return found


def _usernames(submissions: Sequence[Submission]) -> dict[int, str]:
    found: dict[int, str] = {}
    sessions: dict[int, tuple] = {}
    for s in submissions:
        sess = object_session(s)
        if sess is not None:
            sessions.setdefault(id(sess), (sess, set()))[1].add(s.submitted_by)
    for sess, ids in sessions.values():
        ids = list(ids)
        for i in range(0, len(ids), _CHUNK):
            for u in sess.scalars(select(User).where(User.id.in_(ids[i : i + _CHUNK]))):
                found[u.id] = u.username
    return found


# ---- output ---------------------------------------------------------------------------------------


def _encode(header: list[str], rows: list[list[str]]) -> bytes:
    buf = io.StringIO(newline="")
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(header)
    w.writerows(rows)
    return BOM + buf.getvalue().encode("utf-8")


def build_csvs(spec: dict, submissions: Sequence[Submission]) -> dict[str, bytes]:
    """{filename: bytes}, the main file first, then one file per repeat in form order."""
    form_id = spec["form_id"]
    main_q = _questions(spec["nodes"])
    stored = _repeat_rows(submissions)
    media = media_by_submission(submissions)
    users = _usernames(submissions)
    errors: list[str] = []

    main_rows: list[list[str]] = []
    for s in submissions:
        names = {m.question_name: media_name(s.uuid, m) for m in media[s.id]}
        main_rows.append(
            [s.uuid, _text(users.get(s.submitted_by, str(s.submitted_by))), _text(s.received_at), _text(s.status), _failures(s)]
            + _cells(main_q, s.data_json or {}, names, s.uuid, errors)
        )
    files = {f"{form_id}.csv": _encode(_META + _columns(main_q), main_rows)}

    for path, node in _repeats(spec["nodes"]):
        questions = _questions(node.get("children", []))
        ancestors = [f"{p}_row_index" for p in path[:-1]]
        header = ["parent_uuid", *ancestors, "row_index", *_columns(questions)]
        rows: list[list[str]] = []
        for s in submissions:
            names = {m.question_name: media_name(s.uuid, m) for m in media[s.id]}
            for keys, data in _walk_rows(stored, s, path):
                rows.append([s.uuid, *keys, *_cells(questions, data, names, s.uuid, errors)])
        files[f"{form_id}_{'_'.join(path)}.csv"] = _encode(header, rows)
    if errors:
        head = "These values were malformed; their cells are blank in the CSVs.\n"
        head += "submission_uuid\tquestion\treason\n"
        files[ERRORS_FILE] = BOM + (head + "\n".join(errors) + "\n").encode("utf-8")
    return files


def _walk_rows(stored, sub: Submission, path: tuple[str, ...]):
    """Yield ([ancestor indexes..., row_index], row data) for the repeat at `path`."""
    level: list[tuple[list[str], dict]] = []
    for r in stored.get((sub.id, path[0]), []):
        level.append(([str(r.row_index)], r.data_json or {}))
    for name in path[1:]:  # nested rows sit inside their parent row under the nested name
        nxt = []
        for keys, data in level:
            inner = data.get(name)
            if isinstance(inner, list):
                for i, row in enumerate(inner, start=1):
                    nxt.append((keys + [str(i)], row if isinstance(row, dict) else {}))
        level = nxt
    return level
