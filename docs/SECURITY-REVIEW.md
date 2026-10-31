# Security review - Evidence Action survey platform, Phase 1

Reviewed: branch `phase-1`, 31 October 2026. Read-only review: no application code was changed.
Method: line-by-line reading of `server/app/**` (all of `core/`, `intake/`, `api/`, `export/`,
`forms/expr.py`, `forms/validate.py`, `forms/xlsform.py`, `main.py`, `cli.py`), `webapp/js/auth.js`,
`sw.js`, `db.js`, the console's DOM and session helpers, plus the decision log. Every finding
marked **VERIFIED** was reproduced with a throwaway script run from outside the repository (the
scripts are not committed). The server suite was run at the start: 1050 passed, 1 skipped. The
JavaScript suite was not run.

Severity: **Critical** is an authorization bypass, path traversal, secret leak or injection.
**Important** must be fixed before real data. **Minor** is noted without inflation.

Summary at review: **1 Critical, 6 Important, 10 Minor.** The core authentication design is sound. The
authorization design is sound but had one hole outside the list/detail routes it was tested on.
**Status after Task 31: the Critical and all six Important findings are fixed (see Done); 10 Minor and
three outside-`server/` follow-ups remain open.**

---

## Done

Each item below was read in the code. The test named is the one that pins it.

**Authentication and sessions**
- Passwords hashed with argon2id (library defaults), 10-character minimum plus a common-password
  check, 1024-character ceiling. `core/security.py`, `api/admin.py::check_password_policy`.
- Login timing does not reveal which usernames exist: an unknown or deactivated account runs a real
  argon2 check against a dummy hash. `test_dummy_verify_always_false_and_runs_a_real_argon2_check`,
  `test_deactivated_user_runs_dummy_verify_and_is_refused_even_if_it_said_yes`.
- JWT: HS256 pinned, `none` and other HMAC variants refused, `exp`/`sub`/`role` required, `sub`
  must be canonical decimal, 15-minute life, all time checks made against one injected clock.
  `test_unsigned_alg_none_token_is_rejected`, `test_other_hmac_algorithm_is_rejected`,
  `test_token_signed_with_another_secret_is_rejected`.
- **The role comes from the database on every request**, never from the token, and a deactivated
  user is refused on the next call. `core/rbac.py`; `test_role_comes_from_the_database_not_the_token`,
  `test_deactivated_user_with_an_unexpired_token_is_refused`. OpenRosa Basic auth reads the same
  table, so it has the same property.
- Refresh tokens: 256-bit random, only the SHA-256 digest is stored, rotated on every use with an
  atomic claim (`UPDATE ... WHERE replaced_by IS NULL`), so two concurrent presentations cannot
  both win. Presenting a spent token revokes the whole chain.
  `test_reusing_a_rotated_refresh_token_revokes_the_whole_family`,
  `test_reuse_detection_leaves_other_sessions_alone`.
- Deactivating a user or resetting a password revokes all their refresh tokens in the same
  transaction. The last active admin cannot be demoted or deactivated. `api/admin.py::update_user`.
- Rate limiting: per username and per IP, every attempt counted on entry (no check-then-count gap),
  a success clears only the username counter and refunds its own IP count (so a valid account
  cannot wash an IP's failures), bounded memory. `core/ratelimit.py`, `test_ratelimit.py`.
- Proxy headers: `X-Forwarded-For` ignored unless `TRUST_PROXY_HEADERS` is set, then read from the
  right-hand end by hop count, every header line joined, garbage falls back to the peer.
  `test_forwarded_header_is_ignored_when_trust_is_off`,
  `test_forged_left_most_forwarded_value_does_not_escape_the_ip_limit`,
  `test_every_forwarded_for_header_line_is_read_not_just_the_first`.

**Authorization (list, detail, media, export routes)**
- `staff_form_filter` / `staff_can_see_form` / `staff_can_see_project` run one membership rule. It
  is applied to: `GET /api/forms`, `GET .../spec`, `POST .../publish`, `GET /api/submissions`
  (list and detail), `GET .../media/{q}`, `POST /api/exports`, `GET /api/exports/{id}` and
  `/download`, form upload overwrite, `/api/assignments`, every `/api/projects/**` route. A
  supervisor's refusal returns the same 404 body as a missing object. `test_staff_scoping.py`
  (including the "same as missing" comparison). I re-ran the scoping scenario independently and
  confirmed the 404s.
- Enumerators see only their own submissions, only forms they hold a grant on, and an unknown or
  unassigned form gets the same 403. `resolve_form_version`, `has_form_grant`.
- Admin-only routes (`/api/users` writes, assignments writes, `/audit`) are gated in the route layer.
- Password hashes and token digests appear in no response model.

**Data at rest and in transit**
- Media: AES-256-GCM, key derived from `MEDIA_KEY` with HKDF-SHA256, fresh 96-bit random nonce per
  file, tag verified before any plaintext is returned. `core/crypto.py`;
  `test_the_nonce_is_twelve_bytes_prepended_to_ciphertext_and_tag`, `test_tampered_ciphertext_is_rejected`.
- Nothing here is worse than documented: answers and Drive exports are plaintext, as stated in
  `ARCHITECTURE.md` and `OPERATIONS.md`. The media zip uploaded to Drive is decrypted (also a
  consequence of the documented design). Export download is streamed through our own RBAC, not a
  Drive link.

**Injection and traversal**
- No raw SQL anywhere (`grep` for `text(`, f-string SQL, `execute(f`): ORM only. No `eval`, `exec`,
  `pickle`, `subprocess`, `yaml.load` in `server/app`.
- Media storage path is `<canonical-uuid>/<index>.<sniffed-ext>`. The client's file name and the
  question name never reach the filesystem. No traversal route.
- Static serving: only `webapp/` is served, `resolve(strict=True)` then `is_relative_to(root)`,
  dot-segments, backslash, NUL and `:` refused. I tried `%2e%2e`, `..%2f`, `%5c..`, `::$DATA`,
  `/.env`: all 404. Nothing outside `webapp/` is reachable. `test_static_serving.py`.
- CSV export: any text cell starting `= + - @ TAB CR` gets a leading `'`, including usernames and
  the failures column; real numbers stay numbers. Sheets are written `RAW`. `test_csv_export.py`
  (`test_a_text_value_starting_with_a_formula_character_is_prefixed`).
- Browser DOM: every server string (names, Hindi labels, answers, errors) goes in with
  `textContent` / `createTextNode`. There is no `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
  `document.write` or `eval` in `webapp/js` or `webapp/console/js`. The only server-supplied `href`
  is the Drive link, which is checked for `https://drive.google.com`.
- Media served inline carries `X-Content-Type-Options: nosniff`, and the content type comes from the
  byte sniff (JPEG/PNG/WebP/audio/video/PDF/zip only), so no HTML or SVG can be stored and served
  from this origin.

**Secrets**
- `jwt_secret` has no default and a 32-character minimum; `media_key` defaults to empty and is
  validated to the same 32 minimum, so a missing one is refused. `hide_input_in_errors` is on.
  `test_config.py`.
- No secret in the repository or its history: `git ls-files` and `git log --diff-filter=A` show only
  `.env.example` (blank values); a grep for private-key blocks and key-shaped strings found only
  the fake key in `test_drive.py`. `.gitignore` covers `.env*`, keys, `*.db`, `server/media/`.
- Audit rows are scrubbed of any key matching password/token/secret/key. Google private-key
  material is redacted from errors (`test_drive.py`). Login/refresh error text is generic.

**Expression evaluator (`forms/expr.py`)**
- Hand-written tokenizer and recursive-descent parser, no `eval`/`exec`/`ast`, a closed function
  whitelist, 200-node and 50-depth caps, XPath paths/axes/unions rejected at publish, everything
  outside the subset raises at parse time. It cannot escape the subset. Resource limits are a
  different matter: see Open I-2.

**Browser side**
- Tokens live in IndexedDB (`session` store); `localStorage` holds only the device id, language and
  the media size cap. `auth.js`, `db.js`.
- The service worker never intercepts `/api/` or any non-GET, caches only the listed shell files,
  and deletes old caches on activate. `sw.js`.
- The refresh is serialised across tabs with `navigator.locks`, re-reads the stored session inside
  the lock, persists the new refresh token before treating the old one as spent, and never touches
  the upload queue on logout or forced re-login. `auth.js::renewAccess`.

**Uploads**
- Submission and OpenRosa bodies: declared-length cap, `max_files`, `max_fields`, per-part reads
  capped at the media limit plus one byte, magic-byte sniff per question type, unknown slot refused,
  nothing written on refusal. XLSForm upload: 5 MB cap, `PK` magic. CSV dataset: UTF-8, no NUL,
  rectangular. OpenRosa instance XML: DTD refused, size capped.

**Fixed after the review (Task 31).** Each finding below was reproduced as a failing test first, then fixed.

- **C-1 (Critical). Staff authorization bypass on the OpenRosa and intake paths.** `resolve_form_version`
  now sends every non-enumerator through `staff_can_see_form` and answers a refusal with the same
  404 `form_version_unknown` as a missing form; `store_submission` repeats the check, so a caller
  that skips the resolver is still refused. Enumerators are unchanged (assignment, same 403 for
  unknown and unassigned). Pinned by `test_staff_scoping.py`:
  `test_openrosa_download_is_refused_for_the_other_project_exactly_like_a_missing_form`,
  `test_json_submission_into_another_projects_form_is_refused_like_a_missing_form`,
  `test_openrosa_submission_into_another_projects_form_is_refused_like_a_missing_form`,
  `test_a_supervisor_who_lost_membership_can_no_longer_submit_or_download`,
  `test_openrosa_form_list_is_scoped_for_supervisors`,
  `test_intake_itself_refuses_staff_without_access_even_when_called_directly`,
  `test_openrosa_download_admin_reaches_every_project`. Each compares the refusal with a nonexistent
  form id, and checks nothing was stored.
- **I-1. Repeat-row denial of service.** `max_repeat_rows` (setting `MAX_REPEAT_ROWS`, default 2,000,
  nested rows counted) refuses with 422 `too_many_repeat_rows` before anything is written, and the
  phone keeps the record (`retain_on_device`). Validation no longer rebuilds every sibling list per
  row: the gathered lists are cached per repeat and patched in place when a calculate rewrites an
  answer, so the work is linear. `test_a_huge_repeat_is_refused_quickly_and_nothing_is_stored`,
  `test_the_repeat_row_cap_is_a_setting_and_counts_every_repeat_together`,
  `test_nested_repeat_rows_count_towards_the_cap` (`test_submissions_api.py`);
  `test_validation_work_grows_with_rows_not_with_rows_squared`,
  `test_cached_sibling_values_follow_a_calculate_that_changes_a_row` (`test_validate.py`).
- **I-2. Regex denial of service.** Publish refuses a `regex()` whose long repeat (more than 10 times)
  holds a body that can match nothing, a variable-length part followed by something that can start
  with the same character (`(a+)+`, `(a|aa)+`, `(x+x+)+`), or alternatives that overlap. Dotted
  numbers, phone patterns and fixed counts still pass. `test_regex_safety.py` (refused and accepted
  pattern lists, and the upload route returning 422 `unsupported_expression` naming the question).
  Not done: capping the answer length passed to `regex()`, RE2, and the mirror in
  `webapp/js/expr.js` (outside `server/`; see Open F-1).
- **I-3. XLSForm zip bomb.** Before conversion the zip directory is read: over 50 MB unpacked, over
  200 parts, or a part over 1 MB at more than 200:1 is refused with a clear 422 `invalid_xlsform`;
  nothing is decompressed. `test_xlsform.py::test_a_small_upload_that_expands_past_the_cap_is_refused_before_it_is_read`,
  `test_a_spreadsheet_with_too_many_entries_is_refused`, `test_a_single_entry_with_an_absurd_ratio_is_refused`,
  `test_forms_api.py::test_an_xlsform_zip_bomb_is_a_clear_422_and_stores_nothing`.
- **I-4. Datasets are global.** `Dataset.project_id` (initial migration edited in place; a dataset
  created without a project goes to the Default project). A name is unique per project, so no one
  learns another project uses it. Read rule `access.dataset_filter`: admin all; supervisor their
  projects; enumerator their projects plus the project of any form they hold a direct assignment on.
  Writes need `staff_can_see_project` on the target project (the same refusal as a missing project).
  `GET /api/datasets/{project_id}/{name}` disambiguates a name held in two readable projects (409
  without it). `test_dataset_scoping.py`; `alembic upgrade head` then `alembic check` reports no drift.
- **I-5. User list.** A supervisor gets the members of their own projects (themselves included) and,
  with `?username=`, the one active account with exactly that name; every lookup is audited as
  `user.lookup`. Admin unchanged. `test_supervisor_user_list_and_moves.py`:
  `test_a_supervisor_lists_only_people_in_their_own_projects_with_four_fields`,
  `test_a_supervisor_in_no_project_sees_only_themselves`,
  `test_a_supervisor_can_look_up_one_user_by_exact_username_to_add_them`,
  `test_a_lookup_never_returns_a_deactivated_account`, `test_the_supervisor_lookup_is_audited`.
- **I-6. Security headers.** Middleware in `main.py` adds CSP (`default-src 'self'`, script from
  `'self'` plus the hash of each served page's own inline script, never `unsafe-inline` for script
  or style elements, `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`),
  `X-Frame-Options: DENY`, HSTS (one year), `Referrer-Policy: no-referrer` and `nosniff` to every
  response. One narrow concession: `style-src-attr 'unsafe-inline'`, because
  `webapp/console/js/forms.js` indents nested questions with an inline style attribute (see F-3).
  `test_security_headers.py`. Checked by loading the enumerator app and the console in a browser
  against the real server: both render, the console's inline script runs, an injected inline script
  is blocked, no violation reported. Not checked: service worker registration (the embedded browser
  fails to register one even without the policy), and the Node browser suites (Node is not installed
  on this machine; they are served by `tools/serve.js`, which never carries these headers).

---

## Open

Nothing Critical or Important remains open in `server/`. What is left is Minor (below) and three
follow-ups that sit outside `server/` and were deliberately not touched:

- **F-1. Mirror the I-2 regex restriction in `webapp/js/expr.js`.** The server now refuses
  catastrophic patterns at publish, so no new form can carry one to a phone; the mirror would only
  matter for a spec published before the fix. `shared/expr_cases.json` still lists
  `regex_plus_after_a_group_quantifier_pair` (`(?:a+)+`) as evaluating; `test_expr.py` now expects the
  server to refuse it, so the shared corpus and the JavaScript suite disagree with the server on that
  one case until the web side follows.
- **F-2. Console: add a username lookup box to the project members screen.** Since I-5 a supervisor's
  `GET /api/users` lists only people already in their projects; to add someone new the console has to
  call `GET /api/users?username=<exact>`. Until it does, only an admin can add a person who is not yet
  in one of the supervisor's projects.
- **F-3. Console: set the nested-question indent with `el.style.paddingLeft`** (not a `style`
  attribute) in `webapp/console/js/forms.js`; the policy's `style-src-attr 'unsafe-inline'` can then
  be dropped.

### Minor

- **M-1. Login lockout is a denial-of-service lever.** Five bad guesses from anywhere lock a known
  username for 15 minutes, repeatably. Admin has no unlock path. Key the username limiter on
  (username, IP) as well, or add an admin unlock. (Logged earlier as a Task 4 deferral.)
- **M-2. Rate limiter is per process and per IPv6 address.** An attacker with a /64 has unlimited
  buckets; several workers multiply the limit. Documented in `OPERATIONS.md`; normalise IPv6 to /64.
- **M-3. Sessions never expire absolutely, and users cannot change their password.** Every refresh
  issues a fresh 30-day token, so a stolen phone in use stays signed in until an admin deactivates
  the user. No self-service password change exists; the admin sets and therefore knows every
  password, and nothing forces a change at first login. Add an absolute 90-day lifetime and a
  change-password route.
- **M-4. Audit trail gaps.** Not recorded: failed logins, token-reuse detection (the system detects
  theft and tells nobody), rate-limit hits, submission detail views, media views, CSV downloads. Only
  `export.start` is. The audit log is the only accountability for a supervisor misusing legitimate
  access; add `media.view`, `submission.view`, `export.download`, `auth.login_failed`,
  `auth.refresh_reuse`. Append-only is by discipline and a test, not a database rule (documented).
- **M-5. Test harness reachable on Windows.** `main.py::_safe_file` compares the first segment to
  `"tests"` case-sensitively; on NTFS, `GET /Tests/browser.html` returns **200 VERIFIED**, as does
  `/index.html.`. Contents are test pages and fixtures, no secrets. Lower-case the comparison or do
  not deploy `webapp/tests`.
- **M-6. OpenRosa DTD check is byte-level.** `_parse_xml` looks for `<!DOCTYPE` in the raw bytes; a
  UTF-16 document slips past. Expat caps entity expansion and Python's `ElementTree` does not
  fetch external entities, so no impact was demonstrated (hypothesis). Use `defusedxml.ElementTree`,
  already installed.
- **M-7. Chunked request bodies skip the length check.** Without `Content-Length`, Starlette spools
  file parts to disk with no total cap before `_read_part` limits what is kept. Disk exhaustion by an
  authenticated user. Mitigated by the documented proxy `max_size`; make sure it is set.
- **M-8. Smaller existence oracles.** `POST /api/forms` by a supervisor returns 404 for another
  project's `form_id` but 201 for a free one; `POST /api/projects/{id}/members` distinguishes a
  missing user id (404) from an existing one. Low value, but they contradict the "refusals do not
  leak existence" rule.
- **M-9. Public `/docs` and `/openapi.json`.** FastAPI defaults are on; the full route map is
  unauthenticated. Set `docs_url=None, openapi_url=None` in production.
- **M-10. Housekeeping.** `CORS_ORIGINS` is parsed but no CORS middleware reads it (safe: same-origin
  only, but the setting does nothing). Exception text from failed exports (`type(e).__name__: e`) is
  returned to staff and may contain paths. Media ciphertext has no associated data, so a disk-write
  attacker could swap two encrypted photos undetected. `requirements.txt` carries `pytest`,
  `pip_audit` and `cyclonedx` into production. `OPERATIONS.md` line 84 says the PostgreSQL driver is
  not in `requirements.txt`; `psycopg` now is.

---

## Not in Phase 1

- **Form-level end-to-end encryption.** Answers (names, ages, GPS) are plaintext in the database,
  in backups, in IndexedDB on every phone, and in CSVs on Drive. Photos are encrypted, but the key is
  on the same server as the photos and the database. Consequence: anyone with the database file, a
  backup, the Drive folder, or server root reads every record. Drive's own sharing is the only
  barrier on the exported copies, and the decrypted media zip goes to Drive too.
- **Device passcode gating of IndexedDB.** The queue, drafts, rejected submissions, downloaded
  datasets and (until logout) the tokens are readable by anyone who can open the phone or its browser
  profile. Logging out deliberately keeps unsent work on the device (so no visit is lost), so a
  logged-out lost phone still holds unsent beneficiary records, readable in the clear. Consequence:
  a lost or shared phone exposes every unsent visit, and a stolen device with a live session acts as
  that worker for up to 30 days until an admin deactivates the account (see M-3).
- **ODK Collect verified against the real app.** The OpenRosa endpoints are tested only against
  hand-built requests. Consequence: the form list, download, HEAD, multi-part attachment and 201/202
  handling may behave differently with the real client, and the Basic-auth flow (credentials sent on
  every request, over TLS only) has not been seen working. Treat ODK Collect as unsupported until
  tried on a phone. (C-1, which affected this path, is fixed; the real client is still untried.)

---

## What I could not verify

- **Deployment.** No TLS termination, Caddy/nginx config, firewall, file permissions on `server/`,
  `.env`, `survey.db` or `server/media/`, or the single-worker setting were observed. Everything
  above about the proxy is from the documents.
- **Google Drive.** Folder sharing and service-account scope were not inspected, and nothing reached
  Google. Who can open the exported CSVs and the decrypted photo zip is decided there.
- **PostgreSQL.** Everything ran on SQLite. `with_for_update` (last-admin guard) is a no-op there and
  the migrations are documented as never run against PostgreSQL.
- **JavaScript.** The 573 JS tests were not run. `render.js`, `sync.js`, `formengine.js` and `expr.js`
  were searched for dangerous sinks and skimmed, not read line by line. Whether the same regex and
  row-count denial of service freezes a phone was reasoned, not run. The service worker was not
  exercised in a browser by me.
- **`forms/compile.py`, migrations, the console pages' logic** (being edited in parallel) were read
  for sinks and XML parsing only.
- **Dependencies.** `pip_audit` is in the environment but was not run; no CVE check of the pinned
  versions was done.
- **Physical devices, multi-worker deployment, backup restore, `MEDIA_KEY` rotation script.**
