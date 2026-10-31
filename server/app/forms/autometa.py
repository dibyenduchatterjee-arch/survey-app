"""Automatic metadata injected into every form at upload (publish) time.

THE CONTRACT THE BROWSER APP READS
    Every compiled spec ends its top-level `nodes` with these five nodes, unless the
    XLSForm already declares a question of the same name anywhere in the form (then the
    author's own question is kept untouched and nothing is injected under that name):

        name            type       filled by                      value
        _gps            geopoint   the device, automatically      "lat lon altitude accuracy"
                                                                  (the format app/intake/geopoint.py parses)
        _started_at     dateTime   the device, when the form      ISO-8601 with offset
                                   is opened
        _finished_at    dateTime   the device, when the           ISO-8601 with offset
                                   enumerator finishes
        _device_id      text       the device                     a stable per-device id
        _submitted_by   text       THE SERVER, from the           the account's username
                                   authenticated user

    Each node carries `"auto": true` and `"auto_source"` (the name without the underscore:
    gps, started_at, finished_at, device_id, submitted_by). The browser app MUST NOT render
    a node with `auto: true` as a question; it populates the answer itself and sends it in
    `data` under the node's name. They are never `required`, have no `relevant` or
    `constraint`, and a blank value is never a validation failure.

    `_submitted_by` is overwritten on the server from the token on every intake, whatever the
    payload carries. A blank `_started_at`, `_finished_at` or `_device_id` is back-filled from
    the submission envelope (started_at, finished_at, device_id).

    A question the author wrote as a geopoint is separate and additional: `_gps` is an extra,
    never a replacement. In the CSV export these become the columns `_gps_lat`, `_gps_lon`,
    `_gps_accuracy`, `_started_at`, `_finished_at`, `_device_id`, `_submitted_by`, after the
    form's own questions (they are ordinary spec nodes, so the export picks them up).

Versions are immutable: forms published before this existed keep the spec they were uploaded with.
"""

from typing import Any

AUTO_FIELDS: dict[str, str] = {
    "_gps": "geopoint",
    "_started_at": "dateTime",
    "_finished_at": "dateTime",
    "_device_id": "text",
    "_submitted_by": "text",
}


def _names(nodes: list[dict]) -> set[str]:
    found: set[str] = set()
    for n in nodes:
        found.add(n.get("name", ""))
        found |= _names(n.get("children", []))
    return found


def inject_auto_metadata(spec: dict[str, Any]) -> dict[str, Any]:
    """Append the automatic fields the form does not already declare. Mutates and returns `spec`."""
    declared = _names(spec.get("nodes", []))
    for name, qtype in AUTO_FIELDS.items():
        if name in declared:
            continue
        spec["nodes"].append(
            {"type": qtype, "name": name, "auto": True, "auto_source": name.lstrip("_")}
        )
    return spec
