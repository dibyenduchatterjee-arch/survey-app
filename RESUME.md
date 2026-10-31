# Where to pick up

Paused 31 October 2026 during a network outage. Everything is committed on branch
`phase-1`. The last good commit is `a7cc732`; `fe5ec02` is a checkpoint holding
in-flight work and **contains known-failing tests**.

## What works today

| Area | State |
|---|---|
| Config, database models, migrations | Done, reviewed |
| Password hashing, tokens, login, refresh rotation, rate limiting | Done, reviewed |
| Role enforcement, audit log | Done, reviewed |
| XForm expression evaluator (Python **and** JavaScript, verified at parity) | Done, reviewed |
| XLSForm → XForm XML → JSON form spec | Done, reviewed |
| Form upload, publish, versioning, datasets | Done, reviewed |
| Server-side submission re-validation | Done, reviewed |
| Submission intake, media, encryption, idempotency, duplicates | Done, reviewed |
| OpenRosa endpoints (ODK Collect) | Done, reviewed — **never tested against the real ODK Collect app** |
| CSV export, child files for repeats, media zip | Done, reviewed |
| Google Drive + Sheets export, export job API | Done — **never run against real Google credentials** |
| User, assignment and audit administration | Done |
| Offline storage (IndexedDB) | Done, reviewed, verified in a real browser |
| Form engine and i18n | Done, reviewed |
| Auth, sync queue, service worker | Done, reviewed |
| Question renderers, GPS, photo | Built, **mid-fix** |
| Admin console and CSV download page | **Partially built** |
| End-to-end test and documentation | **Partially built** |
| Security review | Not started |

Roughly 1,000 tests pass across the Python and JavaScript suites, minus the
known failures below.

## Finish these first

1. **A failing render test and a stalling harness.** `test_a_photo_taken_in_the_form_is_downscaled_and_kept_for_upload` fails, and the browser harness then stops at ~24 results without setting `window.__done`. The stall matters as much as the failure: the harness is how every browser task is verified, so it must always reach `__done` and record a throwing or hanging test as a failure.
2. **`app.js` reads the wrong config path.** `bootstrap()` returns `{forms, datasets, config, errors}`, so the value is at `result.config.max_media_bytes`. `app.js` still reads `result.max_media_bytes`. Without this the phone downscales photos to a guessed size and the server may reject them.
3. **Photo blobs are rewritten on every keystroke** when a draft saves. On the cheap Androids these workers carry that will feel like a freeze. Save answers every time; write blobs only when they change.
4. **Finish Task 21** (console + CSV download) and **Task 22** (end-to-end test, docs, the config path fix below).
5. **Then Task 23**, the security review.

## A deployment blocker, not yet fixed

`DATABASE_URL` defaults to `sqlite:///./server/survey.db`, which is relative to the
**process working directory**. Start the server from `server/` and it dies with
`unable to open database file`. `env_file=".env"` has the same problem. Resolve both
against the project root, or require `DATABASE_URL` with an actionable error.

## Agreed but not yet built

- **Projects.** A project holds 1–N forms; sharing a project grants all of them at once. Today assignments are per form, which does not scale to ten projects.
- **Automatic metadata on every form** — GPS, start time, end time, device id, submitted-by — injected at publish time whether or not the XLSForm declares them.
- **A "Refresh forms" control** on the app's home screen. `bootstrap()` already does the work; the button is missing. Two protections must hold: a half-finished draft stays on the version it started on, and a refresh never touches unsent submissions.

## Waiting on the user

- A **Google service-account JSON** (Drive + Sheets APIs enabled).
- The Drive folder **moved into a Shared Drive**, with the service account added as a Content manager. A service account has no storage quota, so uploading into a personal My Drive fails with `storageQuotaExceeded`. The folder is currently in My Drive and the live export **will** fail until this is done.
- A **hosting choice** for the server.

## Known limitations — state these plainly, never soften them

- **Form-level end-to-end encryption is not built.** A server compromise would expose submission data. This is the same position as a SurveyCTO form with encryption switched off.
- The OpenRosa endpoints have **never been tested against the real ODK Collect app**.
- `pulldata`-style external dataset lookups are not supported.
- `repeat_count` is not enforced.
- A token refresh whose reply is lost forces a re-login. Queued data survives.
- Media questions inside repeat rows share one slot.
- The rate limiter is in-process and does not span worker processes.

## How to run things

```
.venv/Scripts/python.exe -m pytest server/tests -W error
```

```
"C:/Users/dibyendu.chatterjee_/AppData/Local/Programs/nodejs/node.exe" --test webapp/tests/
```

Browser tests: run `node tools/serve.js 8008`, open
`http://127.0.0.1:8008/webapp/tests/browser.html`, wait for `window.__done`, read
`window.__summary`.

The full decision log — every ruling made during the build and why — is in
`.superpowers/sdd/2026-10-31-survey-platform-phase-1/progress.md`. It is git-ignored
scratch, so copy it somewhere safe if the folder is ever cleaned.
