# Security review - Apps Script architecture (Evidence Action survey platform)

Reviewed 31 October 2026, branch `phase-1`, read-only (no code was changed).
This covers the **Apps Script + GitHub Pages** design. The earlier `docs/SECURITY-REVIEW.md` covers the
server version and is untouched; none of its findings or its "done" list carries over.

## How to read this, in one paragraph

Nobody on the internet can read, change or list anything without a valid access code - that part is
genuinely sound and is tested. The real risks are not "someone hacks the URL". They are: (1) anyone can
cheaply **stop real people from logging in** (availability, not data theft); (2) the design's strength
depends on **how the sheets are filled in** (codes chosen by hand, two projects pointed at one
spreadsheet) because the code does not enforce it; (3) the **GitHub account and the public repo** are
now the root of trust for what runs on every phone, and the repo currently says things you may not want
public on the eve of a presentation; (4) data **on the phone** is not protected if the phone is lost.
Counts: **Critical 0, Important 7, Minor 8.**

What I did: read `Backend.gs` and `Code.gs` line by line (every entry point), `Page.html` sinks,
`webapp/js/projects.js`, `sync.js`, `db.js`, `app.js`, `sw.js`, `index.html`, `config.js`, the git
history and tracked-file list; grepped all of `webapp/js` for DOM/eval sinks; ran
`node --test appsscript/tests/` (74 pass) and `webapp/tests/projects.test.js`, `sync.test.js` (59 pass).
What I could not do is listed at the end - mainly, nothing here was run against real Google services.

---

## 1. Done - controls that are in place

| # | Control | Where it is / what shows it |
|---|---|---|
| D1 | **No data or listing without a code.** Only three actions exist (`open`, `forms`, `submit`); anything else is `bad_request`. `forms` and `submit` require a token that is re-checked against the People and Projects tabs on every call. | `Backend.gs` `dispatch` 583-595, `authorise_` 501-504, `doForms_` 525, `doSubmit_` 532. Tests: "submit with a bad or revoked token writes nothing", "expired, tampered, missing and foreign tokens are all session". |
| D2 | **No difference between a wrong code, an unknown code, a switched-off person, and a person whose project is missing** - same message, same shape, same counter. Inactive people and unresolvable projects are skipped *before* any hashing, so timing does not separate them from an unknown code either. The only timing difference is "valid active code" (about 300 hashes), which is the case that logs in anyway. | `findPerson` 232-247 (`!p.active` and `!project` skip before `verifyCode`), `refused_()` 317. Test: "wrong code, unknown code, blank code and inactive person are refused identically". |
| D3 | **Project is never chosen by the caller.** The request carries no project name, folder id or spreadsheet id. The project comes from the token, which comes from the person's People row. Folder id and spreadsheet id are read only from the Projects tab (owner-controlled) and the folder id never leaves the script (clients get a hashed `project_id`). | `doForms_` / `doSubmit_` use `auth.project` only; `projectIdOf_` 183. Tests: "forms: a token returns only its own project specs", "open and forms return a stable project_id ... does not leak the folder id". |
| D4 | **Tokens are properly signed and revocable.** HMAC-SHA256 with a secret that lives in Script Properties; constant-time compare; 6 h expiry; bound to the person and to the first 12 hex of their stored hash, so changing a code or setting Active to no ends the session on the very next call. | `signToken_` 255, `verifyToken_` 262-279. Tests: "setting a person to Active no, or changing their code, ends their session at once". |
| D5 | **A plain-text code cell never logs anybody in.** `parseStored_` accepts only the `sha256$...` format; a code typed straight into the sheet is simply unusable until hashed, and `projectProblems` says so. A safe failure mode if the `onEdit` safety net does not fire. | `parseStored_` 85-89; test "a plain-text cell never verifies". |
| D6 | **`_submitted_by` cannot be forged by the phone.** The three stamp columns are dropped from every incoming row before anything is written, then stamped server-side from the person row behind the token. The received time is the script clock. | `validateSubmission` 385 (`continue` on `STAMP_COLS`), `makeStamps_` 489-495, `planTab` 482. Tests: "submitted_by comes from the code: the phone cannot claim another name", "received timestamp is the script clock". |
| D7 | **Nothing is ever overwritten or deleted.** Writes are append-only; existing headers are kept exactly and new columns go at the right-hand end; if a tab's first columns were rearranged by hand the write is refused (`layout_mismatch`), not forced. No delete path exists (a test greps the source). A row cannot be attached to another person's submission: repeat rows must carry `parent_uuid` equal to the submission's own uuid. | `planTab` 461-487, `planColumns` 445, `validateSubmission` 397-398; tests "columns are never reordered or removed", "a repeat row whose parent_uuid is another submission is refused", "nothing in the API deletes". |
| D8 | **Retries do not duplicate, and a half-written submission completes.** uuid is checked under the script lock, repeat tabs are written first and the main row last (its presence proves the rest landed), photos are found by name on replay. | `doSubmit_` 552-579, `savePhoto` 711-717; tests "half-finished submission ... completes without repeating rows", "after a failed write the same submission can be sent again and lands once". The check-then-append race is closed by `LockService` (25 s, then `busy`/retry), not just narrowed. |
| D9 | **A quota or Google outage does not lose data on the phone.** Google's quota page is HTML, not JSON; the client treats any non-JSON reply, `busy`, `server_error`, `too_many_attempts` and any expired session as "keep it queued, retry with jitter". A submission leaves the queue only on `created`/`duplicate`, or after a full copy (answers and photos) is written to the on-phone rejected store. | `projects.js` 77-82, `sync.js` 76-79, 323-350. Tests in `sync.test.js`. See M5 for the one gap. |
| D10 | **Formula injection into the sheet is blocked at source, and again at download.** Rows are written into a range set to plain text first; column names starting `= + - @` are refused. The download page prefixes risky cells with an apostrophe in the CSV. | `writeTab` 700-707, `validColumn_` 340-343, `Code.gs` `csvCell_` 247-259. (Plain-text behaviour confirmed only by fake in tests - see Not verified.) |
| D11 | **Input is bounded before use.** Body 10 M chars, 20 tabs, 500 rows, 300 columns, 20 000 chars per cell, 20 photos, base64 charset check, tab names `[A-Za-z0-9_-]` and not `Projects`/`People` (case-insensitive), photo MIME allow-list, photo filenames sanitised (no path tricks), uuid pattern. | `validateSubmission` 355-427, `validTabName_` 336. |
| D12 | **Error replies leak no internals.** Every failure is a fixed sentence; the stack goes to the owner's log only. | `dispatch` 590-594, `doPost` 742-745. Test "an unexpected failure is a retryable server_error that leaks no internals". |
| D13 | **No cookie-based authority, so no CSRF.** The API is called with a body credential, not a Google cookie. The wide-open CORS that Apps Script gives is therefore harmless: another website calling the URL gets exactly what an anonymous caller gets. | Design; `doPost` reads only the body. |
| D14 | **Download page is not shown to the public.** On the shared "Anyone" deployment it is shown only when the signed-in Google identity is the owner or in `DOWNLOAD_EMAILS`; everyone else gets a fixed sentence. `Page.html` writes all data with `textContent`/`createElement`, never `innerHTML` for data. | `Code.gs` `doGet` 336-348, `downloadPageAllowed` 288; `Page.html` (only `innerHTML = ''` clears). |
| D15 | **No XSS sink on the phone.** A grep of all of `webapp/js` finds no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, `srcdoc`. All form labels, answers and server messages go in through `textContent` or a fixed-name `setAttribute`; the only `src` is a `blob:` URL of the worker's own photo. Spec regexes are rejected at load if they can backtrack catastrophically. | `render.js` 118-126 (`el`), 721; `app.js` 27-34 (`h`); `expr.js` 512-537. |
| D16 | **The service worker caches nothing it should not.** It handles same-origin GET only, never POST, so no API reply (forms, tokens) can enter a cache; it precaches a fixed list of static files; `config.js` is network-first so a corrected URL is picked up. | `sw.js` 342-380. |
| D17 | **Codes and tokens are in IndexedDB, not `localStorage`**, and are not in URLs. (Only the photo-size cap is in `localStorage`.) | `db.js` 258-262; grep for `localStorage` in `webapp/js`. |
| D18 | **Nothing secret is committed.** Tracked files contain no key, token, password or real Apps Script URL; `config.js` holds a placeholder; `.gitignore` excludes `.env`, `*.db`, `*.xlsx` (except three test fixtures, which are synthetic form definitions); the `survey.db` and `alembic_check.db` in the working folder are untracked and absent from every commit. History checked for `macros/s/` (only the test fake `TEST`) and for key/credential file names (none). | `git ls-files`, `git log --all --name-only`, `git grep` for key patterns. |
| D19 | **Brute-forcing a *generated* code over the network is not realistic.** Generated codes are 8 characters from 31 symbols (31^8, about 8.5 x 10^11). Even with 76 live codes, and even at an optimistic 30 requests a second, finding one by guessing takes years. (This is *not* true of typed codes - see I4.) | `CODE_ALPHABET` 47, `generateCode` 110-117. |

---

## 2. Open - findings

Severity guide: **Critical** = data exposed or modified by an outsider. **Important** = real harm is
plausible and the fix is small. **Minor** = worth doing, not urgent. Anything I could not demonstrate from
the code is labelled **Hypothesis**.

### Critical (0)

No path was found by which an unauthenticated caller can read data, write data, list projects, learn
whether a code exists, or reach another project. The traces for each are in section 1 (D1-D3).

### Important (7)

**I1. One person with a script can stop everyone logging in; and the limiter does not actually limit.**
`Backend.gs` 28-30, 508-515, 725-732.
*Attack:* the failure counter is global ("there is no per-phone identity in Apps Script", line 29). Send 40
wrong codes (a blank code counts too) and `open` refuses *every* code, including right ones, for 10 minutes;
repeat every 10 minutes forever. The test "too many wrong codes pause opening, even for the right code"
proves the right code is refused. Already-open sessions keep working (test "an open session keeps working"),
so the damage is on mornings and token renewals (6 h), but a field day that starts with "cannot log in" is a
failed day. Also self-inflicted: 76 workers typing a code wrongly on a Monday can trip it. The counter is
read, modified and written to `CacheService` with no lock (lines 725-732), so concurrent requests overwrite
each other and an attacker with parallel requests can undercount - so it protects least against the one thing
it exists for.
*Why the lockout buys little:* with generated codes (D19) guessing is infeasible without it.
*Fix:* remove the hard global lock-out. Replace with (a) strong codes only (I4), (b) a soft penalty that
slows `open` for *unknown* codes but never refuses a code that verifies (verify first, delay only the miss),
(c) let a phone renew its token without resending the code (accept an expired-but-validly-signed token up to
a few days old and re-check the code hash prefix), so renewals do not depend on `open` at all.

**I2. Unauthenticated calls spend Google service quotas; if a quota runs out every real call fails.
(Hypothesis on the numbers; the mechanism is certain.)** `Backend.gs` 654-671, 737-747, 613-621.
*Attack:* every POST with a parseable body builds `realDeps_()`, which reads Script Properties
(`secret_()`) before the action is even inspected; `open` reads the Properties key again (`lookupTag_`) and
both sheets; `forms`/`submit` with any garbage token read both sheets before rejecting it. A script looping
on `{"action":"forms","token":"x"}` converts anonymous traffic into Properties and Spreadsheet reads on *your*
account. Google's per-day and per-minute limits on those services may be low enough on a free or standard
account for this to be reachable (I could not verify the numbers). When a quota trips, real requests get HTML
or `server_error`; the phone keeps its queue (D9), so **no data is lost, collection stalls** until the quota
resets. A 10 MB junk body (allowed by `MAX_BODY_CHARS`) is also fully parsed before auth.
*Fix (cheap, worth doing):* build deps lazily; reject a malformed token (not four dot-separated parts, wrong
length) before touching a sheet; cache the signing secret and the parsed People/Projects in `CacheService`
for 30-60 s (the cost is that revoking a person can take up to a minute - say so); check `postData.length`
before parsing. This lowers the cost per junk request; it cannot make it zero. Be honest on Monday that an
anonymous endpoint on Google quotas can be annoyed, not made unannoyable.

**I3. Project isolation depends on a spreadsheet being used by one project only, and nothing checks it.**
`Backend.gs` 196-224 (checks duplicate *folders* and names, not spreadsheets); `SETUP-MONDAY.md` step 4;
`appsscript/README.md` line 175.
*Attack (not malicious, just setup):* the setup guide says the data spreadsheet "can be this same Sheet".
If two Projects rows carry the same spreadsheet id, or one carries the *control* sheet's own id, then
- projects share tabs, so two projects' `amb_visit` forms write into one tab and uuid de-duplication works
  across them;
- the control sheet then also holds beneficiary data next to the People hashes, so sharing it with an
  analyst or listing them in `DOWNLOAD_EMAILS` hands over every project and every code hash (see M2);
- with ten projects this is the likely outcome of copy-paste.
Isolation of *code to project* is sound (D3); isolation of *project to storage* is by convention only.
*Fix:* in `parseProjects`/`resolveProject_`, mark a project not usable when its spreadsheet id equals the
control sheet's id (`SpreadsheetApp.getActive().getId()`) or is used by another row, and report it in
`projectProblems` (the folder-duplicate check at 204-208 is the pattern to copy). Add a drop-down validation
on People column C from the Projects tab's names, so a typo cannot silently move someone to a different
project. Document: the control sheet is separate from data sheets; do not register a *parent* folder as a
project if a child folder is also one (**Hypothesis**: `Folder.searchFiles` may or may not look inside
sub-folders; I could not confirm, and if it does, the parent project would receive its children's forms).

**I4. Codes chosen by hand are weak, and the code allows them.** `Backend.gs` 102-107, 799-812, 815-833.
*Attack:* the only rule is "at least 6 characters, no spaces". The menu offers "or type one"; the `onEdit`
helper hashes anything typed into the cell. A code like `Bihar26` falls to a few thousand guesses online
(the limiter in I1 allows about 5,700 a day if it works at all) and to a dictionary in seconds offline if the
hash ever leaks (300 rounds of SHA-256 is a convenience, not a defence). People under time pressure will
choose short, memorable codes because they have to read them out to ASHAs.
*Fix:* make the menu generate-only, lengthen generated codes to 10 characters (31^10, about 8 x 10^14, which
also pushes offline cracking of a leaked hash from hours to roughly a year on one GPU), reject typed codes
in `onEdit` by clearing the cell and noting why, and drop the "type one" option from the prompt.

**I5. The GitHub account and public repo are now what every phone trusts.** `webapp/config.js`,
`webapp/sw.js` 355-365, `webapp/index.html` (no Content-Security-Policy).
*Attack paths:* (a) anyone who gets write access to the repo (a stolen GitHub password, a leaked token, a
collaborator's laptop) can change `config.js` to their own endpoint - it is fetched network-first, so every
phone sends the next code and the next batch of beneficiary data to the attacker, with no change to any
script; or push modified JavaScript and bump the service worker `VERSION`. (b) GitHub Pages serves every
project site of one account from **one origin** (`<account>.github.io`), and IndexedDB is per origin: any other
page published under `dibyenduchatterjee-arch` - including a future personal site - can read the stored codes,
tokens, queue and photos. (c) No CSP, so nothing limits where injected script could send data.
*Fix:* hardware key or authenticator-app 2FA on the account before Monday; use a **dedicated GitHub
organisation or account used for nothing else** (or a custom domain) so the origin is private to this app;
protect `main` (no direct push); add a `<meta http-equiv="Content-Security-Policy">` in `index.html` with
`default-src 'self'; connect-src https://script.google.com https://*.googleusercontent.com; img-src 'self'
blob:` (test it on a phone: the Apps Script reply comes from a `googleusercontent.com` redirect). Keep the legacy
Google-sign-in files (`auth.js`, `googleauth.js`, `drive.js`, `webapp/console/`) out of the published copy; they
load Google scripts and are dead weight here.

**I6. The public repo discloses things that are not technical secrets but matter to you on Monday.**
`HANDOVER.md` 7-16, 114-115; `RESUME-DRIVE.md` 63; every commit's author line.
Tracked and public (if the repo is public, as stated): the real Drive folder id; internal
commentary about why Google Cloud was not used and what this work is for; your full name, your
Evidence Action work e-mail in every commit, and a Windows user path. (The folder id and that
commentary were removed from `HANDOVER.md` and `RESUME-DRIVE.md` on 31 October 2026, after this
review; they remain in the repository's history.)
*Is the folder id dangerous alone?* No: a folder id grants nothing; access follows the folder's sharing. It
becomes a problem only if that folder is link-shared ("anyone with the link"), in which case the id *is* the
key. Check its sharing is "Restricted". *The larger exposure is the narrative text*, which reads as a
deliberate route around IT policy and stays searchable, including in history.
*Fix:* publish **only `webapp/`** from a fresh repository (new history, no `docs/`, `HANDOVER*`, `RESUME*`,
`server/`, `appsscript/`), keep the working repository private, and use a neutral commit identity (GitHub
no-reply address). Removing the files from the current repo is not enough: history keeps them. Do this
before Monday if the repo is already public.

**I7. Beneficiary data and codes stay on the phone, in the clear, after "Log out" and after access is withdrawn.**
`webapp/js/db.js` 258-262; `projects.js` 133-137; `app.js` 519-521; `sync.js` 15-16.
*Attack:* a lost or borrowed phone. IndexedDB holds the plaintext access code (needed to renew the token), the
queued records with names, ages and GPS, photographs, drafts and form definitions. "Log out" deliberately keeps
everything except the codes (to protect unsent work), and the app has no PIN or lock. Anyone with the unlocked
phone can read the data from browser storage; while the code is still stored, the app itself keeps working.
Revoking the person (Active = no) stops *uploads and new forms*; it does not erase what is already on the
handset. The design documents admit end-to-end encryption is not built, so this is known; it is listed here
because it is the most likely real-world leak.
*Fix, in order of cost:* tell workers that phone screen-lock is mandatory (policy, zero code); on `revoked`,
show a prominent "unsent records are still on this phone - sync or hand it in" and offer an explicit "wipe this
phone" button; later, an app PIN and encrypting the stored code and queue with a key derived from it. Do not
auto-wipe on revocation - that would destroy unsent field data, which the design correctly refuses to do.

### Minor (8)

**M1. Any valid code can write to any tab name, in volume.** `validateSubmission` 336, 359-376; `planTab` 461.
A signed-in insider can create up to 20 new tabs and 300 new columns per request, repeatedly, and can write into
another form's tab if its first column is `uuid`/`parent_uuid`; there is no per-person rate or size cap, and tab
names are not tied to the project's published forms. Effect is limited to their own project, but a runaway or
hostile phone can fill the 10-million-cell spreadsheet limit or the Drive folder and stop that project's
collection. Rows are always stamped with the writer's name, so it is traceable. *Fix:* accept only tab names
derived from the project's published form ids (cache the list), and cap total columns per tab.

**M2. The download page shows the control tabs and trusts its gate only.** `Code.gs` 336-395.
`getTabs` lists every tab including `People` (code hashes and lookup tags) and `Projects`; `queryTab`/`exportCsv`
do no identity check of their own. Anyone in `DOWNLOAD_EMAILS` can therefore download all hashes, and every
project's data held in the control sheet. Not reachable by an outsider (the functions run only inside the page the
gate serves; **hypothesis** that no other route calls them). *Fix:* exclude reserved tabs in `getTabs` and
`loadTable_`, and call `downloadPageAllowed` inside each of the three functions.

**M3. The token carries 12 hex characters of the person's code hash**, and cannot be revoked one at a time
short of changing the code. `Backend.gs` 255-259. Harmless in practice (48 bits of a salted hash, salt not
disclosed) but unnecessary; a random per-person "session version" cell would do the same job and allow
"log out everywhere".

**M4. Photo bytes are not checked against the declared type.** `validateSubmission` 414-417, `savePhoto` 711.
An insider can store any bytes as `image/jpeg`; they land in a private Drive folder that only you open, so
the consequence is "do not open files from `photos/` on a machine you cannot afford to lose". *Fix:* check the
JPEG/PNG/WebP magic bytes after decode.

**M5. A submission the server will never accept is kept only on the phone, and some legitimate forms hit it.**
`sync.js` 251, 336-345; `Backend.gs` 32, 48-51. A photo or audio type outside the six allowed (a `video` or
`file` question - both are in the renderer's supported types - sends `video/mp4` or `application/octet-stream`),
or four photos at the phone's 2 MiB fallback cap (about 2.8 M base64 characters each, over the 10 M body limit
at four), makes the whole submission `bad_request`/`too_large`. It is then preserved only in the phone's
rejected store - not on the server - so **the HANDOVER rule "validation failure means stored and flagged, never
dropped" holds only while that phone keeps its data**. *Fix:* on refusal for media reasons, resend the answers
without the offending media and flag the row; and say plainly in the setup guide that video/file questions are
unsupported.

**M6. `_submitted_by` is a name, not an identity.** `Backend.gs` 489-491. Two people with the same name are
indistinguishable in the sheet. Also a phone may send a column `_Submitted_By` (different case): it is accepted
as an ordinary column and could show a forged name beside the real one. *Fix:* stamp a person id as well, and
refuse column names that match a stamp name case-insensitively.

**M7. Old deployments stay live.** Each "New deployment" creates a new `/exec` URL; the old one keeps running
the old code until archived. Operational. *Fix:* use "Manage deployments > edit > New version" (as the guide
says), archive any extra deployment, and note the one live URL.

**M8. The setup guide contradicts the code in places.** `SETUP-MONDAY.md` says the menu is "Survey Platform >
Set a person's code" (the menu is "Evidence Action survey > Set or change the code for the selected row"), shows a
`Code` column with `(generated)`, and says to use "the same Sheet" as the data sheet (see I3). Misreading step 5
is exactly how weak codes (I4) and shared sheets (I3) happen. *Fix:* correct the menu name and the sheet advice.

---

## 3. Not covered - what this design does not protect against, and the honest consequence

- **A person with a valid code and a bad intention.** They can submit made-up records. `_gps`,
  `_started_at`, `_finished_at` and `_device_id` come from the phone and are **not trusted or verifiable** -
  the script stamps only the received time and the name. *Consequence:* fabricated or copied visits are
  detectable only by analysis of the data, not prevented.
- **Loss or capture of your Google account.** The script runs as you with the full `drive` and `spreadsheets`
  scopes (`appsscript.json`), because it must open folders and sheets you created by hand. *Consequence:* a bug
  or a hijacked account reaches your whole Drive, not just this project; and if you leave Evidence Action or
  your account is suspended, the backend stops. For production the server version is the right path (as your
  HANDOVER already says).
- **Google itself and your Workspace administrators.** Data is in your Drive; Google, and an administrator of
  the Evidence Action Workspace, can reach it. Nothing is encrypted by the application. *Consequence:* Monday's
  claim "the data never leaves Evidence Action's own Drive" is true of *location*, not of *who can read it*.
- **A lost or stolen phone** - see I7.
- **Codes shared outside their owner.** Codes will be sent on WhatsApp and read aloud; one code means one name in
  the sheet, so a shared code mis-attributes rows. Revoking is quick (Active = no) but only takes effect on the
  next call.
- **Retention, erasure and consent.** Nothing is ever deleted, by design. *Consequence:* a request to erase a
  person's record needs a manual edit in the sheet and the Drive folder (and Sheets version history keeps the
  old values). I did not assess legal or data-protection compliance (India's DPDP Act, programme data-sharing
  agreements, ethics approvals); that needs the organisation's data-protection owner, and the organisation has
  not yet been told about this tool.
- **Capacity.** A Google Sheet holds 10 million cells; many projects in one sheet (I3), wide forms and repeat
  rows get there. The script lock serialises all writes; 76 phones syncing at once will queue and retry, not fail,
  but throughput was not measured.
- **The APK.** It is the same website in a wrapper: it inherits I5 and I7, and adds nothing.
- **The legacy server version and its console**, which still sit in the same repo. Not reviewed here.

### Not verified - what I could not check

1. **Deployed behaviour.** Nothing in this architecture has run against real Google services (HANDOVER says so).
   Every claim about `Utilities`, `PropertiesService`, `CacheService`, `LockService`, `SpreadsheetApp` and `DriveApp`
   is read from the code and tested only against in-memory fakes in `appsscript/tests/`.
2. **Quotas.** I do not know the real limits for your account type (Properties reads, Spreadsheet reads, simultaneous
   executions, Drive file creation, daily runtime) and did not try to find them; I2 and the capacity note are
   mechanisms, not measured limits.
3. **Google's own protections** (abuse throttling on anonymous web-app URLs). They may reduce I1 and I2; do not
   count on them.
4. **Whether `setNumberFormat('@')` followed by `setValues` really stores `=...` as text in a live Sheet**
   (D10 relies on it; the test uses a fake), and whether numbers keep their type in a text-formatted range.
5. **Whether `Session.getActiveUser().getEmail()` returns the owner's e-mail on an "Anyone"/"Execute as me"
   deployment** for your Workspace account. If it returns blank, the download page will refuse you too (fails closed).
6. **Whether the `onEdit` simple trigger is allowed to call the services it uses** (it hashes with `Utilities`
   and reads Script Properties). If not, a typed code stays as plain text - which is safe (D5) but unusable.
7. **Whether `Utilities.getUuid()` is a cryptographically strong source.** Codes, salts and the signing secret are
   derived from it; if it is a standard random (version 4) UUID, that is adequate.
8. **`Folder.searchFiles` recursion** (see I3).
9. **That the repo is actually public, and how Pages will be configured.** Taken from your brief. GitHub Pages
   cannot serve a `webapp/` sub-folder directly from a branch (only the root or `/docs`), so deployment will
   need either an Actions workflow or a webapp-only repository; the second is what I6 recommends.
10. **Not read in full:** `render.js`, `formengine.js` and `expr.js` beyond sink searches; `server/`; the legacy
    `webapp/console/`. No dynamic testing or fuzzing was done.

---

## 4. Suggested order, if you have a day before Monday

1. Before anything else: GitHub 2FA; decide the repo question (I6, I5). Check the Drive folder is Restricted.
2. Generate-only 10-character codes (I4) and the project drop-down on People (I3). Two small edits.
3. Soften the global lock-out (I1) and make `forms`/`submit` reject a malformed token before reading sheets (I2).
4. Keep the control sheet separate from every data sheet, by hand, now, even before the code check exists (I3).
5. Tell the team: phone screen lock is mandatory; one code, one person (I7, Not covered).

What you can say on Monday with confidence: nobody without a code can read, list or change anything; a code
reaches only its own project; rows cannot be overwritten or re-attributed by the phone; a failed send never
loses work on the phone. What you should not claim: that the URL "cannot be disturbed", that the hashing protects a
leaked sheet, or that the data is encrypted.
