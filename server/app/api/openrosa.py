"""OpenRosa endpoints, so the ODK Collect Android app can use this server as a fallback.

THIS MODULE CONTAINS NO INTAKE RULES. It translates OpenRosa's wire format (HTTP Basic,
XML in, XML out, multipart with an `xml_submission_file` part) into the arguments of
`app.intake.submissions.store_submission` / `resolve_form_version`, and translates their
results and refusals back. Assignment, size, media sniffing, validation, idempotency and
cleanup are all decided there, so ODK Collect and the platform's own app cannot drift
apart on the rules that protect field data. If a rule seems to be needed here, it belongs
in the intake module.

Wire translation done here:
    * `meta/instanceID` ("uuid:<uuid>") is the submission uuid, the idempotency key. A
      retried Collect submission therefore gets the original receipt.
    * The instance XML becomes `{data, repeats}`: repeated child elements are rows of a
      repeat (a nested repeat sits inside its parent row), group elements are flattened
      into the surrounding scope (form field names are unique, Task 8), integer/decimal
      answers become numbers, blank elements are omitted.
    * A media part's NAME is the file name the instance refers to; it is mapped to the
      question whose element holds that file name.
    * Every response carries `X-OpenRosa-Version: 1.0`, and every refusal is an
      `OpenRosaResponse` XML body, never JSON.

Not verified against the real ODK Collect app in this phase (see the Task 12 report).
"""

import base64
import binascii
import hashlib
import re
import xml.etree.ElementTree as ET
from datetime import UTC
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.routing import APIRoute
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile

from app.api import auth
from app.api.forms import list_forms
from app.core.clientip import client_ip
from app.core.config import get_settings
from app.core.ratelimit import RateLimited
from app.core.security import dummy_verify, verify_password
from app.db.models import Form, FormVersion, MediaFile, User
from app.db.session import get_session
from app.intake.geopoint import GeopointError, parse_geopoint
from app.intake.submissions import (
    MEDIA_QUESTION_TYPES,
    MAX_MEDIA_PARTS,
    MAX_SUBMISSION_JSON_BYTES,
    IntakeRefused,
    MediaPart,
    SubmissionMeta,
    lenient_dt,
    resolve_form_version,
    store_submission,
    walk_nodes,
)

OPENROSA_VERSION = "1.0"
_RESPONSE_NS = "http://openrosa.org/http/response"
_LIST_NS = "http://openrosa.org/xforms/xformsList"
_NUMBER = re.compile(r"-?\d+")
_BASIC_REALM = 'Basic realm="Evidence Action survey platform", charset="UTF-8"'


class OpenRosaError(Exception):
    """A refusal to send back as an OpenRosaResponse. Carries the HTTP status and headers."""

    def __init__(self, status_code: int, code: str, message: str, headers: dict[str, str] | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.headers = headers or {}


def _xml(root: ET.Element, status: int = 200, headers: dict[str, str] | None = None) -> Response:
    body = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    return Response(content=body, status_code=status, media_type="text/xml", headers=headers)


def _response_doc(text: str, nature: str, **metadata: str) -> ET.Element:
    root = ET.Element("OpenRosaResponse", {"xmlns": _RESPONSE_NS})
    ET.SubElement(root, "message", {"nature": nature}).text = text
    if metadata:
        ET.SubElement(root, "submissionMetadata", metadata)
    return root


def _error_response(e: OpenRosaError) -> Response:
    # The code stays in the text: ODK Collect shows the message to the person holding the phone.
    return _xml(_response_doc(f"{e.code}: {e.message}", "error"), e.status_code, e.headers)


def _from_intake(e: IntakeRefused) -> OpenRosaError:
    return OpenRosaError(e.status_code, e.code, e.detail)


class OpenRosaRoute(APIRoute):
    """Stamps the version header on every response and renders every refusal as OpenRosa XML."""

    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            try:
                response = await original(request)
            except OpenRosaError as e:
                response = _error_response(e)
            except HTTPException as e:  # e.g. Starlette's malformed-multipart 400
                response = _error_response(
                    OpenRosaError(e.status_code, "request_refused", str(e.detail), dict(e.headers or {}))
                )
            response.headers["X-OpenRosa-Version"] = OPENROSA_VERSION
            return response

        return handler


router = APIRouter(prefix="/openrosa", tags=["openrosa"], route_class=OpenRosaRoute)


# ---- HTTP Basic against the same user table ----------------------------------------------


def _challenge(message: str = "Not authenticated") -> OpenRosaError:
    return OpenRosaError(401, "not_authenticated", message, {"WWW-Authenticate": _BASIC_REALM})


def _credentials(header: str | None) -> tuple[str, str] | None:
    if not header:
        return None
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "basic" or not token.strip():
        raise _challenge()
    try:
        decoded = base64.b64decode(token.strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        raise _challenge() from None
    username, sep, password = decoded.partition(":")
    if not sep or not username or len(username) > 150 or len(password) > 1024:
        raise _challenge()
    return username, password


def basic_user(request: Request, db: Session = Depends(get_session)) -> User:
    """The authenticated user, or a 401 challenge. The first request ODK Collect makes has
    no credentials at all; that is the challenge it is waiting for, so it is not counted
    as a failed attempt. Wrong passwords share the login endpoint's rate limiters."""
    creds = _credentials(request.headers.get("authorization"))
    if creds is None:
        raise _challenge()
    username, password = creds
    ip = client_ip(request, get_settings())
    try:
        auth.ip_limiter.check(f"login:ip:{ip}")
        auth.username_limiter.check(f"login:{username}")
    except RateLimited as exc:
        raise OpenRosaError(
            429, "rate_limited", "Too many attempts; try again later", {"Retry-After": str(exc.retry_after)}
        ) from None
    user = db.scalar(select(User).where(User.username == username))
    if user is not None and user.is_active:
        ok = verify_password(password, user.password_hash)
    else:
        ok = dummy_verify(password)  # the same work for an unknown or deactivated account
    if user is None or not user.is_active or not ok:
        raise _challenge("Invalid username or password")
    auth.username_limiter.reset(f"login:{username}")
    auth.ip_limiter.refund(f"login:ip:{ip}")
    return user


# ---- form list and download -----------------------------------------------------------------


@router.get("/formList", response_class=Response)
def form_list(request: Request, user: User = Depends(basic_user), db: Session = Depends(get_session)) -> Response:
    # `list_forms` decides which forms this caller may see (published, and assigned for an
    # enumerator); this only re-shapes that answer, so the two lists cannot disagree.
    visible = {(f.form_id, f.current_version) for f in list_forms(user=user, db=db) if f.current_version}
    root = ET.Element("xforms", {"xmlns": _LIST_NS})
    base = str(request.base_url).rstrip("/")
    if visible:
        rows = db.execute(
            select(Form.form_id, Form.title, FormVersion.version, FormVersion.xform_xml)
            .join(FormVersion, FormVersion.form_id == Form.id)
            .where(FormVersion.is_current.is_(True), FormVersion.published_at.is_not(None))
            .order_by(Form.id)
        ).all()
        for form_id, title, version, xform_xml in rows:
            if (form_id, version) not in visible:
                continue
            x = ET.SubElement(root, "xform")
            ET.SubElement(x, "formID").text = form_id
            ET.SubElement(x, "name").text = title
            ET.SubElement(x, "version").text = version
            ET.SubElement(x, "hash").text = "md5:" + hashlib.md5(xform_xml.encode(), usedforsecurity=False).hexdigest()
            ET.SubElement(x, "downloadUrl").text = f"{base}/openrosa/forms/{quote(form_id, safe='')}/{quote(version, safe='')}.xml"
    return _xml(root)


@router.get("/forms/{form_id}/{version}.xml", response_class=Response)
def download_form(
    form_id: str, version: str, user: User = Depends(basic_user), db: Session = Depends(get_session)
) -> Response:
    try:
        fv = resolve_form_version(db, user, form_id, version)
    except IntakeRefused as e:
        raise _from_intake(e) from None
    if fv.published_at is None:  # never served to a device before it is published
        raise OpenRosaError(404, "form_version_unknown", "Form or version not found")
    return Response(content=fv.xform_xml.encode("utf-8"), media_type="text/xml")


# ---- XML instance -> {data, repeats} ---------------------------------------------------------


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _convert(value: str, qtype: str | None) -> Any:
    if qtype == "integer" and _NUMBER.fullmatch(value):
        return int(value)
    if qtype == "decimal":
        try:
            f = float(value)
        except ValueError:
            return value
        return f if f == f and f not in (float("inf"), float("-inf")) else value
    return value  # anything else, including a non-numeric "integer", is left for validation


def parse_instance(root: ET.Element, spec: dict) -> tuple[dict, dict[str, list[dict]], list[tuple[str, str]]]:
    """(data, repeats, leaves): the same shape the JSON API builds, plus every (question,
    text) pair in the instance, which is how media file names are matched to questions.

    A repeat is any element whose name the spec marks as a repeat; its rows are its
    repeated occurrences, and a nested repeat's rows sit inside the parent row under the
    nested repeat's name. Any other element with children is a group and is flattened.
    A blank element is an unanswered question and is omitted.
    """
    nodes = list(walk_nodes(spec["nodes"]))
    repeat_names = {n["name"] for n in nodes if n["type"] == "repeat"}
    types = {n["name"]: n["type"] for n in nodes}
    leaves: list[tuple[str, str]] = []

    def fill(scope: dict, element: ET.Element, top: bool) -> None:
        for child in element:
            name = _local(child.tag)
            if top and name in ("meta", "start", "end"):
                continue  # form metadata, not answers
            if name in repeat_names:
                row: dict = {}
                fill(row, child, False)
                scope.setdefault(name, []).append(row)
            elif len(child):
                fill(scope, child, False)
            else:
                text = (child.text or "").strip()
                if text:
                    scope[name] = _convert(text, types.get(name))
                    leaves.append((name, text))

    scope: dict = {}
    fill(scope, root, True)
    repeats = {name: scope.pop(name) for name in list(scope) if name in repeat_names}
    return scope, repeats, leaves


def _gps(text: str):
    """An unreadable location is an error, never silently blank columns: blank coordinates
    would read as "no GPS captured" when GPS was in fact captured."""
    try:
        return parse_geopoint(text)
    except GeopointError:
        raise OpenRosaError(
            422, "bad_geopoint", 'A location is not in the form "latitude longitude altitude accuracy"'
        ) from None


def _instance_uuid(root: ET.Element) -> str:
    for meta in root:
        if _local(meta.tag) == "meta":
            for el in meta:
                if _local(el.tag) == "instanceID" and (el.text or "").strip():
                    raw = el.text.strip()
                    return raw[5:] if raw.lower().startswith("uuid:") else raw
    raise OpenRosaError(400, "missing_instance_id", "The submission has no meta/instanceID")


def _top_text(root: ET.Element, name: str) -> str | None:
    for el in root:
        if _local(el.tag) == name:
            return (el.text or "").strip() or None
    return None


def _parse_xml(raw: bytes) -> ET.Element:
    # No DTD at all: ODK Collect never sends one, and entity tricks are never legitimate here.
    head = raw.upper()
    if b"<!DOCTYPE" in head or b"<!ENTITY" in head:
        raise OpenRosaError(400, "malformed_xml", "The submission XML must not contain a DTD")
    try:
        return ET.fromstring(raw)
    except ET.ParseError:
        raise OpenRosaError(400, "malformed_xml", "The submission is not well-formed XML") from None


def _intake(db: Session, user: User, root: ET.Element, files: dict[str, bytes], request: Request):
    form_id, version = root.get("id"), root.get("version")
    if not form_id or not version:
        raise OpenRosaError(400, "missing_form", "The instance needs id and version attributes")
    uuid = _instance_uuid(root)
    try:
        fv = resolve_form_version(db, user, form_id, version, uuid)
        spec = fv.json_spec
        data, repeats, leaves = parse_instance(root, spec)
        slots = {n["name"] for n in walk_nodes(spec["nodes"]) if n["type"] in MEDIA_QUESTION_TYPES}
        by_file: dict[str, str] = {}
        for qname, text in leaves:
            if qname in slots:
                by_file.setdefault(text, qname)
        media: dict[str, MediaPart] = {}
        for filename, content in files.items():
            # A file nothing refers to gets a slot name no question can have, so the intake
            # module refuses it as an unknown slot.
            qname = by_file.get(filename, f"\x00unreferenced:{filename}")
            if qname in media:
                raise OpenRosaError(
                    422, "media_slot_duplicate", "Two files were sent for one question; this endpoint takes one"
                )
            media[qname] = MediaPart(filename, content)
        gps = [
            _gps(text)
            for n in walk_nodes(spec["nodes"]) if n["type"] == "geopoint"
            for qname, text in leaves if qname == n["name"]
        ]
        first = gps[0] if gps else None  # the form's first location answered
        meta = SubmissionMeta(
            gps_lat=first.lat if first else None,
            gps_lon=first.lon if first else None,
            gps_accuracy=first.accuracy if first else None,
            started_at=lenient_dt(_top_text(root, "start")),
            finished_at=lenient_dt(_top_text(root, "end")),
        )
        sub, created = store_submission(db, fv, user, data, repeats, media, uuid, request, meta=meta)
        # The instance names every file it expects. Any slot it names that still has no stored
        # file means more attachments are coming in a later POST.
        expected = {q for q, _ in leaves if q in slots}
        held = set(db.scalars(select(MediaFile.question_name).where(MediaFile.submission_id == sub.id)))
        return sub, created, len(expected - held)
    except IntakeRefused as e:
        raise _from_intake(e) from None


# ---- submission --------------------------------------------------------------------------------


@router.head("/submission", response_class=Response)
def submission_head(user: User = Depends(basic_user)) -> Response:
    limit = MAX_MEDIA_PARTS * get_settings().max_media_bytes + MAX_SUBMISSION_JSON_BYTES
    return Response(status_code=204, headers={"X-OpenRosa-Accept-Content-Length": str(limit)})


@router.post("/submission", response_class=Response)
async def submission_post(
    request: Request, user: User = Depends(basic_user), db: Session = Depends(get_session)
) -> Response:
    cap = get_settings().max_media_bytes
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_MEDIA_PARTS * cap + MAX_SUBMISSION_JSON_BYTES + 65536:
        raise OpenRosaError(413, "request_too_large", "The request is larger than the size limit allows")
    form = await request.form(max_files=MAX_MEDIA_PARTS + 2, max_fields=16, max_part_size=MAX_SUBMISSION_JSON_BYTES)
    try:
        xml_raw: bytes | None = None
        files: dict[str, bytes] = {}
        for key, value in form.multi_items():
            if key == "xml_submission_file":
                if xml_raw is not None:
                    raise OpenRosaError(400, "bad_request", "Send exactly one xml_submission_file part")
                xml_raw = (
                    await value.read(MAX_SUBMISSION_JSON_BYTES + 1)
                    if isinstance(value, UploadFile)
                    else value.encode("utf-8")
                )
                if len(xml_raw) > MAX_SUBMISSION_JSON_BYTES:
                    raise OpenRosaError(413, "request_too_large", "The instance XML is too large")
            elif isinstance(value, UploadFile):
                if not value.filename:
                    raise OpenRosaError(400, "bad_request", "A file part has no file name")
                if value.filename in files:
                    raise OpenRosaError(400, "bad_request", "Two files share one file name")
                files[value.filename] = await value.read(cap + 1)  # one byte over is enough to refuse it
        if xml_raw is None:
            raise OpenRosaError(400, "bad_request", "The xml_submission_file part is missing")
    finally:
        await form.close()
    root = _parse_xml(xml_raw)
    sub, _created, outstanding = await run_in_threadpool(_intake, db, user, root, files, request)
    # 201 when complete, for a replay too: ODK Collect counts only 201/202 as delivered, and a
    # retry must be told it succeeded so the phone stops resending. 202 when the instance names
    # attachments that have not arrived yet: the phone must keep sending, not discard them.
    flagged = sub.status == "flagged"
    text = "Submission received and flagged for review" if flagged else "Submission received"
    if outstanding:
        text += f"; {outstanding} attachment(s) still to be sent"
    doc = _response_doc(
        text,
        "submit_success",
        instanceID=f"uuid:{sub.uuid}",
        submissionDate=sub.received_at.astimezone(UTC).isoformat(),
    )
    return _xml(doc, 202 if outstanding else 201)
