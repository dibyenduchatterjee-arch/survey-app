# Handover — FINAL architecture (Apps Script + GitHub Pages)

Last saved 31 October 2026. Branch `phase-1`, everything committed.
`RESUME.md`, `RESUME-DRIVE.md` and `RESUME.server-architecture.md` describe earlier plans
that are now superseded. **Read this file first.**

## How we got here — two foundations were blocked by the user's organisation

1. **No self-hosted server.** He has no authority to store data on any server until his IT
   team approves one.
2. **No Google Cloud Platform.** His account is blocked from it entirely, so there is no
   OAuth client id, no API key, no service account and no Picker.

**What is allowed, and confirmed working:** Google **Apps Script** (he already builds web
apps with it) and a free **GitHub** account — `dibyenduchatterjee-arch`.

## The architecture

- **Apps Script Web App is the backend.** Deployed by him, runs as him, writes to his own
  Drive and Sheets. No Cloud project needed.
- **Project access codes are the credential.** His design: a `Projects` tab lists each
  project with its Drive folder, its data spreadsheet, an access code and an Active flag. A
  worker types the code, sees only that project's forms, nothing else. Changing the code or
  clearing Active revokes access immediately.
- **No worker needs a Google account.** The Apps Script talks to Google; their phones do
  not. This also makes the later ASHA and Anganwadi app possible, since those workers
  usually do not know their Google credentials.
- **GitHub Pages hosts the app's static files.** Apps Script serves pages inside a
  sandboxed frame where service workers, and therefore offline mode, do not work — and
  offline is the entire point. GitHub Pages is free, permanent, supports service workers,
  and holds no data: only HTML, JavaScript and CSS. The APK is built from that URL.

Data path: phone (offline queue) to Apps Script Web App to his Drive folder and project
spreadsheet, one tab per form.

## State of the work

| Piece | State |
|---|---|
| Offline app: forms, Hindi, GPS, photos, drafts, queue | Built and verified; unaffected by the pivots |
| Expression evaluator, phone/server parity (409-case corpus) | Built, verified on both sides |
| XLSForm to spec compilation | Built and tested |
| Apps Script download page (dates, district/block, CSV) | Built, 20 logic tests |
| Apps Script API backend (codes, forms, submit) | In flight when saved |
| Phone app wired to the Apps Script API | Not started |
| GitHub Pages hosting and APK | Not started |
| Server version (complete, proven end to end) | Built; kept as fallback if IT ever approves it |

**Test counts at save:** Python 1211 passed, 1 skipped. JavaScript 631 passed. Apps Script
logic 20 passed. Browser in real Chrome 77 passed.

## Next steps, in order

1. Finish the Apps Script API (`task-40-report.md` will hold its request and response shapes).
2. Rewire `webapp/js/` to call that API instead of Google APIs directly: replace Google
   sign-in with **project-code entry**, and point sync at the deployed Web App URL.
3. Publish `webapp/` to GitHub Pages under `dibyenduchatterjee-arch`.
4. Build the APK from that URL with pwabuilder.com — no Android tooling needed here.
5. Live-test the whole chain against his real deployment.
6. Update `README.md` and `ARCHITECTURE.md`; they still describe the server version.

## Rules that must survive any further rework

Each was decided for a reason and cost real effort to get right:

- **A submission that reaches storage is never lost.** Validation failure means stored and
  flagged, never dropped.
- **A retry must not duplicate.** uuid is column 1 of every tab; read it before appending.
  Check-then-append still has a small race — say so, never claim otherwise.
- **A new question must add a column**, never silently drop its answers.
- **The received timestamp is stamped by the script**, never trusted from the phone.
- **Dates are Indian dates.** A 04:00 IST visit falls on the previous day in UTC and would
  vanish from a filter.
- **CSV is UTF-8 with BOM**, or Hindi arrives in Excel as question marks.
- **A half-finished draft stays on the form version it started on.**
- **Hidden questions keep their raw answers; their calculates are cleared.**

## Honest limitations

- **Nothing in the Apps Script architecture has been run against real Google services yet.**
- Apps Script has execution-time and quota limits; behaviour at 76 concurrent collectors is
  taken from Google's documented limits, not measured.
- Form-level end-to-end encryption is not built.
- OpenRosa was never tested against the real ODK Collect app.
- Media questions inside repeat rows share one slot.

## Running things

```
.venv/Scripts/python.exe -m pytest server/tests -W error
```

```
"C:/Users/dibyendu.chatterjee_/AppData/Local/Programs/nodejs/node.exe" --test webapp/tests/
```

```
"C:/Users/dibyendu.chatterjee_/AppData/Local/Programs/nodejs/node.exe" --test appsscript/tests/
```

Browser: `node tools/serve.js 8008`, open `http://127.0.0.1:8008/webapp/tests/browser.html`,
wait for `window.__done`, read `window.__summary`. The service-worker test only passes in
real Chrome.

Decision log, every ruling and why:
`.superpowers/sdd/2026-10-31-survey-platform-phase-1/progress.md` — git-ignored, with a copy
in the side-session notes folder.

## User details

- Drive folder: `1hsOjv7yephXShho0zukL2vmvG8Og2Q_M` ("Survey CTO Type APK"), currently in My Drive
- GitHub: `dibyenduchatterjee-arch`
- Presents this on Monday
