# Survey Platform — Design Spec

**Date:** 30 October 2026
**For:** Evidence Action — Bihar health programme field data collection
**Author:** Dibyendu Chatterjee (with Claude Code)
**Status:** Draft for approval

---

## एक नज़र में (Hindi summary)

SurveyCTO जैसा अपना survey system, खुले **ODK XForms / XLSForm** standard पर।
तीन हिस्से: Python का server, enumerator का offline PWA, और वही PWA का admin console।
XLSForm upload कीजिए → publish → phone पर offline भरिए → network आने पर sync →
console में दिखे → CSV + media अपने आप Google Drive में और एक live Google Sheet में।

**Phase 1** (पहला चलता हुआ version): ऊपर लिखा सब कुछ, तीन roles, audit log।
**Phase 2** (बाद में): form-level end-to-end encryption, drag-drop form designer,
review & correction workflow।

Form-level E2E encryption Phase 1 में **नहीं** है — यह साफ़ लिखा जा रहा है, छिपाया नहीं।

---

## 1. Purpose and context

Evidence Action's Bihar programmes (Anemia Mukt Bihar, IFA/WIFS) collect field data
from ASHA workers, Anganwadi workers and teachers. Today that happens on SurveyCTO,
a paid proprietary service. The goal is a self-hosted system that does the same job:
form design, offline data entry, sync, monitoring, and export — with data under
Evidence Action's own control and exports landing in the user's Google Drive.

### Why ODK XForms, not reverse engineering SurveyCTO

SurveyCTO is itself an implementation of the open **ODK XForms** specification, with
forms authored in **XLSForm** (an Excel convention). ODK Collect, Enketo, pyxform and
JavaRosa are all open-source implementations of the same standard. Building on that
standard gives feature parity by construction, is legally clean, lets existing
XLSForm files run unchanged, and keeps the door open to ODK Collect as a fallback
client. Decompiling SurveyCTO's binaries would be both unnecessary and wrong.

### Success criteria

A supervisor can upload an XLSForm, publish it, hand a phone to an enumerator who
has never seen the system, and that enumerator can fill forms all day with no
network, see them sync when they reach signal, and the supervisor can find the data
as a CSV in Evidence Action's Google Drive the same evening.

### Constraints established with the user

| Decision | Choice |
|---|---|
| Enumerator client | Offline PWA (no Play Store, works on any phone browser) |
| Hosting | Local first, then a cloud VM (India region preferred) |
| Google Drive role | Export target + a live Google Sheet. **Not** primary storage. |
| First working version | 2–3 days: core path end to end |
| Form authoring | XLSForm upload (drag-drop designer deferred to Phase 2) |
| Scale | 50–500 enumerators, a few thousand submissions/day |
| Authentication | Username + password |
| Must-have in Phase 1 | Hindi + English labels, GPS, photo capture, pre-loaded data |
| Build toolchain | **No Node.js.** Plain ES modules, no build step. |

The machine has Python 3.14 and git; Node.js and Docker are not installed and the
network stalls `winget`. The design avoids both.

---

## 2. Architecture

```
survey-platform/
  server/                 Python 3.14 + FastAPI
    app/
      api/                HTTP routes
        auth.py           login, refresh, logout
        forms.py          upload, publish, versions, form spec
        submissions.py    JSON submission API (our PWA)
        openrosa.py       OpenRosa endpoints (ODK Collect compatible)
        exports.py        trigger + download exports
        admin.py          users, roles, audit log
      core/
        config.py         settings from environment, no secrets in repo
        security.py       argon2 hashing, JWT issue/verify
        rbac.py           role checks, enforced server-side
        audit.py          append-only audit log writer
        ratelimit.py      login and submission throttling
        crypto.py         at-rest encryption for media and sensitive columns
      forms/
        xlsform.py        XLSForm (.xlsx) -> XForm XML via pyxform
        compile.py        XForm XML -> compact JSON form spec for the PWA
        validate.py       server-side re-validation of a submission
        expr.py           XPath-subset evaluator (Python twin of the JS one)
      export/
        csv_export.py     main CSV + one child CSV per repeat group
        media.py          media bundle
        drive.py          upload to Google Drive (service account)
        sheets.py         append/refresh a Google Sheet
      db/
        models.py         SQLAlchemy models
        session.py        engine + session factory
      main.py
    migrations/           Alembic
    tests/
  webapp/                 PWA — plain ES modules, served statically
    index.html
    sw.js                 service worker: app shell cache
    js/
      db.js               IndexedDB wrapper (forms, drafts, queue, media, preload)
      expr.js             XPath-subset evaluator (JS twin of expr.py)
      formengine.js       walks the form spec, applies relevant/constraint/calculate
      render.js           renders each question type
      sync.js             upload queue, retry, UUID-based de-duplication
      auth.js             login, token storage, refresh
      i18n.js             Hindi / English label switching
    console/              admin pages (same origin, admin/supervisor only)
  docs/
  README.md
  ARCHITECTURE.md
```

### Technology choices

- **FastAPI + SQLAlchemy + Alembic.** Python is already on the machine. SQLAlchemy
  lets local development run on SQLite and production on PostgreSQL without code
  changes. At 50–500 enumerators production must be PostgreSQL; SQLite is for
  development and tests only, and the README will say so plainly.
- **pyxform** for XLSForm → XForm XML. This is the same library ODK and others use.
- **argon2-cffi** for password hashing, **PyJWT** for tokens, **cryptography** for
  at-rest encryption.
- **google-api-python-client** for Drive and Sheets, authenticated with a service
  account whose key lives in an environment variable, never in the repo.
- **Plain ES modules** in the PWA. No bundler, no npm. The server serves `webapp/`
  as static files.

---

## 3. Form pipeline

An XLSForm upload is converted once, at publish time, into two artifacts stored
against the form version:

1. **XForm XML** — the canonical ODK representation, produced by pyxform. Served at
   the OpenRosa endpoints so ODK Collect can also use this server.
2. **JSON form spec** — a compact tree the PWA reads directly, so the browser never
   parses XML. Produced by walking the pyxform output.

The JSON form spec shape:

```json
{
  "form_id": "amb_asha_visit",
  "version": "2026103001",
  "title": {"en": "ASHA home visit", "hi": "आशा गृह भ्रमण"},
  "languages": ["hi", "en"],
  "default_language": "hi",
  "nodes": [
    {
      "type": "group",
      "name": "identification",
      "label": {"hi": "पहचान", "en": "Identification"},
      "children": [
        {
          "type": "select_one",
          "name": "district",
          "label": {"hi": "ज़िला", "en": "District"},
          "required": true,
          "choices_ref": "districts"
        },
        {
          "type": "select_one",
          "name": "block",
          "label": {"hi": "प्रखंड", "en": "Block"},
          "required": true,
          "choices_ref": "blocks",
          "choice_filter": "district = ${district}"
        },
        {
          "type": "integer",
          "name": "child_age_months",
          "label": {"hi": "बच्चे की उम्र (महीने)", "en": "Child age (months)"},
          "required": true,
          "constraint": ". >= 6 and . <= 59",
          "constraint_message": {"hi": "उम्र 6 से 59 महीने के बीच होनी चाहिए"}
        },
        {
          "type": "select_one",
          "name": "ifa_given",
          "label": {"hi": "आई एफ ए सिरप दिया?", "en": "IFA syrup given?"},
          "relevant": "${child_age_months} >= 6",
          "choices_ref": "yes_no"
        },
        {"type": "geopoint", "name": "gps", "required": true},
        {"type": "image", "name": "register_photo"}
      ]
    },
    {
      "type": "repeat",
      "name": "children",
      "label": {"hi": "बच्चे", "en": "Children"},
      "children": ["..."]
    }
  ],
  "choices": {
    "yes_no": [
      {"value": "1", "label": {"hi": "हाँ", "en": "Yes"}},
      {"value": "0", "label": {"hi": "नहीं", "en": "No"}}
    ]
  }
}
```

### Supported question types (Phase 1)

`text`, `integer`, `decimal`, `date`, `time`, `dateTime`, `select_one`,
`select_multiple`, `geopoint`, `image`, `audio`, `video`, `file`, `barcode`,
`note`, `calculate`, `begin group` / `end group`, `begin repeat` / `end repeat`.

`signature` is an `image` with an `appearance` of `signature` and is rendered as a
drawing canvas.

### Supported column semantics (Phase 1)

`relevant`, `constraint`, `constraint_message`, `required`, `required_message`,
`default`, `appearance`, `choice_filter`, `calculation`, `read_only`, `hint`, and
multi-language `label::hi` / `label::en` columns.

### Expression evaluation

XForms expressions are a restricted XPath dialect. Phase 1 implements a documented
subset, twice — `expr.py` on the server and `expr.js` in the browser — driven from
one shared test-case file (`server/tests/expr_cases.json`) so the two cannot drift.

Supported: `${field}` references, `.` (current value), comparison operators,
`and`/`or`/`not()`, arithmetic, `selected()`, `count()`, `count-selected()`,
`sum()`, `if()`, `string-length()`, `regex()`, `concat()`, `number()`, `int()`,
`today()`, `now()`, `coalesce()`, `position()`, and `indexed-repeat()`.

**An expression the evaluator cannot parse is a publish-time error, not a silent
pass.** Publishing a form that uses an unsupported construct fails with the
expression and the question name in the message. This is deliberate: a skip rule
that silently evaluates to `true` would corrupt field data, which is worse than a
form that refuses to publish.

---

## 4. Offline enumerator app

### Data stored on the device (IndexedDB)

| Store | Contents |
|---|---|
| `forms` | published form specs, by form_id + version |
| `preload` | pre-loaded CSV datasets (districts, blocks, ASHA lists) |
| `drafts` | in-progress submissions, saved on every answer |
| `queue` | finalized submissions awaiting upload |
| `media` | photo/audio blobs, keyed to a queued submission |
| `session` | auth tokens, current user, assigned forms |

### Behaviour

- The service worker caches the app shell, so the app opens with no network.
- On login (online, once) the device downloads its assigned forms and pre-loaded
  datasets. After that an enumerator can work all day offline.
- Every answer writes the draft to IndexedDB immediately. Closing the browser,
  a dead battery or a crash loses nothing.
- Finalizing moves the draft to `queue` with a client-generated UUID.
- Sync runs on `online` events and on a timer, uploading one submission at a time
  with its media. The UUID is the idempotency key: re-sending an already-received
  submission returns the original receipt rather than creating a duplicate.
- Photos are captured through `<input type="file" capture="environment">` and
  downscaled in a canvas before storage, so a day's work does not fill the phone.
- GPS comes from `navigator.geolocation` with accuracy recorded alongside the point;
  the UI waits for an accuracy threshold and lets the enumerator accept a worse fix
  deliberately rather than silently storing a bad one.
- A language toggle in the header switches every label between Hindi and English.

### Form updates

Each form version is immutable. The device checks for new versions when online and
downloads them. A draft started on an older version finishes on that version — it is
never silently migrated — and the submission records the version it was collected on.

---

## 5. Server

### Data model

```
users              id, username, password_hash, role, full_name, phone,
                   is_active, created_at, last_login_at
forms              id, form_id, title, created_by, created_at
form_versions      id, form_id(fk), version, xlsform_blob, xform_xml,
                   json_spec, published_at, published_by, is_current
datasets           id, name, csv_blob, version, updated_at   (pre-load data)
assignments        id, user_id(fk), form_id(fk)              (who may fill what)
submissions        id, uuid(unique), form_version_id(fk), submitted_by(fk),
                   received_at, device_id, started_at, finished_at,
                   status(received|flagged|approved|rejected),
                   data_json, gps_lat, gps_lon, gps_accuracy
repeat_rows        id, submission_id(fk), repeat_name, row_index, data_json
media_files        id, submission_id(fk), question_name, filename,
                   content_type, size, storage_path, sha256
audit_log          id, at, actor_user_id, action, object_type, object_id,
                   ip, user_agent, detail_json        (append-only)
export_jobs        id, form_id(fk), requested_by, requested_at, status,
                   drive_file_id, sheet_id, row_count, error
refresh_tokens     id, user_id(fk), token_hash, issued_at, expires_at,
                   revoked_at, replaced_by
```

### API surface

**Auth** — `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`

**Forms** — `POST /api/forms` (upload XLSForm), `POST /api/forms/{id}/publish`,
`GET /api/forms` (filtered by the caller's assignments),
`GET /api/forms/{id}/versions/{v}/spec`, `GET /api/datasets/{name}`

**Submissions** — `POST /api/submissions` (multipart: JSON + media, idempotent on
UUID), `GET /api/submissions` (filtered, paginated),
`GET /api/submissions/{uuid}`

**Export** — `POST /api/exports` (start a job), `GET /api/exports/{id}`,
`GET /api/exports/{id}/download`

**Admin** — `GET/POST /api/users`, `POST /api/assignments`, `GET /api/audit`

**OpenRosa** (ODK Collect compatibility) — `GET /openrosa/formList`,
`GET /openrosa/forms/{id}/{version}.xml`, `POST /openrosa/submission`

### Server-side re-validation

The server does not trust the client. On submission it re-runs `required`,
`constraint` and `relevant` against the stored form spec using `expr.py`. A
submission that fails is stored with `status = flagged` and the failures recorded —
**never silently dropped.** Field data that reached the server is kept; a supervisor
decides what to do with it.

### Duplicate detection

Two layers. Exact: the UUID unique constraint. Likely: a configurable key per form
(for example `district + block + asha_id + visit_date`); matching submissions are
listed together in the console for a human to judge. The system flags, it does not
delete.

---

## 6. Export to Google Drive

An export job produces, for one form:

- `<form_id>_<timestamp>.csv` — one row per submission, flat fields
- `<form_id>_<repeat_name>_<timestamp>.csv` — one file per repeat group, each row
  carrying the parent submission UUID so the files can be joined
- `<form_id>_media_<timestamp>.zip` — media files, named
  `<submission_uuid>_<question_name>.<ext>`, matching a column in the main CSV

All of it uploads to a configured Google Drive folder using a service account. The
same rows are written to a Google Sheet (cleared and rewritten, so the Sheet is
always the current state and any dashboard pointing at it stays live).

CSVs are UTF-8 with a BOM so Hindi text opens correctly in Excel on Windows.

Phase 1 exports run on demand from the console. Scheduling is Phase 2.

---

## 7. Security

### In Phase 1

| Area | Measure |
|---|---|
| Passwords | argon2id, per-user salt, never logged or returned |
| Sessions | JWT access token (15 min) + rotating refresh token (30 days), refresh reuse revokes the family |
| Authorization | RBAC enforced in the route layer on every request; the UI hides things but the server decides |
| Roles | `admin` (everything), `supervisor` (own forms: publish, view, export), `enumerator` (fill assigned forms, see only own submissions) |
| Input validation | pydantic on every request body; submissions re-validated against the form spec |
| Upload safety | size caps, content-type allow-list, magic-byte check, media stored outside the web root under a generated name |
| Rate limiting | login (per username and per IP), submission (per user) |
| Audit log | append-only; login, publish, export, user change, submission status change, with actor, time, IP |
| Secrets | environment variables only; `.env` in `.gitignore` from the first commit; a `.env.example` with no real values |
| Transport | TLS on deployment (Caddy or nginx with Let's Encrypt); HSTS |
| At rest | media files encrypted with a server key; PostgreSQL volume encryption on the VM |
| Headers | CSP, X-Content-Type-Options, Referrer-Policy, no `unsafe-inline` |
| Dependencies | pinned versions, `pip-audit` in the test run |

### Deferred to Phase 2 — stated plainly

**Form-level end-to-end encryption**, SurveyCTO's flagship feature, is **not in
Phase 1.** Its design is recorded here and in `ARCHITECTURE.md` so Phase 2 can
implement it without redesign:

A form is published with an RSA public key. On the device, the PWA generates a
random AES-256 key per submission, encrypts the submission JSON and each media file
with it (AES-GCM), encrypts that AES key with the form's RSA public key, and uploads
only ciphertext plus the wrapped key. The server stores ciphertext it cannot read.
The private key never leaves the data manager's machine; decryption happens in a
local tool at export time. Browser-side this uses WebCrypto, which is available
offline and needs no library.

Until this lands, the honest statement is: data is protected in transit by TLS and
at rest by server-side encryption, but a server compromise would expose submission
data. That is the same position as SurveyCTO forms with encryption switched off.

### Threat model (summary; full version in `ARCHITECTURE.md`)

- **Lost or stolen phone** — tokens expire; an admin can revoke a user, which kills
  the refresh family. Unsynced drafts on the device are a real exposure; Phase 2
  adds a device passcode gate on IndexedDB.
- **Enumerator submitting data for areas they were not assigned** — assignments are
  checked server-side on submission, not just used to filter the form list.
- **Malicious upload** — XLSForm parsing happens in a worker with size limits;
  media is never served from a path the uploader controls.
- **Credential stuffing** — rate limiting plus argon2id's cost.
- **Insider reading submissions** — Phase 1: audit log makes it visible. Phase 2:
  E2E encryption makes it impossible.

A `security-review` pass runs before delivery and its output is written up verbatim:
what was fixed, what remains open.

---

## 8. Testing

- **Server:** pytest. Unit tests for `expr.py`, `xlsform.py`, `compile.py`,
  `validate.py`, `csv_export.py`, `security.py`, `rbac.py`. Integration tests
  through FastAPI's `TestClient` for the whole path: upload a real XLSForm, publish,
  submit with media, export, and assert the CSV bytes.
- **Expression parity:** `server/tests/expr_cases.json` holds expression, inputs and
  expected result. `expr.py` is tested against it by pytest; `expr.js` is tested
  against the same file by a test page loaded in the browser, whose results are read
  back. Neither implementation may diverge.
- **PWA:** a `webapp/tests/index.html` harness runs the IndexedDB, form-engine, sync
  and i18n tests in a real browser — no Node, no jsdom. Driven and read back through
  the built-in browser.
- **Offline behaviour:** tested by disabling the network in the browser pane mid-run,
  filling a form, re-enabling, and asserting the submission arrives exactly once.
- Development follows test-driven development: the failing test first.

---

## 9. What Phase 1 delivers

XLSForm upload, validation, publish and versioning · all question types listed in
§3 · `relevant`, `constraint`, `required`, `default`, `appearance`, `choice_filter`,
`calculation` · offline PWA with drafts, resume, GPS, photo, pre-loaded data and
Hindi/English · sync queue with duplicate detection · username/password login with
three server-enforced roles · console showing submissions and one submission in
detail · CSV export with child CSVs for repeats, plus media, to Google Drive and a
Google Sheet · append-only audit log · `ARCHITECTURE.md`, `README.md` (with a Hindi
section), tests, and a written security review.

## 10. What Phase 1 does not deliver

Form-level end-to-end encryption · drag-drop form designer · review and correction
workflow (approve/reject/comment on a submission) · device-to-enumerator assignment
and device management · scheduled automatic exports · ODK Collect compatibility
verified against the real ODK Collect app (the endpoints are built, but untested
against the actual client) · SMS/OTP login · a native Android app.

Each of these is a deliberate deferral agreed with the user, not an oversight.

---

## 11. Open questions

None blocking. Two to settle before deployment, not before building:

1. Which cloud provider and India region the production VM will sit in, and who
   owns that account at Evidence Action.
2. Whether Evidence Action's IT policy requires a security review of its own before
   real beneficiary data is collected.
