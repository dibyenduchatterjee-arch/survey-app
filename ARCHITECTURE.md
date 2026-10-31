# How the survey platform is built

This is the platform Evidence Action field teams use to collect survey data in rural
Bihar, with or without a mobile network. It is an open alternative to SurveyCTO and
reads the same XLSForm files.

This document explains how the pieces fit, why a few important decisions were made,
and what is **not** protected yet. Read the last two sections (Phase 2 encryption and
Threat model) before you put real household data on a server.

Words used here:

- **Enumerator**: the person filling forms in the field (ASHA, AWW, teacher, surveyor).
- **Supervisor / admin**: people who use the console. An admin can do everything. A
  supervisor can upload and publish forms, look at submissions and download CSVs, but
  cannot create users or hand out access.
- **XLSForm**: the Excel file in which a form is written.
- **Submission**: one filled form, with its photos and repeat rows.
- **Version**: each upload of a form is a new, never-edited version.

---

## 1. The pieces

```
  Enumerator's phone                       The server                         Google
 +-----------------------+            +------------------------+        +----------------+
 | Browser app (PWA)     |   HTTPS    |  FastAPI + SQLite/     |        | Drive folder   |
 |  - forms stored on    | <--------> |  PostgreSQL            | -----> | (a Shared      |
 |    the phone          |            |  - login, roles        |        |  Drive) + an   |
 |  - answers saved on   |            |  - form compiler       |        |  optional      |
 |    every change       |            |  - re-validation       |        |  Google Sheet  |
 |  - queue of unsent    |            |  - media on disk,      |        +----------------+
 |    submissions        |            |    encrypted           |
 +-----------------------+            |  - CSV export          |
                                      +------------------------+
 ODK Collect (optional, UNTESTED) ----> /openrosa/...        ^
                                                             |
 Admin console (a web page, laptop) -------------------------+
```

| Piece | Where it lives | What it does |
|---|---|---|
| Server | `server/app/` | Login, who-may-see-what, form upload and compiling, receiving submissions, checking them again, exporting. |
| Browser app | `webapp/` (`index.html`, `js/`) | What the enumerator uses. Installs on an Android phone like an app. Works with no network. |
| Admin console | `webapp/console/` | Web pages for the supervisor: projects and forms, submissions, **Download CSV**, users, audit. |
| Shared test data | `shared/` | The expression test corpus (see section 5). |
| Tests | `server/tests/` (Python), `webapp/tests/` (JavaScript, plus a browser harness) | About 980 Python and 573 JavaScript tests, plus the browser harness. |

### What runs where

- **The web server does not serve the browser app.** `uvicorn` serves only the API. The
  app and console are plain files in `webapp/`, and the browser app calls the API with
  addresses such as `/api/forms` (no domain in front). So the app files and the API must
  be reached **from the same web address**. In practice a reverse proxy (Caddy or
  nginx) serves `webapp/` for everything except `/api/`, `/openrosa/` and `/health`,
  which it hands to the server. `README.md` has a working Caddy file.
  (Putting the app on a different host, such as a static site host, does not work
  unless that host also forwards `/api/` to the server.)
- **CSV download needs Google to be set up.** The server builds the files, puts them in the
  Drive folder, and then the console downloads the main CSV back through the server.
  Without `GOOGLE_SERVICE_ACCOUNT_FILE` and `DRIVE_FOLDER_ID` the Download CSV page
  answers "503, DRIVE_FOLDER_ID is not set". There is no "download without Drive" path.
  The Drive-never-run-for-real caveat in section 9 applies to this.

### The server, module by module

| Folder | Contents |
|---|---|
| `core/` | Settings (`config.py`), password hashing and tokens (`security.py`), role checks (`rbac.py`), the audit log (`audit.py`), the login rate limiter (`ratelimit.py`), photo encryption at rest (`crypto.py`), who may fill which form (`access.py`). |
| `db/` | Database tables (`models.py`) and sessions. The migration is in `server/migrations/`. |
| `forms/` | XLSForm to XForm to a JSON form (`xlsform.py`, `compile.py`), the expression evaluator (`expr.py`), checking a submission (`validate.py`), the automatic fields (`autometa.py`). |
| `intake/` | Receiving a submission: `submissions.py` (the one place a submission is stored), `geopoint.py`, `duplicates.py`. |
| `export/` | CSV building (`csv_export.py`), the photo zip (`media.py`), Google Drive (`drive.py`) and Sheets (`sheets.py`). |
| `api/` | The web addresses: `auth`, `forms`, `submissions`, `openrosa`, `exports`, `admin` (users, projects, assignments, audit). |

Both the phone app and ODK Collect hand the submission to the same function
(`store_submission`), so there is one set of rules for duplicates, validation and
storage, whichever way the data arrives.

---

## 2. The data model

```
 Project 1 ---- N Form 1 ---- N FormVersion (one is "current")
    |                              |
    | N                            | 1
 ProjectMember N -- 1 User         N
                                Submission 1 ---- N RepeatRow
 Assignment (user, form)           |
                                   1 ---- N MediaFile
 AuditLog      ExportJob      RefreshToken      Dataset
```

| Table | What it holds |
|---|---|
| `users` | username, argon2 password hash, role (`admin`, `supervisor`, `enumerator`), name, phone, active flag. |
| `projects` | A named group of forms. A "Default project" exists from the start. |
| `project_members` | **The grant.** A user in a project may fill every form in it, including forms added later. |
| `forms` | One row per form (`form_id` is the name from the XLSForm). Belongs to exactly one project. |
| `form_versions` | Each upload: the original Excel, the XForm XML, the compiled JSON, `published_at`, `is_current`. Never edited after upload. The database allows only one current version per form. |
| `assignments` | The older, finer grant: one user on one form. Still honoured. |
| `submissions` | One row per filled form: `uuid` (unique), form version, who, `received_at` (server clock), device id, device `started_at` and `finished_at`, status, the answers as JSON, validation failures, GPS. |
| `repeat_rows` | One row per repeat-group entry (for example one row per child). Unique on (submission, repeat name, row number). |
| `media_files` | One row per photo, audio or file. Unique on (submission, question). The file itself is on disk, encrypted. |
| `audit_log` | Append-only record of who did what and from which address. |
| `export_jobs` | Each CSV export: status, Drive file id, row count, error text. |
| `refresh_tokens` | Hashes only, never the token itself. |
| `datasets` | CSV lists that forms can use for cascading choices. |

### Projects and who can see what

- A **project** holds one or more forms. About ten programmes means about ten projects.
- **Enumerators** can fill a form if they are a member of its project (or hold a direct
  assignment on that form). Add one person to a project once; every form in it, now and
  later, reaches their phone.
- **Admins** see every form and every project.
- **Supervisors** are intended to see only the forms in projects they belong to, and to
  be refused (with "not found", so that the refusal does not reveal that another
  project's form exists) for anything else. At the time of writing this change was
  being applied (`staff_can_see_form` in `core/access.py` and a new test file
  `server/tests/test_staff_scoping.py`). Until it has landed and its tests pass, treat
  supervisors as able to see every form, as they did in earlier builds.
- Every grant change is written to the audit log.

### Automatic fields

At upload, five fields are added to the end of every form unless the form already has a
question with that name: `_gps`, `_started_at`, `_finished_at`, `_device_id`,
`_submitted_by`. The browser app fills the first four itself and never shows them.
`_submitted_by` is **always overwritten by the server** from the logged-in account, so
a worker cannot send someone else's name. In the CSV they become `_gps_lat`,
`_gps_lon`, `_gps_accuracy`, `_started_at`, `_finished_at`, `_device_id`,
`_submitted_by`. A GPS question you write yourself stays separate. Older versions keep the
form they had (versions are never edited). This records each worker's location on every
form, so the workers should be told.

---

## 3. From Excel to the phone

1. A supervisor uploads the XLSForm in the console (`POST /api/forms`).
2. The server turns it into XForm XML (with the `pyxform` library), then into a JSON
   description that the phone and the server both read.
3. Anything the platform cannot do reliably is **refused at upload, with the name of the
   question**, rather than quietly dropped: an unsupported expression, a calculation
   that depends on itself, duplicate field names, unsupported question types.
   A form that works in ODK Collect and silently misbehaves here would be the worst
   outcome, so the platform says no early.
4. The supervisor reads the compiled questions and publishes. Only published versions
   are ever sent to phones.
5. A phone presses **Refresh forms** (or opens the app with a network) and downloads
   the forms it is allowed to have. A draft already in progress stays on the version it
   started on. Unsent submissions are never touched by a refresh.

---

## 4. The sync protocol, and why a submission cannot be lost or doubled

The phone is offline most of the day. The rule is simple: **a submission is never
deleted from the phone until the server has said it holds it.**

1. When the enumerator finishes a form, the phone creates a random **UUID** for it,
   stores the answers and photos on the phone, and puts it in a queue.
2. When there is a network, the queue is sent one submission at a time
   (`POST /api/submissions`, the answers plus any photos in one request).
3. The server stores the submission, its repeat rows and its media in **one database
   transaction**, then answers.

### The idempotency rule

- The UUID is a **unique column in the database**, not just a check in the code. If two
  copies of the same submission arrive at once, the database lets one in and refuses
  the other.
- A **replay** (the phone sent it, the reply was lost, the phone sends it again) is not
  an error. The server recognises the UUID and returns **the original receipt**: status
  **201** the first time, **200** for a replay. The phone treats both as "delivered" and
  removes it from the queue.
- A replay from the same user that carries photos the server does not yet have **adds
  those photos** (never replaces one). ODK Collect splits a submission with several
  photos across several requests, so this matters.
- On the OpenRosa (ODK Collect) route the server answers **202** while attachments named
  in the form are still missing, and **201** only when everything has arrived, so
  Collect keeps sending the rest.
- The replay check is made before the "is this person still assigned?" check, so that
  taking someone off a project cannot make the server refuse data it already holds.

### What the phone does with each answer

| Server says | Phone does |
|---|---|
| 201 or 200 with the same UUID | Delivered. Remove from the queue. |
| 202, 429, 5xx, no network, timeout | Keep it. Try again later with a growing wait. |
| 401 | Refresh the login once; if that fails, ask for a login. The queue is kept. |
| Any other refusal in the server's own format (for example form unknown, not assigned) | Move to a separate **rejected** store with the reason, so the supervisor can see it. Never deleted silently. |
| A bare 403 or odd reply from a proxy or a hotel Wi-Fi page | Keep it and retry; it says nothing about this submission. |

### Validation on arrival

The server re-checks every answer against the form (required, constraint, hidden
questions, calculations). A submission that fails is **stored and flagged**, never
refused and never corrected: the visit already happened. Raw answers to hidden
questions are kept (they are evidence of an old form version or a form mistake);
calculations under hidden questions are cleared. A failure of type `error` means the
form's own rule could not be evaluated, which is a form problem, not the worker's.

Validation uses the **time on the phone when the form was finished** if it is sensible
(not more than 5 minutes in the future, not more than 30 days old), otherwise the
server's receiving time plus an `error` note. Reason: a visit entered on Monday and
synced on Wednesday must not be flagged for a date that was correct when typed.

### Logins on a bad network

Access tokens last 15 minutes. Refresh tokens last 30 days and **rotate on every use**.
If an old refresh token is used again, the server treats it as stolen and ends that
whole login chain. Two browser tabs refreshing at the same moment are serialised on the
phone (`navigator.locks`) so one cannot trip the other. The cost: if the server rotates
the token and the reply never reaches the phone, the worker has to log in again. Queued
submissions survive that.

---

## 5. Parity: why there are two copies of the validation, and how they are kept equal

The phone has to run the form's rules (skip logic, constraints, calculations) with no
network. The server has to run the same rules again, because it cannot trust a phone.
So the same logic exists **twice**: `server/app/forms/expr.py` and `validate.py` in
Python, `webapp/js/expr.js` and `formengine.js` in JavaScript.

Two copies drift. Suppose the phone accepts an age and the server rejects it: the
enumerator sees a green tick, the visit is synced, and the server flags it. A real
household visit is now "wrong" with nobody in the field able to fix it. The reverse
(phone rejects, server would accept) stops a worker finishing a valid form. Both lose
or damage real visits.

The platform prevents drift with two shared references that both languages must satisfy.

1. **One expression corpus, `shared/expr_cases.json`: 360 cases.** Each case is an
   expression, some answers, a clock, and the expected result. The Python test suite
   and the JavaScript test suite both read this one file, and one test is generated per
   case. Add a case and it runs in both. Expressions the platform deliberately does not
   support are in the file too and **both** sides must refuse them. The rules are in
   `shared/EXPR_CASES.md`. A test pins the size and hash of the file so cases cannot be
   deleted quietly.
2. **A golden-output fixture, `webapp/tests/fixtures/parity_cases.json`.** It records
   what the **server** does (`validate.py`) with a set of whole submissions, using a real
   compiled form (`amb_asha_visit.spec.json`). The JavaScript tests feed the same
   submissions to the phone's form engine and demand identical failures and calculated
   values.

The fixture is only a snapshot, so a **pytest guard** (`server/tests/test_parity_golden.py`)
regenerates it in memory from the live server code, and recompiles the form, then
compares both with the committed files. If anyone changes `validate.py` or the compiler,
the Python suite fails until the fixture is regenerated with

```
.venv\Scripts\python.exe webapp\tests\fixtures\make_parity.py
```

and then the JavaScript suite shows exactly where the phone has fallen behind. Neither
side can change quietly.

Things the work found, which is why this exists: Python read Devanagari digits as numbers
where JavaScript did not; Python printed `1000000000000000.0` where JavaScript printed
the whole number; some regular-expression syntax worked in Python only. All were fixed
and pinned as cases.

What parity does **not** cover: it is verified on the expression subset and on the 11
whole-submission cases in the fixture. A form feature outside those is covered only by
unit tests of each side. Features outside the supported subset are refused at upload.

---

## 6. Photos, files and what is encrypted today

- A photo is shrunk on the phone to fit under one size limit (`MAX_MEDIA_BYTES`, 5 MiB
  by default; the phone learns it from `GET /api/config`). The server refuses anything
  larger.
- The server checks the file's real type from its first bytes, against what the question
  allows.
- The file is stored on disk under `server/media/<submission-uuid>/<number>.<ext>`
  (the question name is deliberately not in the path), **encrypted with AES-256-GCM** using a
  key derived from `MEDIA_KEY`.
- **The answers themselves (the JSON of what was typed) are not encrypted in the
  database.** Only photos and other files are encrypted at rest.
- The key `MEDIA_KEY` lives in the server's settings. Anyone who can read the server's
  settings and disk can read the photos. See the threat model.

---

## 7. Export

`POST /api/exports` starts a background job for one form. It builds:

- the main CSV (one row per submission) and one CSV for each repeat group (one row per
  entry, with a link back to the submission);
- a zip of the decrypted photos, named `<form_id>_media_<time>.zip`;
- `export_errors.txt` for anything that could not be exported.

These go to the Drive folder, and the main CSV is also refreshed into a Google Sheet tab
named exactly like the form id (if `GOOGLE_SHEET_ID` is set). The console's **Download
CSV** then fetches the main CSV **through the server**, so the person needs a login and
an allowed role; a Drive link is shown as information only.

Choices made on purpose:

- One damaged or missing photo, or one bad GPS value, **never fails the export**. It is
  skipped, listed in `export_errors.txt`, and the CSV cell keeps the name the photo
  should have had.
- The CSV is UTF-8 with a byte-order mark, so Hindi opens correctly in Excel.
- `_submitted_by` is the username, not a number.
- The repeat-group CSVs and the photo zip are in Drive only; the console downloads the
  main CSV.
- The photo zip in Drive is **not encrypted**. See the threat model.

---

## 8. Phase 2: end-to-end encryption (designed, not built)

**This is a design so it can be built without a rethink. None of it exists yet.**

The goal: a server (or Drive) breach must not reveal submissions. Only the data manager,
on their own machine, can read them.

### Keys

- Each **form** gets an **RSA key pair** (RSA-3072 or 4096, OAEP with SHA-256), made on the
  data manager's computer by a local tool, not on the server.
- The **public key** is uploaded with the form and sent to phones with the form.
- The **private key never leaves the data manager's machine.** It is kept in a file
  protected by a passphrase, with an offline backup (two copies, in two places). Losing it
  means losing every submission for that form. This must be said loudly in the tool.

### On the phone (WebCrypto)

For each submission, using only the browser's built-in `crypto.subtle`:

1. Make a random **AES-256 key** (`generateKey`, AES-GCM).
2. Encrypt the **answers** (the JSON) with that key and a fresh random 96-bit nonce.
3. Encrypt **each photo and file** with the same key, each with its own fresh nonce.
4. **Wrap** the AES key with the form's public key (RSA-OAEP). Only this wrapped key can
   unlock the data, and only the private key can unwrap it.
5. Send: `{uuid, form_id, version, key_fingerprint, wrapped_key, encrypted_answers,
   nonce}` and the encrypted files. Encrypt first, queue second: unsent data on the
   phone is also protected, not only data in transit.

Bind each ciphertext to its submission by passing the submission UUID and form version as
**additional authenticated data** to AES-GCM, so the server cannot swap one encrypted file
into another submission.

### On the server

- Stores ciphertext as received. Keeps the **idempotency rule unchanged** (the UUID stays
  in the clear).
- **Cannot** read answers, so it **cannot re-validate** them. Server-side validation moves
  to the data manager's local tool, run at export time; the phone's own validation (section
  5) still runs before encryption. A flagged submission therefore appears at export, not on arrival.
- Metadata the server still needs stays in the clear: UUID, form, version, who submitted,
  when received, and the key fingerprint. Nothing about the answers.
- `_submitted_by` and the server clock are the only things the server contributes; it
  records them beside the ciphertext, not inside it.
- Supports **key versions**: a form can have a new key pair for new submissions, while old
  submissions name the fingerprint of the key that locked them.

### At export time: a local tool

A small program the data manager runs on their own computer:

1. Downloads the encrypted submissions and files from the server (login required).
2. Reads the private key (asks for the passphrase).
3. For each submission: unwrap the AES key with the private key, decrypt the answers and
   files (AES-GCM refuses anything that was tampered with).
4. Re-runs the validation logic on the answers (the Python evaluator already exists).
5. Writes the CSVs and the photo folder **on that machine**.

**Google Drive then holds nothing readable unless the data manager chooses to upload the
decrypted output.** The server-side "Download CSV" and Drive export are replaced for
encrypted forms by this tool.

### What it costs

- The console can no longer show answers or photos, and server-side duplicate detection by
  answer content stops working.
- A lost private key is unrecoverable.
- Each form's key must be distributed correctly: a public key swapped by an attacker
  who controls the server would let them read new submissions. The fingerprint should be
  shown to the data manager and checked once, outside the server.
- Phase 2 must also decide: encrypted forms alongside ordinary ones (recommended: a
  per-form switch), and how OpenRosa clients are handled (ODK Collect has its own
  encryption scheme, which can be adopted for those forms).

---

## 9. Threat model

### What is protected today

| Risk | Protection |
|---|---|
| Stealing a password | Passwords stored with argon2id. A login with the wrong password takes about as long as one with the right password. |
| Guessing passwords | A limit on failed logins per username (5 in 15 minutes) and per address (60 in 15 minutes). Failures only are counted. |
| Forged login | Tokens are signed with `JWT_SECRET`, which must be 32+ characters or the server will not start. |
| An enumerator reading other projects | Roles are checked **on the server**, on every request, from the database (so a demotion applies at once). Grants are per project. |
| Altering the record | The audit log is append-only by discipline and by a test; the API never edits or deletes it. |
| Stolen disk, with only the media folder | Photos are encrypted (AES-GCM). |
| Someone removing a worker's grant | Takes effect on the next request. |
| A lost phone | Login can be ended from the console (deactivate user). Queued data on the phone is still readable by whoever holds the unlocked phone; use the phone's own screen lock. |
| Reading the app's files over the web | The dev file server serves only `webapp/` and `shared/`; a production proxy should do the same. |

### What is **not** protected

> **Without form-level end-to-end encryption, a server compromise exposes submission data.**
> The answers are readable in the database. The key that decrypts the photos is in the
> server's settings next to the photos. Anyone who gets into the server gets names, GPS
> locations, answers and photographs. This is the **same position as a SurveyCTO form with
> encryption switched off**. Phase 2 (section 8) is what changes it.

Other exposures:

- **Google Drive holds readable exports.** The CSVs and the photo zip in the Drive folder
  are not encrypted. Whoever can open the Shared Drive can read them. Keep the Shared Drive
  to named people only, and never use a "anyone with the link" share.
- **The service-account key** (a JSON file on the server) can read and write that Shared
  Drive. Keep it outside the project folder and out of version control.
- **`MEDIA_KEY` and `JWT_SECRET`** in `.env` are the crown jewels of the server. Anyone
  holding `JWT_SECRET` can mint a login for any user.
- **Backups** contain the database (readable answers) and the media (encrypted, but the key
  is in `.env`). Protect backups as carefully as the server.
- **The login limiter is in the server's memory** and does not span several server
  processes. Run one worker process, or accept weaker limits.
- **A busy lock-out lever:** someone who knows a username can lock that account for 15
  minutes by failing five logins. There is no unlock button yet.
- **Every admin and (until the scoping change lands) every supervisor can read all forms.**
- **Rotating `MEDIA_KEY`** needs a re-encryption step (see `docs/OPERATIONS.md`) or old
  photos become unreadable.
- **The platform has not had a security review by an outside person.**

---

## 10. Known limits

These are the real limits of what was built. They are repeated in `README.md` and
`RESUME.md`.

**Not done or not supported**

- **Form-level end-to-end encryption is not built** (section 8).
- **`pulldata`-style lookups** from external data files are not supported. Cascading
  choices through `choice_filter` on the form's own choices list work.
- **`repeat_count` is not enforced** (on phone or server). A repeat can have any number of rows.
- **Media questions inside a repeat row share one slot**: two photo questions in the same
  repeat, or one in several rows, do not each get their own file.
- **Setting a default with `setvalue`, computed `required`/`readonly`, and some question
  types (for example `geotrace`) are refused at upload.**
- A token refresh whose reply is lost forces the worker to log in again. Queued data is
  kept.
- Supervisor project scoping was being applied when this was written (section 2).

**Never tested against the real thing**

- **The OpenRosa endpoints (ODK Collect) have never been tested against the real ODK
  Collect app.** They follow the protocol and have tests, nothing more. Do not promise
  workers that Collect works until someone has tried it on a phone.
- **The Google Drive export has never been run against real Google credentials.** It has
  only been run against a fake client in tests. The first live run may reveal problems;
  the best-known one is the Shared Drive requirement (README, "Google setup").
- The only live check of Google so far was done by hand through a personal connector
  (reading and writing a Sheet and the folder), not through this server code.

**Verified**

- The offline capability (service worker) **is verified in real Chrome**: it registers,
  reaches the activated state, caches the app files, and the browser harness passes 54 of 54,
  including the test that opens the app with the network disabled. It cannot be exercised in the embedded browser used during
  development: anyone running the harness *there* sees one failure,
  `test_the_app_shell_loads_with_the_network_disabled`, which is a limit of that browser,
  not a fault in the app. Phones were not part of that check; try on a real
  Android phone before the first rollout.
