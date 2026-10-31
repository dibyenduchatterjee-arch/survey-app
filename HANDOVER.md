# Handover — FINAL architecture (Apps Script + GitHub Pages)

Last saved 31 October 2026. Branch `phase-1`, everything committed.
`RESUME.md`, `RESUME-DRIVE.md` and `RESUME.server-architecture.md` describe earlier plans
that are now superseded. **Read this file first.**

## How we got here — the two constraints this design is built around

1. **No self-hosted server.** Programme data stays inside the organisation's own Google
   Drive; nothing is stored on a server we run.
2. **No Google Cloud Platform project.** So there is no OAuth client id, no API key, no
   service account and no Picker to depend on.

**What the design uses instead:** Google **Apps Script**, deployed and owned by the
programme team, and free static hosting on **GitHub Pages**.

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
| Apps Script API backend (codes, forms, submit) | Built, 82 logic tests |
| Phone app wired to the Apps Script API | Built; waiting only on the owner's `/exec` URL |
| GitHub Pages hosting | Live at https://dibyenduchatterjee-arch.github.io/survey-app/ |
| Android APK | Built and signed: `dist/EvAc-Survey-v1.0.apk`, v2+v3, verified |
| Security review of this architecture | `docs/SECURITY-REVIEW-APPSSCRIPT.md`; I1, I3, I4 fixed |
| Server version (complete, proven end to end) | Built; kept as the production path if IT ever approves one |

**Test counts:** Python 1211 passed, 1 skipped. JavaScript 659 passed. Apps Script
logic 82 passed. Browser in real Chrome 77 passed.

## Next steps, in order

1. **The owner runs `SETUP-MONDAY.md`** — control Sheet, Apps Script, projects, people,
   deploy — and sends back the Web App `/exec` URL.
2. Put that URL in `webapp/config.js` and republish. Phones already carrying the app pick
   it up on their own: `config.js` is fetched network-first.
3. **Live-test the whole chain against the real deployment.** Nothing in this architecture
   has been run against real Google services yet; that is the one remaining unknown.
4. Publish `dist/assetlinks.json` at the root of the Pages domain so the app loses its
   address bar — see `dist/APK-NOTES.md`.
5. Work through the remaining findings in `docs/SECURITY-REVIEW-APPSSCRIPT.md`: I2, I5, I6,
   I7 and the eight Minor ones.
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

## Deployment details

- The Apps Script Web App and the Drive folder it writes to are configured by the owner;
  their ids live in the Sheet, never in this repository. See `SETUP-MONDAY.md`.
- The **server version is the production path** if the organisation later wants one —
  already built, proven end to end and security-reviewed. It is not wasted work.
