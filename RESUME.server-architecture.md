# Where to pick up

Updated 31 October 2026, branch `phase-1`. All of Phase 1 is built. What is left is
proving it against the real world (Google, ODK Collect, a real phone), choosing hosting,
and Phase 2 (end-to-end encryption).

Start with `README.md` (set up and run), `docs/OPERATIONS.md` (backups, failures), and
`ARCHITECTURE.md` (how it works, the Phase 2 design, the threat model).

## What works today

About 980 Python tests and 573 JavaScript tests pass, plus the browser harness
(54 of 54 in real Chrome).

| Area | State |
|---|---|
| Config, database, migration (one initial migration, edited in place; nothing deployed) | Done |
| Passwords (argon2), logins, rotating refresh tokens with reuse detection, rate limiting | Done |
| Roles enforced on the server, append-only audit log | Done |
| Expression evaluator in Python **and** JavaScript, one 360-case shared corpus | Done, at parity |
| Form engine parity: golden fixture, with a pytest guard that fails if it goes stale | Done |
| XLSForm to XForm to JSON; unsupported features refused at upload with the question named | Done |
| Form upload, publish, versions, datasets | Done |
| Server re-validation of every submission (flag, never refuse) | Done |
| Submission intake: media encrypted on disk, UUID idempotency, duplicate reporting | Done |
| OpenRosa endpoints for ODK Collect | Built; **never tested against the real ODK Collect app** |
| CSV export, repeat-group CSVs, photo zip | Done |
| Google Drive and Sheets export | Built; **never run against real Google credentials** (fake client only) |
| Console download: streamed through our server, login and role required | Done (needs Google configured) |
| Users, assignments, audit administration | Done |
| **Projects**: add a user to a project, get every form in it, now and later | Done on the server; **no console screen yet** (see below) |
| **Automatic metadata** (`_gps`, `_started_at`, `_finished_at`, `_device_id`, `_submitted_by`) on every form | Done |
| Browser app: offline storage, form engine, renderers, GPS and photo capture, auth, sync queue | Done |
| "Refresh forms" button, with honest messages; drafts and unsent data untouched | Done |
| Service worker (offline app shell) | **Verified in real Chrome**: registers, activates, caches the shell, harness 54/54 including the offline test. It cannot run in the embedded test browser, so that one test fails there; that is the browser, not the app. Not yet tried on a real Android phone. |
| Admin console | Done: forms, submissions, exports, users, audit. Its home page lists **forms**, not projects. |
| First-admin creation, key rotation | Documented scripts (`README.md`, `docs/OPERATIONS.md`); they are not part of the code base |
| Documentation | Done (this set) |
| Security review (Task 23) | **Not started** |

## In flight when this was written

- **Supervisor scoping.** Intended: a supervisor sees only forms in projects they belong
  to; an admin sees everything; a refusal reveals nothing about another project's form.
  Edits to `server/app/core/access.py`, `api/admin.py`, `api/exports.py`, `api/forms.py`,
  `api/submissions.py` and a new `server/tests/test_staff_scoping.py` were uncommitted. Until
  that is committed with its tests passing, **do not claim it works.** The docs describe it
  as the intended behaviour.

## What the user still has to do

1. **Move the Drive folder into a Shared Drive** and add the service account as a Content
   manager. The folder is in a personal My Drive now. A service account has no storage quota,
   so the first live export **will fail** with `storageQuotaExceeded` until this is done.
2. Create a Google Cloud **service account key** (Drive and Sheets APIs on) and set
   `GOOGLE_SERVICE_ACCOUNT_FILE`, `DRIVE_FOLDER_ID` (and optionally `GOOGLE_SHEET_ID`).
3. **Choose hosting.** Not decided. The browser app calls `/api/...` on its own address, so the
   app files and the API must be served from one address by a reverse proxy
   (`README.md`, section 6). A separate static host will not work unless it forwards `/api/`.
4. Make the first admin: `.\.venv\Scripts\python.exe tools\create_admin.py create-admin --username X [--full-name "..."]`
   (asks for the password twice, hidden). Then the projects. Add every supervisor to a project: a supervisor
   in no project gets a 422 on form upload.

## Next steps, in order

1. Land and check the **supervisor scoping** change; rerun both suites.
2. **First live Google run.** Expect to fix something. Read `docs/OPERATIONS.md`, *When an export fails*.
3. **Console screens for projects** (create, move forms in, add members). Today this takes
   API commands (`README.md`, section 5). The console's Users page still assigns per form.
4. Turn the first-admin script into a proper command in the code base; same for key rotation.
5. **Security review** (Task 23).
6. Deploy behind TLS, with the proxy upload limit, `TRUST_PROXY_HEADERS` and one worker
   (`docs/OPERATIONS.md`). Try the app installed on a real Android phone, offline.
7. Try **ODK Collect** against the OpenRosa endpoints before telling anyone it works.
8. Decide **SQLite or PostgreSQL** before real data. PostgreSQL is untried and there is no
   row-copy tool.
9. **Phase 2: end-to-end encryption**; the design is complete in `ARCHITECTURE.md`, section 8.
10. Small tidy-ups: a clean-up for export jobs stuck at "running" after a restart; a way to
    empty the phone's rejected store; split `requirements.txt` into runtime and development lists;
    an unlock for a locked-out username.

## Known limits, stated plainly

- **Form-level end-to-end encryption is not built.** A server compromise exposes submission
  data. This is the same position as a SurveyCTO form with encryption switched off. Photos are
  encrypted on disk, but their key is on the same server, and answers and Drive exports are not
  encrypted.
- The OpenRosa endpoints have **never been tested against the real ODK Collect app**.
- The Google Drive export has **never been run against real Google credentials**.
- `pulldata`-style external dataset lookups are not supported.
- `repeat_count` is not enforced.
- A token refresh whose reply is lost forces a re-login. Queued data survives.
- Media questions inside repeat rows share one slot.
- The login rate limiter is in one process and does not span several workers.
- The phone's rejected store is never purged.
- The service worker is verified in Chrome, not in the embedded test browser.

## How to run things

```
.venv/Scripts/python.exe -m pytest server/tests -W error
```

```
"C:/Users/dibyendu.chatterjee_/AppData/Local/Programs/nodejs/node.exe" --test webapp/tests/
```

Browser tests: run `node tools/serve.js 8008`, open
`http://127.0.0.1:8008/webapp/tests/browser.html` in Chrome, wait for `window.__done`, read
`window.__summary`.

If you change `validate.py` or the form compiler, the Python suite fails until you regenerate
the parity fixture: `.venv/Scripts/python.exe webapp/tests/fixtures/make_parity.py`. Then the
JavaScript suite shows where the phone has drifted.

The full decision log, with every ruling made during the build and why, is in
`.superpowers/sdd/2026-10-31-survey-platform-phase-1/progress.md`. It is git-ignored scratch,
so copy it somewhere safe if the folder is ever cleaned.
