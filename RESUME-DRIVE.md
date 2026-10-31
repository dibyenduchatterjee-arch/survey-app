# Where to pick up — Drive-only architecture

Paused 31 October 2026 (token budget). Everything committed on branch `phase-1`.
`RESUME.md` describes the older **server** architecture and is now the secondary path.

## The architecture changed late on 31 October

The user has **no authority to run a server** until his IT team approves one. The system
moved to **Google Drive only**. The server code still exists and works; it is not the
delivery path right now.

- His Drive holds **one folder per project**; each holds that project's forms.
- **Sharing a project folder with a teammate IS the access control.** Google enforces it.
- Everyone using this app is on his own team and has a Gmail, so **each person signs in as
  themselves**. No credential ships inside the app. (ASHA/AWW workers, who often do not know
  their Google passwords, get a different, simpler app later.)
- He publishes a form from his laptop with `tools/publish_form.py`, which compiles the
  XLSForm and puts the compiled spec in the project's Drive folder.
- The phone app reads forms from Drive, works offline, and appends to **one spreadsheet per
  project, one tab per form**. Photos go to the project folder.

Why not a shared key in the APK: anyone who downloads the app could extract it and wipe the
folder. Per-user sign-in removes that risk entirely.

## State

| Area | State |
|---|---|
| Server (whole system) | Built, **proven end to end** against a real uvicorn server |
| `tools/publish_form.py` | Done, 14 tests, fake Drive only — never run against real Drive |
| Google sign-in (Identity Services) | Done — **never tested with real credentials** |
| Google Picker (folder access) | Done — **never tested in a real browser** |
| `drive.js`, `sync.js` → Drive/Sheets | Done, 631 JS tests, all stubbed |
| `app.js` wired to Google sign-in | Done; renders correctly in Chrome (verified) |
| Offline engine, Hindi, GPS, photo | Done and verified; unchanged by the pivot |
| Hermetic tests + India-date filter | **In flight when paused** |

Proven before the pivot against a real server: admin created; the real `amb_asha_visit.xlsx`
uploaded and published; an enumerator added to a project; she saw only her form and fetched
its spec; submitted a real entry with a photo and two repeat children; a **replay returned
the original receipt with no duplicate**; admin listed exactly one submission.

Counts at pause: Python 1186 passed / 1 skipped / 3 failed (the `.env` defect, being fixed).
JavaScript 631 passed. Browser in real Chrome 77 passed.

## Do these first

1. Finish the in-flight task (`task-38-report.md`): make the suite **hermetic** so a
   developer's `.env` cannot change the result, and bound the export date filter by **India**
   days. A visit at 04:00 IST on 1 Nov is 22:30 UTC on 31 Oct and would silently vanish from
   a "from 1 Nov" filter.
2. **Live-test the Google path** the moment credentials arrive. Nothing in the Drive
   architecture has touched real Google services.
3. Update `README.md`, `ARCHITECTURE.md`, `docs/OPERATIONS.md` — they describe the server
   architecture and are now partly wrong.

## Waiting on the user

- OAuth Client ID, a **restricted** browser API key (Picker API + site only), Cloud project
  number → paste into `webapp/config.js`
- Picker API enabled
- Service-account JSON path for `tools/publish_form.py`
- Project folders inside his Drive folder the programme Drive folder — currently in
  **My Drive**, and a service account has **no storage quota**, so publishing there fails with
  `storageQuotaExceeded`. It needs to be in a **Shared Drive**.

## Limitations — state plainly, never soften

- **Nothing in the Drive architecture has been tested against real Google services.**
- `drive.file` may not let a teammate list a folder merely shared with them; the Picker is the
  intended answer and is **untested with a real second account**.
- Identity Services issues no refresh token, so a long offline stretch forces re-sign-in.
  Queued submissions survive it (tested).
- No server means no database constraint enforcing one submission per record. The app reads
  the sheet's uuid column before appending and writes the uuid as column 1, but
  **check-then-append still has a small race**. Column 1 is the safety net.
- Two phones adding a column to one tab in the same second can leave a row under a clobbered
  header.
- Drafts saved under the old numeric user id will not appear after the Google email login.
- Form-level end-to-end encryption is not built.
- OpenRosa was never tested against the real ODK Collect app.
- Media questions inside repeat rows share one slot.

## Running things

    .venv/Scripts/python.exe -m pytest server/tests -W error
    "C:/Users/dibyendu.chatterjee_/AppData/Local/Programs/nodejs/node.exe" --test webapp/tests/

Browser: `node tools/serve.js 8008`, open `http://127.0.0.1:8008/webapp/tests/browser.html`,
wait for `window.__done`, read `window.__summary`. The service-worker test only passes in
real Chrome.

Full decision log: `.superpowers/sdd/2026-10-31-survey-platform-phase-1/progress.md`
(git-ignored; a copy is in the side-session notes folder).
