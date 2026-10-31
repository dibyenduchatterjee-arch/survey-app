"""Likely-duplicate detection. Reports only; nothing here ever changes or deletes a row."""

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.models import Form, FormVersion, RepeatRow, Submission
from app.intake.submissions import walk_nodes


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
    skip = frozenset(n["name"] for n in walk_nodes(spec["nodes"]) if n["type"] in _NOT_ANSWERS)
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


