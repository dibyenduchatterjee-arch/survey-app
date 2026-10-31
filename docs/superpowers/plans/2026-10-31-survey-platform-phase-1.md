# Survey Platform Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hosted survey data collection system on the ODK XForms standard — XLSForm upload, offline data entry on any phone, sync, monitoring, and CSV + media export to Google Drive — usable by Evidence Action field teams.

**Architecture:** A FastAPI server compiles uploaded XLSForms to ODK XForm XML (via pyxform) and to a compact JSON form spec. A PWA of plain ES modules reads that spec, runs the form offline out of IndexedDB, and syncs a queue of submissions keyed by client-generated UUID. Exports produce a main CSV plus one child CSV per repeat group, with media, pushed to Google Drive and a Google Sheet.

**Tech Stack:** Python 3.14, FastAPI, SQLAlchemy 2.1, Alembic, pyxform 4.5, argon2-cffi, PyJWT, cryptography, google-api-python-client. Browser: plain ES modules, IndexedDB, service worker, WebCrypto. Node.js 26.13 LTS for `node --test` and a dev file server only.

**Spec:** `docs/superpowers/specs/2026-10-30-survey-platform-design.md`

## Global Constraints

- Python floor 3.10, developed on 3.14. Node.js is a **test-time tool only**; the shipped `webapp/` has no `node_modules` and no build step.
- Organisation name is written **Evidence Action** in full, or **EvAc**. Never "EA".
- No secret, service-account key, `.env`, database file, or field data is ever committed. `.gitignore` is already in place; do not weaken it.
- Every authorization decision is made server-side in the route layer. The UI may hide controls but never decides access.
- All HTTP request bodies are validated by pydantic models. No raw `dict` reaches a database write.
- CSV output is UTF-8 **with BOM**, so Devanagari opens correctly in Excel on Windows.
- The server never trusts a device clock. `received_at` is set by the server; device-supplied `started_at`/`finished_at` are stored as reported data, never used for ordering or expiry.
- A submission that fails server-side validation is stored with `status="flagged"` and its failures recorded. Submissions are never silently dropped or silently corrected.
- An expression the evaluator cannot parse is a **publish-time error**, never a silent `true`.
- Run Python as `.venv/Scripts/python.exe`; run tests as `.venv/Scripts/python.exe -m pytest`.

## Review Focus

Five things the spec implies but no single feature test naturally covers. Each line's test is placed in the task that owns the code.

1. **Devanagari survives every hop** — XLSForm cell → XForm XML → JSON spec → IndexedDB → submission → CSV opened in Excel. A mojibake'd `ज़िला` makes the export useless. Tests in Task 7 and Task 13.
2. **The same submission arriving twice** — rural networks drop mid-upload and the device retries. The second arrival must return the first receipt, not create a second row or a second media file. Tests in Task 11 and Task 20.
3. **A phone with the wrong date** — field phones are routinely days off. `today()` in a constraint and `start`/`end` metadata must not corrupt data or reject valid entries. Tests in Task 6 and Task 11.
4. **A repeat group with zero rows, and a repeat inside a repeat** — both are normal in household rosters and both commonly produce an empty or malformed child CSV. Tests in Task 8 and Task 13.
5. **A whole day of queued work, and one oversized photo** — the queue must survive a browser restart, and a rejected upload must not leave orphan media or block the rest of the queue. Tests in Task 11 and Task 20.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/app/core/config.py` | Settings from environment; no defaults for secrets |
| `server/app/core/security.py` | argon2 hashing, JWT issue/decode |
| `server/app/core/rbac.py` | Role dependency used by every protected route |
| `server/app/core/audit.py` | Append-only audit writer |
| `server/app/core/ratelimit.py` | Fixed-window counter for login and submission |
| `server/app/core/crypto.py` | AES-GCM encrypt/decrypt for media at rest |
| `server/app/db/models.py` | All SQLAlchemy models |
| `server/app/db/session.py` | Engine and session factory |
| `server/app/forms/expr.py` | XPath-subset parser and evaluator |
| `server/app/forms/xlsform.py` | XLSForm bytes → XForm XML (pyxform) |
| `server/app/forms/compile.py` | XForm XML → JSON form spec |
| `server/app/forms/validate.py` | Re-validate a submission against a form spec |
| `server/app/export/csv_export.py` | Main CSV + one child CSV per repeat |
| `server/app/export/media.py` | Media bundle zip |
| `server/app/export/drive.py` | Google Drive upload behind an injectable client |
| `server/app/export/sheets.py` | Google Sheet refresh behind an injectable client |
| `server/app/api/*.py` | One module per route group |
| `shared/expr_cases.json` | The one expression corpus, read by pytest and `node --test` |
| `webapp/js/db.js` | IndexedDB stores: forms, preload, drafts, queue, media, session |
| `webapp/js/expr.js` | JS twin of `expr.py` |
| `webapp/js/formengine.js` | Walks the spec; relevant / constraint / calculate / repeats |
| `webapp/js/render.js` | One renderer per question type |
| `webapp/js/sync.js` | Upload queue, retry, UUID de-duplication |
| `webapp/js/auth.js`, `i18n.js` | Tokens; Hindi/English label selection |
| `webapp/sw.js` | App-shell cache |
| `webapp/console/` | Admin and supervisor pages |

---

## Task 1: Project scaffold and health check

**Files:**
- Create: `server/requirements.txt`, `server/app/main.py`, `server/app/core/config.py`, `server/app/__init__.py`, `.env.example`, `package.json`
- Test: `server/tests/test_health.py`, `server/tests/conftest.py`

**Interfaces:**
- Produces: `Settings` (pydantic-settings) with fields `database_url: str`, `jwt_secret: SecretStr`, `media_key: SecretStr`, `media_root: Path`, `cors_origins: list[str]`, `max_media_bytes: int = 5 * 1024 * 1024`; `get_settings() -> Settings` cached.

`max_media_bytes` is the **one** media size cap in the system. Task 11 rejects an upload above it; Task 19 downscales photos below it. It is defined once here so the two cannot disagree. `app: FastAPI` in `main.py`. `client` pytest fixture returning `TestClient`.

- [ ] **Step 1: Create the venv and install dependencies**

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install --upgrade pip
.venv/Scripts/python.exe -m pip install fastapi uvicorn[standard] sqlalchemy alembic pydantic-settings \
  pyxform argon2-cffi pyjwt cryptography python-multipart openpyxl \
  google-api-python-client google-auth pytest httpx pip-audit
.venv/Scripts/python.exe -m pip freeze > server/requirements.txt
```

- [ ] **Step 2: Write the failing test**

```python
# server/tests/test_health.py
def test_health_reports_ok(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}

def test_settings_refuse_missing_secret(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    get_settings.cache_clear()
    with pytest.raises(ValidationError):
        get_settings()
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `.venv/Scripts/python.exe -m pytest server/tests/test_health.py -v`
Expected: FAIL — `ModuleNotFoundError: app.main`

- [ ] **Step 4: Implement `Settings` and `get_settings()` in `config.py`, and `GET /health` in `main.py`**

`jwt_secret` and `media_key` have no defaults, so a missing environment variable raises at startup rather than falling back to a guessable value. `.env.example` lists every key with empty values and a comment.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `.venv/Scripts/python.exe -m pytest server/tests -v` → PASS

- [ ] **Step 6: Add `package.json` with no dependencies**

```json
{
  "name": "survey-platform",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test webapp/tests/",
    "serve": "node tools/serve.js 8008"
  }
}
```

There are no `dependencies` or `devDependencies` and there must never be any; `node --test` is built in. `tools/serve.js` is a ~30-line static file server over `node:http` used only for running the browser harness and previewing the PWA locally.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: project scaffold, settings and health check"
```

---

## Task 2: Database models and migrations

**Files:**
- Create: `server/app/db/models.py`, `server/app/db/session.py`, `server/alembic.ini`, `server/migrations/`
- Test: `server/tests/test_models.py`

**Interfaces:**
- Consumes: `get_settings()` from Task 1.
- Produces: `Base`, and models `User`, `Form`, `FormVersion`, `Dataset`, `Assignment`, `Submission`, `RepeatRow`, `MediaFile`, `AuditLog`, `ExportJob`, `RefreshToken` with the columns listed in spec §5. `get_session() -> Iterator[Session]` FastAPI dependency. `db` pytest fixture giving an empty in-memory SQLite session.

- [ ] **Step 1: Write the failing tests**

```python
def test_submission_uuid_is_unique(db):
    db.add(Submission(uuid="u1", form_version_id=fv.id, submitted_by=user.id)); db.commit()
    db.add(Submission(uuid="u1", form_version_id=fv.id, submitted_by=user.id))
    with pytest.raises(IntegrityError):
        db.commit()

def test_only_one_current_version_per_form(db):
    # publishing v2 clears is_current on v1
    assert [v.version for v in form.versions if v.is_current] == ["2"]

def test_audit_rows_are_never_mutated_by_the_api():
    """Append-only is enforced by discipline plus this test. SQLite cannot express a
    table-level grant, so the deployment adds one on PostgreSQL (see OPERATIONS.md)."""
    src = " ".join(p.read_text(encoding="utf-8") for p in (ROOT/"server/app/api").rglob("*.py"))
    assert "delete(AuditLog)" not in src
    assert not re.search(r"\baudit(_row|_log)?\.\w+\s*=", src)
```

- [ ] **Step 2: Run and confirm failure** — `.venv/Scripts/python.exe -m pytest server/tests/test_models.py -v`

- [ ] **Step 3: Implement the models in `models.py`**

Use SQLAlchemy 2.x `Mapped[]` / `mapped_column()`. `Submission.data_json` and `RepeatRow.data_json` are `JSON`. `submissions.uuid` carries `unique=True, index=True`. `status` is a string column constrained to `received|flagged|approved|rejected`. Timestamps are timezone-aware UTC.

- [ ] **Step 4: Wire `session.py` and initialise Alembic**

```bash
cd server && ../.venv/Scripts/python.exe -m alembic init migrations
../.venv/Scripts/python.exe -m alembic revision --autogenerate -m "initial schema"
../.venv/Scripts/python.exe -m alembic upgrade head
```

- [ ] **Step 5: Run the tests** → PASS

- [ ] **Step 6: Commit** — `git commit -m "feat: database models and initial migration"`

---

## Task 3: Password hashing and tokens

**Files:**
- Create: `server/app/core/security.py`
- Test: `server/tests/test_security.py`

**Interfaces:**
- Produces: `hash_password(plain: str) -> str`; `verify_password(plain: str, hashed: str) -> bool`; `create_access_token(user_id: int, role: str) -> str`; `decode_access_token(token: str) -> TokenClaims`; `new_refresh_token() -> tuple[str, str]` returning `(plaintext, sha256_hash)`. `TokenClaims` is a dataclass with `user_id: int`, `role: str`, `exp: datetime`.

- [ ] **Step 1: Write the failing tests**

```python
def test_hash_is_argon2id_and_not_the_plaintext():
    h = hash_password("sita@2026")
    assert h.startswith("$argon2id$") and "sita@2026" not in h

def test_verify_accepts_right_and_rejects_wrong():
    h = hash_password("sita@2026")
    assert verify_password("sita@2026", h) and not verify_password("sita@2025", h)

def test_same_password_hashes_differently():
    assert hash_password("x") != hash_password("x")

def test_access_token_round_trips_and_carries_role():
    c = decode_access_token(create_access_token(7, "enumerator"))
    assert (c.user_id, c.role) == (7, "enumerator")

def test_expired_token_is_rejected():
    with freeze(days=1):
        with pytest.raises(TokenExpired):
            decode_access_token(tok)

def test_token_signed_with_another_secret_is_rejected():
    with pytest.raises(TokenInvalid):
        decode_access_token(jwt.encode({...}, "other-secret", algorithm="HS256"))

def test_refresh_token_is_stored_only_as_a_hash():
    plain, hashed = new_refresh_token()
    assert plain != hashed and len(plain) >= 43
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement `security.py`**

argon2-cffi's `PasswordHasher` with library defaults. Access-token lifetime 15 minutes, algorithm HS256, `jwt_secret` from settings. `decode_access_token` raises `TokenExpired` / `TokenInvalid` — never returns `None`, so a caller cannot forget to check.

- [ ] **Step 4: Run the tests** → PASS

- [ ] **Step 5: Commit** — `git commit -m "feat: argon2id hashing and JWT access tokens"`

---

## Task 4: Login, refresh rotation and rate limiting

**Files:**
- Create: `server/app/api/auth.py`, `server/app/core/ratelimit.py`
- Modify: `server/app/main.py` (include the router)
- Test: `server/tests/test_auth_api.py`, `server/tests/test_ratelimit.py`

**Interfaces:**
- Consumes: Task 3's functions; `RefreshToken`, `User` from Task 2.
- Produces: `POST /api/auth/login` taking `{username, password}` returning `{access_token, refresh_token, user: {id, username, full_name, role}}`; `POST /api/auth/refresh` taking `{refresh_token}`; `POST /api/auth/logout`. `RateLimiter(limit: int, window_seconds: int)` with `check(key: str) -> None` raising `RateLimited`.

- [ ] **Step 1: Write the failing tests**

```python
def test_login_returns_tokens_for_valid_credentials(client, user_factory): ...
def test_login_rejects_wrong_password_with_401(client): ...
def test_login_error_is_identical_for_unknown_user_and_wrong_password(client):
    a = client.post("/api/auth/login", json={"username": "nobody", "password": "x"})
    b = client.post("/api/auth/login", json={"username": "sita", "password": "wrong"})
    assert a.status_code == b.status_code == 401 and a.json() == b.json()

def test_login_rejects_a_deactivated_user(client): ...
def test_response_never_contains_the_password_hash(client):
    assert "argon2" not in client.post(...).text

def test_refresh_issues_a_new_pair_and_revokes_the_old(client): ...
def test_reusing_a_rotated_refresh_token_revokes_the_whole_family(client):
    # replaying old_rt after rotation must 401 AND invalidate new_rt
    assert client.post("/api/auth/refresh", json={"refresh_token": new_rt}).status_code == 401

def test_sixth_failed_login_in_the_window_is_rate_limited(client):
    for _ in range(5): client.post("/api/auth/login", json=bad)
    assert client.post("/api/auth/login", json=bad).status_code == 429

def test_rate_limit_is_per_username_not_global(client):
    # locking out "sita" must not lock out "ram"
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement `ratelimit.py` then `auth.py`**

`RateLimiter` keeps an in-process fixed-window counter; the limit key is `f"login:{username}"` and `f"login:ip:{ip}"`, both checked. Login runs `verify_password` even when the user does not exist, against a dummy hash, so response timing does not disclose which usernames are real. Refresh rotation sets `replaced_by` on the old row; presenting a token whose `replaced_by` is already set revokes every token in that chain.

- [ ] **Step 4: Run the tests** → PASS

- [ ] **Step 5: Commit** — `git commit -m "feat: login, refresh rotation and login rate limiting"`

---

## Task 5: Role enforcement and the audit log

**Files:**
- Create: `server/app/core/rbac.py`, `server/app/core/audit.py`
- Test: `server/tests/test_rbac.py`, `server/tests/test_audit.py`

**Interfaces:**
- Produces: `require_role(*roles: str) -> Callable` FastAPI dependency returning the `User`; `current_user` dependency; `record(db, actor_id, action, object_type, object_id, request, detail=None) -> None` in `audit.py`.

- [ ] **Step 1: Write the failing tests**

```python
def test_enumerator_is_refused_an_admin_route(client, as_enumerator):
    assert client.get("/api/users").status_code == 403

def test_missing_token_is_401_not_403(client):
    assert client.get("/api/users").status_code == 401

def test_role_comes_from_the_database_not_the_token(client, as_enumerator):
    # a token minted with role="admin" for an enumerator user is still refused
    assert client.get("/api/users", headers=forged).status_code == 403

def test_audit_records_actor_action_ip_and_time(db, request_stub):
    record(db, 3, "form.publish", "form_version", 9, request_stub)
    row = db.query(AuditLog).one()
    assert (row.actor_user_id, row.action, row.ip) == (3, "form.publish", "10.0.0.5")

def test_audit_detail_never_stores_a_password_or_token(db, request_stub):
    record(db, 3, "auth.login", "user", 3, request_stub, detail={"password": "x", "ok": True})
    assert "password" not in db.query(AuditLog).one().detail_json
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement `rbac.py` and `audit.py`**

`require_role` decodes the token, loads the `User` row, and compares the **database** role, so a forged or stale claim cannot escalate. `record()` strips any key matching `password|token|secret|key` from `detail` before writing.

- [ ] **Step 4: Run the tests** → PASS

- [ ] **Step 5: Commit** — `git commit -m "feat: server-side role enforcement and append-only audit log"`

---

## Task 6: Expression evaluator (Python) and the shared corpus

**Files:**
- Create: `server/app/forms/expr.py`, `shared/expr_cases.json`
- Test: `server/tests/test_expr.py`

**Interfaces:**
- Produces: `evaluate(expression: str, context: Context) -> Any`; `parse(expression: str) -> Node` raising `UnsupportedExpression(expression, reason)`; `Context` dataclass with `values: dict[str, Any]`, `current: Any`, `now: datetime`, `repeat_index: int = 0`.
- `shared/expr_cases.json` is a list of `{"name", "expr", "values", "current", "now", "expect"}` objects, or `{"name", "expr", "unsupported": true}`.

- [ ] **Step 1: Write `shared/expr_cases.json` with the first cases**

Cover each supported construct from spec §3: `${field}` reference, `.`, comparisons, `and`/`or`/`not()`, arithmetic, `selected()`, `count()`, `count-selected()`, `sum()`, `if()`, `string-length()`, `regex()`, `concat()`, `number()`, `int()`, `today()`, `now()`, `coalesce()`, `position()`, `indexed-repeat()`. Include at least: `${age} >= 6 and ${age} <= 59`; `selected(${symptoms}, 'pallor')`; `if(${wt} > 0, ${wt} div 2, 0)`; `count(${children}) > 0`; and three `"unsupported": true` cases such as `instance('x')/root/item[./name = ${a}]/label`.

- [ ] **Step 2: Write the failing test**

```python
CASES = json.loads((ROOT / "shared/expr_cases.json").read_text(encoding="utf-8"))

@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_expression_corpus(case):
    if case.get("unsupported"):
        with pytest.raises(UnsupportedExpression):
            parse(case["expr"])
    else:
        ctx = Context(values=case["values"], current=case.get("current"),
                      now=datetime.fromisoformat(case["now"]))
        assert evaluate(case["expr"], ctx) == case["expect"]
```

**Review Focus 3 — wrong device clock.** Add to the corpus and assert here:

```python
def test_today_uses_the_server_supplied_clock_not_the_host_clock():
    ctx = Context(values={}, current=None, now=datetime(2026, 1, 1, tzinfo=UTC))
    assert evaluate("today()", ctx) == date(2026, 1, 1)
    # the evaluator must never call date.today() itself
    assert "date.today()" not in (SRC / "expr.py").read_text()
```

- [ ] **Step 3: Run and confirm failure**

- [ ] **Step 4: Implement `expr.py`**

A hand-written tokenizer and recursive-descent parser producing a small AST, then a tree-walking evaluator. Precedence, lowest to highest: `or`, `and`, comparison, `+ -`, `* div mod`, unary `not -`, primary. Any token, function name or construct outside the supported list raises `UnsupportedExpression` at **parse** time, so an unsupported form is rejected before publish rather than at data-entry time. Time comes only from `Context.now`.

- [ ] **Step 5: Run the tests** → PASS

- [ ] **Step 6: Commit** — `git commit -m "feat: XForm expression evaluator and shared test corpus"`

---

## Task 7: XLSForm to XForm XML

**Files:**
- Create: `server/app/forms/xlsform.py`, `server/tests/fixtures/amb_asha_visit.xlsx`, `server/tests/fixtures/make_fixtures.py`
- Test: `server/tests/test_xlsform.py`

**Interfaces:**
- Produces: `to_xform(xlsx_bytes: bytes) -> str` returning XForm XML, raising `XLSFormError(messages: list[str])`.

- [ ] **Step 1: Write `make_fixtures.py` to build the test XLSForms with openpyxl**

One realistic Anemia Mukt Bihar form with `survey`, `choices` and `settings` sheets, Hindi `label::hi (Hindi)` and English `label::en (English)` columns, a cascading district→block `choice_filter`, a constraint with a Hindi `constraint_message`, a `geopoint`, an `image`, and a repeat of children. One deliberately broken form for the error test.

- [ ] **Step 2: Write the failing tests**

```python
def test_produces_xform_xml_with_the_form_id():
    xml = to_xform(FIXTURE.read_bytes())
    assert "<h:html" in xml and 'id="amb_asha_visit"' in xml

def test_hindi_labels_survive_the_conversion():        # Review Focus 1
    assert "ज़िला" in to_xform(FIXTURE.read_bytes())

def test_both_languages_are_present():
    xml = to_xform(FIXTURE.read_bytes())
    assert 'lang="hi (Hindi)"' in xml and 'lang="en (English)"' in xml

def test_a_broken_xlsform_raises_with_a_readable_message():
    with pytest.raises(XLSFormError) as e:
        to_xform(BROKEN.read_bytes())
    assert any("choices" in m for m in e.value.messages)

def test_a_non_xlsx_payload_raises_rather_than_crashing():
    with pytest.raises(XLSFormError):
        to_xform(b"this is not a spreadsheet")
```

- [ ] **Step 3: Run and confirm failure**

- [ ] **Step 4: Implement `to_xform()`**

Write the bytes to a temporary file, call `pyxform.xls2xform.convert`, read the XML back as UTF-8, and translate `PyXFormError` and `TypeError` into `XLSFormError`. Delete the temporary file in a `finally`.

- [ ] **Step 5: Run the tests** → PASS

- [ ] **Step 6: Commit** — `git commit -m "feat: XLSForm to XForm XML conversion"`

---

## Task 8: XForm XML to JSON form spec

**Files:**
- Create: `server/app/forms/compile.py`
- Test: `server/tests/test_compile.py`

**Interfaces:**
- Consumes: `to_xform()` (Task 7), `parse()` / `UnsupportedExpression` (Task 6).
- Produces: `compile_spec(xform_xml: str) -> dict` in the shape of spec §3, raising `UnsupportedExpression` for any expression the evaluator cannot parse.

- [ ] **Step 1: Write the failing tests**

```python
def test_spec_carries_form_id_version_and_languages(): ...
def test_labels_are_keyed_by_short_language_code():
    assert node["label"] == {"hi": "ज़िला", "en": "District"}   # Review Focus 1

def test_question_types_are_mapped():
    assert types_in(spec) >= {"select_one","integer","geopoint","image","repeat","calculate"}

def test_choice_filter_and_relevant_are_carried_through(): ...
def test_constraint_message_keeps_its_languages(): ...

def test_a_repeat_inside_a_repeat_compiles_with_both_names():   # Review Focus 4
    outer = find(spec, "households"); inner = find(outer["children"], "members")
    assert outer["type"] == inner["type"] == "repeat"

def test_an_unsupported_expression_fails_compilation_loudly():
    with pytest.raises(UnsupportedExpression) as e:
        compile_spec(xml_with_instance_lookup)
    assert "child_age_months" in str(e.value)   # names the offending question
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement `compile_spec()`**

Parse with `xml.etree.ElementTree`, reading `<h:head>/<model>` for bindings and `<itext>` for labels and `<h:body>` for control order and appearance. Map each `<bind>`'s `type` plus the body control to a spec node type. Every `relevant`, `constraint`, `calculate` and `choice_filter` string is run through `parse()` at compile time; a failure is re-raised with the question name attached.

- [ ] **Step 4: Run the tests** → PASS

- [ ] **Step 5: Commit** — `git commit -m "feat: compile XForm XML to the PWA JSON form spec"`

---

## Task 9: Forms API and pre-loaded datasets

**Files:**
- Create: `server/app/api/forms.py`
- Modify: `server/app/main.py`
- Test: `server/tests/test_forms_api.py`

**Interfaces:**
- Produces: `POST /api/forms` (multipart `.xlsx`, supervisor+) → `{form_id, version, warnings}`; `POST /api/forms/{form_id}/publish` → sets `is_current`; `GET /api/forms` → forms the caller is assigned to; `GET /api/forms/{form_id}/versions/{version}/spec` → the JSON spec; `POST /api/datasets/{name}` (CSV upload, supervisor+); `GET /api/datasets/{name}` → `{name, version, rows}`.

- [ ] **Step 1: Write the failing tests**

```python
def test_supervisor_can_upload_and_publish(client, as_supervisor): ...
def test_enumerator_cannot_upload(client, as_enumerator):
    assert client.post("/api/forms", files=xlsx).status_code == 403

def test_publishing_an_unsupported_expression_returns_422_and_publishes_nothing():
    r = client.post("/api/forms", files=bad_xlsx)
    assert r.status_code == 422 and "child_age_months" in r.text
    assert db.query(FormVersion).count() == 0

def test_a_second_publish_creates_a_new_version_and_moves_is_current(): ...
def test_an_old_version_spec_is_still_served_after_a_new_publish(): ...
def test_enumerator_sees_only_assigned_forms(client, as_enumerator): ...
def test_publish_writes_an_audit_row(): ...
def test_dataset_csv_round_trips_devanagari(client, as_supervisor):   # Review Focus 1
    client.post("/api/datasets/blocks", files={"file": ("b.csv", "name\nमुजफ्फरपुर\n".encode("utf-8"))})
    assert client.get("/api/datasets/blocks").json()["rows"][0]["name"] == "मुजफ्फरपुर"
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement `forms.py`**

Upload runs `to_xform()` then `compile_spec()` inside one transaction; either both succeed and a `FormVersion` row is written, or nothing is. `version` is `YYYYMMDDNN`. Publish flips `is_current` within one transaction and calls `audit.record`. Upload is capped at 5 MB and the content type is checked against the file's magic bytes.

- [ ] **Step 4: Run the tests** → PASS

- [ ] **Step 5: Commit** — `git commit -m "feat: form upload, publish, versioning and datasets"`

---

## Task 10: Server-side submission re-validation

**Files:**
- Create: `server/app/forms/validate.py`
- Test: `server/tests/test_validate.py`

**Interfaces:**
- Consumes: `evaluate()` / `Context` (Task 6).
- Produces: `validate_submission(spec: dict, data: dict, repeats: dict[str, list[dict]], now: datetime) -> list[Failure]`; `Failure` is a dataclass with `question: str`, `rule: str` (`"required"` or `"constraint"`), `message: str | None`.

- [ ] **Step 1: Write the failing tests**

```python
def test_a_valid_submission_has_no_failures(): assert validate_submission(spec, good, {}, NOW) == []

def test_a_missing_required_answer_is_reported():
    assert validate_submission(spec, {}, {}, NOW)[0].rule == "required"

def test_a_failed_constraint_returns_its_hindi_message():
    f = validate_submission(spec, {"child_age_months": 72}, {}, NOW)[0]
    assert f.rule == "constraint" and "6" in f.message

def test_a_required_question_hidden_by_relevant_is_not_required():
    # ifa_given is relevant only when age >= 6; at age 3 its absence is fine
    assert validate_submission(spec, {"child_age_months": 3}, {}, NOW) == []

def test_each_repeat_row_is_validated_with_its_own_position():
    fails = validate_submission(spec, good, {"children": [ok_row, bad_row]}, NOW)
    assert fails[0].question == "children[2]/child_age_months"

def test_validation_uses_the_passed_clock():      # Review Focus 3
    assert validate_submission(spec, {"visit_date": "2026-01-05"}, {}, datetime(2026,1,1,tzinfo=UTC))
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement `validate_submission()`**

Walk the spec depth-first. Evaluate `relevant` first; a node that is not relevant is skipped entirely, along with its children, and never reports `required`. For repeats, build a fresh `Context` per row with `repeat_index` set, and prefix failures with `name[index]/`. Collect every failure — do not stop at the first.

- [ ] **Step 4: Run the tests** → PASS

- [ ] **Step 5: Commit** — `git commit -m "feat: server-side re-validation of submissions"`

---

## Task 11: Submissions API, media storage, idempotency and duplicate detection

**Files:**
- Create: `server/app/api/submissions.py`, `server/app/core/crypto.py`
- Test: `server/tests/test_submissions_api.py`, `server/tests/test_crypto.py`

**Interfaces:**
- Consumes: `validate_submission()` (Task 10), `require_role` (Task 5).
- Produces: `store_submission(db, form_version, user, data, repeats, media, uuid, request) -> tuple[Submission, bool]` as a **module-level function** returning the submission and whether it was newly created; `POST /api/submissions` (multipart: `submission` JSON part + media parts) → `201 {uuid, status, failures}` or `200` with the original receipt on replay; `GET /api/submissions?form_id&status&page` (supervisor+, enumerators see only their own); `GET /api/submissions/{uuid}`. `encrypt_bytes(data: bytes) -> bytes` / `decrypt_bytes(blob: bytes) -> bytes` in `crypto.py`. `likely_duplicates(db, submission) -> list[Submission]`.

`store_submission` carries **all** the intake rules — assignment check, size cap, magic-byte check, validation, transaction, idempotency. The route is a thin caller that only translates HTTP. Task 12's OpenRosa endpoint calls the same function, so both clients share one idempotency rule and one validation path by construction rather than by careful duplication.

- [ ] **Step 1: Write the failing tests**

```python
def test_crypto_round_trips_and_ciphertext_differs_each_time():
    a, b = encrypt_bytes(b"photo"), encrypt_bytes(b"photo")
    assert a != b and decrypt_bytes(a) == b"photo"

def test_tampered_ciphertext_is_rejected():
    with pytest.raises(InvalidTag): decrypt_bytes(bytearray(blob)[:-1] + b"\x00")

def test_a_valid_submission_is_stored_with_its_repeat_rows_and_media(): ...

def test_the_same_uuid_twice_returns_the_first_receipt(client):      # Review Focus 2
    first = client.post("/api/submissions", files=payload)
    second = client.post("/api/submissions", files=payload)
    assert second.status_code == 200
    assert second.json()["uuid"] == first.json()["uuid"]
    assert db.query(Submission).count() == 1 and db.query(MediaFile).count() == 1

def test_an_invalid_submission_is_stored_as_flagged_not_rejected():
    r = client.post("/api/submissions", files=bad_payload)
    assert r.status_code == 201 and r.json()["status"] == "flagged"
    assert db.query(Submission).count() == 1          # never dropped

def test_received_at_is_the_server_clock_not_the_device_clock():     # Review Focus 3
    payload["finished_at"] = "2001-01-01T00:00:00Z"
    assert client.post(...).json()["received_at"][:4] != "2001"

def test_a_photo_over_settings_max_media_bytes_is_refused_with_no_orphan(): # Review Focus 5
    r = client.post("/api/submissions", files=huge)
    assert r.status_code == 413
    assert db.query(Submission).count() == 0 and list(MEDIA_ROOT.iterdir()) == []

def test_a_file_whose_magic_bytes_are_not_an_image_is_refused(): ...
def test_media_is_not_written_under_a_client_supplied_name():
    assert "../" not in stored_path and stored_path.name != "evil.php"

def test_an_enumerator_cannot_submit_to_an_unassigned_form():
    assert client.post("/api/submissions", files=other_form).status_code == 403

def test_an_enumerator_listing_submissions_sees_only_their_own(): ...

def test_a_matching_duplicate_key_is_listed_but_both_rows_are_kept():
    assert len(likely_duplicates(db, second)) == 1 and db.query(Submission).count() == 2
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement `crypto.py`**

AES-256-GCM from `cryptography`, key from `settings.media_key`, a fresh 12-byte nonce per call prepended to the ciphertext.

- [ ] **Step 4: Implement `submissions.py`**

Order matters and the tests pin it: check assignment → check size → check magic bytes → validate → **then** open a transaction that writes `Submission`, `RepeatRow`s and `MediaFile`s together. Media is written under `media_root/<uuid>/<question_name>.<ext>` with the extension derived from the sniffed type, never from the client's filename. On an existing UUID, return the stored receipt without touching anything. `likely_duplicates` matches on the form's configured key columns and only reports.

- [ ] **Step 5: Run the tests** → PASS

- [ ] **Step 6: Commit** — `git commit -m "feat: submission intake, media storage, idempotency and duplicate flagging"`

---

## Task 12: OpenRosa endpoints

**Files:**
- Create: `server/app/api/openrosa.py`
- Test: `server/tests/test_openrosa.py`

**Interfaces:**
- Produces: `GET /openrosa/formList` → OpenRosa `xforms` XML; `GET /openrosa/forms/{form_id}/{version}.xml` → the XForm; `HEAD`/`POST /openrosa/submission` → `201` with an `OpenRosaResponse` body. All respond with the `X-OpenRosa-Version: 1.0` header.

- [ ] **Step 1: Write the failing tests**

```python
def test_formlist_lists_published_forms_with_the_openrosa_header():
    r = client.get("/openrosa/formList", auth=basic)
    assert r.headers["X-OpenRosa-Version"] == "1.0" and "<xforms" in r.text

def test_formlist_requires_authentication():
    assert client.get("/openrosa/formList").status_code == 401

def test_head_on_submission_returns_204_with_max_size():
    assert client.head("/openrosa/submission", auth=basic).status_code == 204

def test_a_posted_xml_instance_is_stored_as_a_submission(): ...
def test_replaying_the_same_instance_id_does_not_duplicate(): ...   # Review Focus 2
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement `openrosa.py`**

HTTP Basic against the same user table. The posted `xml_submission_file` is parsed into the same `{data, repeats}` shape Task 11 uses, then passed to Task 11's `store_submission()`. This endpoint contains no intake logic of its own — if it needs a rule, the rule belongs in `store_submission`. `meta/instanceID` becomes the submission UUID.

- [ ] **Step 4: Run the tests** → PASS

- [ ] **Step 5: Commit** — `git commit -m "feat: OpenRosa endpoints for ODK Collect compatibility"`

---

## Task 13: CSV export with repeats and media bundle

**Files:**
- Create: `server/app/export/csv_export.py`, `server/app/export/media.py`
- Test: `server/tests/test_csv_export.py`

**Interfaces:**
- Produces: `build_csvs(spec: dict, submissions: Sequence[Submission]) -> dict[str, bytes]` keyed by filename, the main file first; `build_media_zip(submissions) -> bytes`.

- [ ] **Step 1: Write the failing tests**

```python
def test_main_csv_starts_with_a_utf8_bom():                  # Review Focus 1
    assert build_csvs(spec, subs)["amb_asha_visit.csv"].startswith(b"\xef\xbb\xbf")

def test_devanagari_decodes_correctly_from_the_bytes():      # Review Focus 1
    text = build_csvs(spec, subs)["amb_asha_visit.csv"].decode("utf-8-sig")
    assert "मुजफ्फरपुर" in text

def test_columns_follow_form_order_plus_the_metadata_columns():
    assert header[:3] == ["uuid", "submitted_by", "received_at"]

def test_a_repeat_gets_its_own_file_joined_by_parent_uuid():
    files = build_csvs(spec, subs)
    assert "amb_asha_visit_children.csv" in files
    assert child_header[:2] == ["parent_uuid", "row_index"]

def test_a_repeat_with_zero_rows_still_emits_a_header_only_file():   # Review Focus 4
    files = build_csvs(spec, [sub_with_no_children])
    assert files["amb_asha_visit_children.csv"].decode("utf-8-sig").strip().count("\n") == 0

def test_a_nested_repeat_gets_its_own_file_naming_both_levels():     # Review Focus 4
    assert "amb_asha_visit_households_members.csv" in build_csvs(spec, subs)

def test_select_multiple_is_written_space_separated(): ...
def test_geopoint_is_split_into_lat_lon_and_accuracy_columns(): ...

def test_the_media_column_matches_a_name_inside_the_zip():
    name = row["register_photo"]
    assert name in zipfile.ZipFile(io.BytesIO(build_media_zip(subs))).namelist()

def test_a_field_starting_with_equals_is_prefixed_to_defuse_excel():
    assert row_bytes_contain("'=cmd|")   # CSV injection
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement `build_csvs()` and `build_media_zip()`**

Walk the spec once to produce the column list per file, so a repeat with no rows still yields its header. Write with `csv.writer` into a `StringIO` using `\r\n`, encode UTF-8 and prepend the BOM. Any value whose first character is `= + - @` is prefixed with `'`. Media is decrypted through `crypto.decrypt_bytes` on the way into the zip.

- [ ] **Step 4: Run the tests** → PASS

- [ ] **Step 5: Commit** — `git commit -m "feat: CSV export with child files for repeats, and media bundle"`

---

## Task 14: Google Drive, Google Sheets and the export API

**Files:**
- Create: `server/app/export/drive.py`, `server/app/export/sheets.py`, `server/app/api/exports.py`
- Test: `server/tests/test_drive.py`, `server/tests/test_exports_api.py`

**Interfaces:**
- Produces: `DriveUploader(client)` with `upload(folder_id: str, filename: str, data: bytes, mime: str) -> str` returning a file id; `SheetWriter(client)` with `replace(sheet_id: str, tab: str, rows: list[list[str]]) -> None`; `build_google_client(settings)` reading the service-account key from the environment. `POST /api/exports {form_id}` → `202 {job_id}`; `GET /api/exports/{job_id}`; `GET /api/exports/{job_id}/download`.
- Tests inject a fake client; no test ever reaches Google.

- [ ] **Step 1: Write the failing tests**

```python
def test_uploader_sends_every_file_and_returns_their_ids(fake_drive): ...
def test_a_transient_503_is_retried_then_succeeds(fake_drive): ...
def test_a_permanent_403_marks_the_job_failed_with_the_reason(fake_drive): ...
def test_the_service_account_key_is_never_logged(caplog):
    assert "private_key" not in caplog.text

def test_sheet_replace_clears_before_writing(fake_sheets):
    assert [c[0] for c in fake_sheets.calls] == ["clear", "update"]

def test_export_runs_end_to_end_and_records_the_drive_file_id(client, as_supervisor): ...
def test_an_enumerator_cannot_start_an_export(client, as_enumerator):
    assert client.post("/api/exports", json={"form_id": "x"}).status_code == 403

def test_a_failed_export_leaves_the_job_row_with_its_error_not_deleted(): ...
def test_export_writes_an_audit_row(): ...
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement `drive.py`, `sheets.py`, then `exports.py`**

Both wrappers take an already-built client, which is what makes them testable. Retry `429` and `5xx` three times with exponential backoff; treat `4xx` other than `429` as permanent. Exported filenames are `<form_id>_<timestamp>.csv`, `<form_id>_<repeat_path>_<timestamp>.csv` and `<form_id>_media_<timestamp>.zip`. `exports.py` runs the job in a FastAPI `BackgroundTasks` and updates `ExportJob.status` through `running → done | failed`, always recording the error text on failure.

- [ ] **Step 4: Run the tests** → PASS

- [ ] **Step 5: Commit** — `git commit -m "feat: Google Drive and Sheets export with a job API"`

---

## Task 15: Admin API for users and assignments

**Files:**
- Create: `server/app/api/admin.py`
- Test: `server/tests/test_admin_api.py`

**Interfaces:**
- Produces: `GET/POST /api/users` (admin), `PATCH /api/users/{id}` (deactivate, change role, reset password), `POST /api/assignments`, `DELETE /api/assignments/{id}`, `GET /api/audit` (admin, paginated, filterable by actor and action).

- [ ] **Step 1: Write the failing tests**

```python
def test_admin_creates_a_user_and_the_response_has_no_hash(): ...
def test_a_weak_password_is_refused_with_a_clear_message():
    assert client.post("/api/users", json={"password": "1234", ...}).status_code == 422

def test_deactivating_a_user_revokes_their_refresh_tokens():
    client.patch(f"/api/users/{uid}", json={"is_active": False})
    assert client.post("/api/auth/refresh", json={"refresh_token": rt}).status_code == 401

def test_an_admin_cannot_deactivate_their_own_last_admin_account(): ...
def test_a_supervisor_cannot_create_users(): assert ... == 403
def test_every_user_change_writes_an_audit_row(): ...
def test_audit_list_is_read_only():
    assert client.delete("/api/audit/1").status_code in (404, 405)
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement `admin.py`**

Password policy: at least 10 characters, not in a small list of obvious choices. Deactivation revokes the user's whole refresh-token family in the same transaction. The audit router exposes read routes only.

- [ ] **Step 4: Run the tests** → PASS

- [ ] **Step 5: Commit** — `git commit -m "feat: user, assignment and audit administration"`

---

## Task 16: PWA storage layer

**Files:**
- Create: `webapp/js/db.js`, `webapp/tests/browser.html`, `webapp/tests/browser_db.js`
- Test: the browser harness, driven through the built-in browser pane

**Interfaces:**
- Produces, all returning promises: `openDB()`; `putForm(spec)` / `getForm(formId, version)` / `listForms()`; `putDataset(name, rows)` / `getDataset(name)`; `saveDraft(draft)` / `getDraft(id)` / `listDrafts()` / `deleteDraft(id)`; `enqueue(submission, mediaBlobs)` / `peekQueue(n)` / `dequeue(uuid)` / `queueLength()`; `putSession(s)` / `getSession()` / `clearSession()`.

- [ ] **Step 1: Write `browser.html` as a minimal reporting harness**

It imports each `browser_*.js` module, runs exported `test_*` functions, and writes a JSON result array to `window.__results`, which the driver reads.

- [ ] **Step 2: Write the failing tests in `browser_db.js`**

```javascript
export async function test_draft_survives_a_reopen()         // put, close, openDB, get
export async function test_enqueue_stores_media_with_the_submission()
export async function test_dequeue_removes_the_submission_and_its_media()
export async function test_queue_survives_a_page_reload()    // Review Focus 5
export async function test_a_second_enqueue_of_one_uuid_does_not_duplicate()  // Review Focus 2
export async function test_devanagari_round_trips_through_indexeddb()         // Review Focus 1
```

- [ ] **Step 3: Serve the harness and run it, confirming failure**

```bash
node --run serve   # or: node -e "..." static server on :8008
```
Then load `http://localhost:8008/webapp/tests/browser.html` in the browser pane and read `window.__results`. Expected: every test errors with `openDB is not defined`.

- [ ] **Step 4: Implement `db.js`**

One IndexedDB database, version 1, object stores `forms` (key `[form_id, version]`), `preload` (key `name`), `drafts` (key `id`), `queue` (key `uuid`), `media` (key `[uuid, question]`), `session` (key `id`). `enqueue` writes the submission and all its media in **one** transaction so a crash cannot leave media without its submission.

- [ ] **Step 5: Re-run the harness** → all pass

- [ ] **Step 6: Commit** — `git commit -m "feat: PWA IndexedDB storage layer"`

---

## Task 17: Expression evaluator (JavaScript) — parity with Python

**Files:**
- Create: `webapp/js/expr.js`, `webapp/tests/expr.test.js`
- Test: `node --test webapp/tests/expr.test.js`

**Interfaces:**
- Produces: `evaluate(expression, context)` and `parse(expression)` throwing `UnsupportedExpression`, with `context = {values, current, now, repeatIndex}` — the same semantics as `expr.py`.

- [ ] **Step 1: Write the failing test, reading the same corpus**

```javascript
import cases from "../../shared/expr_cases.json" with { type: "json" };
for (const c of cases) {
  test(c.name, () => {
    if (c.unsupported) { assert.throws(() => parse(c.expr), UnsupportedExpression); }
    else { assert.deepEqual(evaluate(c.expr, ctxFrom(c)), c.expect); }
  });
}
test("the corpus is not empty", () => assert.ok(cases.length >= 25));
```

- [ ] **Step 2: Run and confirm failure** — `node --test webapp/tests/expr.test.js`

- [ ] **Step 3: Implement `expr.js` as a direct port of `expr.py`**

Same tokenizer, same precedence table, same supported-function list, same `UnsupportedExpression` on anything else. Dates come only from `context.now`; `Date.now()` must not appear in the file.

- [ ] **Step 4: Run both suites and confirm they agree**

```bash
node --test webapp/tests/expr.test.js
.venv/Scripts/python.exe -m pytest server/tests/test_expr.py -v
```
Both must pass over the identical corpus.

- [ ] **Step 5: Commit** — `git commit -m "feat: JavaScript expression evaluator at parity with the Python one"`

---

## Task 18: PWA form engine and i18n

**Files:**
- Create: `webapp/js/formengine.js`, `webapp/js/i18n.js`, `webapp/tests/formengine.test.js`, `webapp/tests/i18n.test.js`

**Interfaces:**
- Produces: `class FormEngine(spec, {now})` with `setAnswer(name, value)`, `getAnswer(name)`, `visibleNodes()`, `errors()`, `addRepeatRow(name)`, `removeRepeatRow(name, index)`, `toSubmission() -> {data, repeats}`, `isComplete()`. `label(node, lang)` and `availableLanguages(spec)` in `i18n.js`.

- [ ] **Step 1: Write the failing tests**

```javascript
test("a question whose relevant is false is not visible")
test("answering the trigger reveals the dependent question")
test("hiding a question clears its answer so stale data is not submitted")
test("a calculate recomputes when its input changes")
test("a constraint violation appears in errors() with its message")
test("a required empty question blocks isComplete()")
test("a required question that is not relevant does not block isComplete()")
test("choice_filter narrows blocks to the chosen district")
test("adding two repeat rows yields two rows in toSubmission()")
test("removing a repeat row renumbers position() for the rows after it")
test("a nested repeat round-trips through toSubmission()")        // Review Focus 4
test("label() falls back to the default language when a translation is missing")
test("label() returns the Hindi string when lang is hi")          // Review Focus 1
```

- [ ] **Step 2: Run and confirm failure** — `node --test webapp/tests/`

- [ ] **Step 3: Implement `formengine.js` and `i18n.js`**

The engine holds a flat `values` map plus repeat arrays, and recomputes relevance, calculates and constraints after every `setAnswer` by walking the spec in order. Clearing a hidden answer is deliberate: a value the enumerator can no longer see must not reach the server.

- [ ] **Step 4: Run the tests** → PASS

- [ ] **Step 5: Commit** — `git commit -m "feat: PWA form engine with skip logic, calculates, repeats and i18n"`

---

## Task 19: Question renderers, GPS and photo capture

**Files:**
- Create: `webapp/js/render.js`, `webapp/index.html`, `webapp/css/app.css`, `webapp/tests/browser_render.js`
- Modify: `webapp/tests/browser.html`

**Interfaces:**
- Consumes: `FormEngine` (Task 18), `label()` (Task 18).
- Produces: `renderNode(node, engine, lang) -> HTMLElement`; `captureLocation({minAccuracy, timeoutMs}) -> Promise<{lat, lon, accuracy}>`; `downscaleImage(file, maxEdge) -> Promise<Blob>`.

- [ ] **Step 1: Write the failing browser tests**

```javascript
export async function test_every_spec_type_renders_an_input()      // no "unsupported type" placeholder
export async function test_a_select_one_renders_its_choice_labels_in_hindi()
export async function test_typing_an_answer_updates_the_engine()
export async function test_a_constraint_error_is_shown_next_to_the_question()
export async function test_downscale_reduces_a_large_photo_below_max_media_bytes()  // Review Focus 5
export async function test_capture_location_rejects_when_accuracy_never_improves()
export async function test_capture_location_returns_accuracy_alongside_the_point()
```

- [ ] **Step 2: Run the harness and confirm failure**

- [ ] **Step 3: Implement `render.js`, `index.html` and `app.css`**

One renderer per spec type; the dispatcher throws on an unknown type rather than rendering a blank, so a gap is loud. `captureLocation` uses `watchPosition`, resolves once accuracy is within `minAccuracy`, and on timeout rejects with the best fix so far attached so the UI can offer it for deliberate acceptance. `downscaleImage` draws to a canvas and exports JPEG at quality 0.8, retrying at a smaller edge until the blob is under `maxBytes`, which the caller reads from the server's `max_media_bytes` (surfaced in the bootstrap response) so the cap is never written twice. Touch targets are at least 44 px and the layout is single-column, for a phone held one-handed in the field.

- [ ] **Step 4: Re-run the harness** → all pass

- [ ] **Step 5: Commit** — `git commit -m "feat: question renderers, GPS capture and photo downscaling"`

---

## Task 20: Authentication, sync queue and service worker

**Files:**
- Create: `webapp/js/auth.js`, `webapp/js/sync.js`, `webapp/sw.js`, `webapp/manifest.webmanifest`, `webapp/tests/sync.test.js`, `webapp/tests/browser_sync.js`

**Interfaces:**
- Consumes: `db.js` (Task 16).
- Produces: `login(username, password)`, `authFetch(url, opts)` refreshing once on `401`, `logout()`; `bootstrap(fetchImpl) -> {forms, datasets}` downloading the caller's assigned form specs and every dataset they reference into IndexedDB; `syncOnce(fetchImpl) -> {uploaded, failed, remaining}`, `startSync()`, `stopSync()`.

- [ ] **Step 1: Write the failing unit tests (no browser needed)**

```javascript
test("syncOnce uploads queued submissions oldest first")
test("a 200 replay response dequeues without counting a new upload")   // Review Focus 2
test("a 5xx leaves the submission queued for the next run")
test("a 413 removes the submission from the queue and records it as rejected")  // Review Focus 5
test("one rejected submission does not block the rest of the queue")   // Review Focus 5
test("a 401 triggers exactly one refresh then one retry")
test("backoff grows between consecutive failures")
test("bootstrap stores every assigned form spec and its referenced datasets")
test("bootstrap downloads a newer published version without touching open drafts")
test("a draft started on an old version still reports that version on submit")
```

- [ ] **Step 2: Write the failing browser tests**

```javascript
export async function test_offline_fill_then_online_sync_arrives_exactly_once()  // Review Focus 2
export async function test_the_queue_is_intact_after_a_reload_mid_sync()         // Review Focus 5
export async function test_the_app_shell_loads_with_the_network_disabled()
```

- [ ] **Step 3: Run both and confirm failure**

- [ ] **Step 4: Implement `auth.js`, `sync.js`, `sw.js` and the manifest**

`sync.js` takes `fetchImpl` as a parameter so the unit tests pass a stub. Uploads are strictly one at a time; a `4xx` other than `401` dequeues and records a rejection, a `5xx` or network error leaves the item queued and backs off. `bootstrap()` runs after login and on every later reconnection; it writes each new form version alongside the old one rather than replacing it, because a draft in progress must finish on the version it started on. The service worker caches the app shell with a cache-first strategy and a version string bumped on release; API calls are never cached.

- [ ] **Step 5: Run both suites** → PASS

- [ ] **Step 6: Commit** — `git commit -m "feat: PWA auth, offline sync queue and service worker"`

---

## Task 21: Console pages

**Files:**
- Create: `webapp/console/index.html`, `forms.html`, `submissions.html`, `exports.html`, `users.html`, `webapp/console/js/*.js`
- Test: `webapp/tests/browser_console.js`

**Interfaces:**
- Consumes: `authFetch` (Task 20), the APIs from Tasks 9, 11, 14, 15.

- [ ] **Step 1: Write the failing browser tests**

```javascript
export async function test_uploading_an_xlsform_shows_its_questions_before_publish()
export async function test_a_publish_error_shows_the_offending_question_name()
export async function test_the_submission_list_paginates_and_filters_by_status()
export async function test_opening_a_submission_shows_its_answers_and_photos()
export async function test_flagged_submissions_show_their_validation_failures()
export async function test_an_export_shows_progress_then_the_drive_link()
export async function test_an_enumerator_opening_the_console_is_sent_away()
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement the console pages**

Plain ES modules, same `authFetch`. The form upload page shows the compiled spec as a question list so a supervisor can check a form before publishing. Hiding a control for a role is presentation only — every page assumes the server will refuse anyway.

- [ ] **Step 4: Run the tests** → PASS

- [ ] **Step 5: Commit** — `git commit -m "feat: admin console for forms, submissions, exports and users"`

---

## Task 22: End-to-end test and documentation

**Files:**
- Create: `server/tests/test_end_to_end.py`, `ARCHITECTURE.md`, `README.md`, `docs/OPERATIONS.md`
- Test: `server/tests/test_end_to_end.py`

- [ ] **Step 1: Write the failing end-to-end test**

```python
def test_the_whole_path_from_xlsform_to_drive(client, fake_drive, fake_sheets):
    # admin creates a supervisor and an enumerator
    # supervisor uploads and publishes the Anemia Mukt Bihar fixture
    # supervisor assigns the form to the enumerator
    # enumerator fetches the spec, submits two submissions with a photo and a repeat
    # one submission is a replay of the first: total stays at two
    # supervisor exports; assert the main CSV, the child CSV and the media zip
    #   all reached the fake Drive, and the Sheet was cleared then written
    assert sorted(fake_drive.uploaded) == [
        "amb_asha_visit.csv", "amb_asha_visit_children.csv", "amb_asha_visit_media.zip"]
    assert "मुजफ्फरपुर" in fake_drive.body("amb_asha_visit.csv").decode("utf-8-sig")
```

- [ ] **Step 2: Run it and fix whatever integration gaps it exposes**

This test is the gate on the whole plan. If it needs production code changed, change it here.

- [ ] **Step 3: Write `ARCHITECTURE.md`**

Components and how they fit; the data model; the sync protocol including the idempotency rule; the **full Phase 2 end-to-end encryption design** from spec §7 so it can be built without redesign; and the threat model, stating plainly that without E2E encryption a server compromise exposes submission data.

- [ ] **Step 4: Write `README.md`**

Setup, running the server, running both test suites, deployment with TLS, Google service-account setup, and a short Hindi section (`## हिंदी में — शुरू कैसे करें`) covering install, first admin user, uploading a form, and where exports land.

- [ ] **Step 5: Write `docs/OPERATIONS.md`**

Backups, PostgreSQL migration from SQLite, key rotation for `media_key`, and what to do when an export fails.

- [ ] **Step 6: Commit** — `git commit -m "docs: architecture, README and operations guide; end-to-end test"`

---

## Task 23: Security review

**Files:**
- Create: `docs/SECURITY-REVIEW.md`
- Modify: whatever the review finds

- [ ] **Step 1: Run the dependency audit**

```bash
.venv/Scripts/python.exe -m pip_audit -r server/requirements.txt
```

- [ ] **Step 2: Add security response headers and confirm with a test**

```python
def test_security_headers_are_present(client):
    h = client.get("/health").headers
    assert h["X-Content-Type-Options"] == "nosniff"
    assert "default-src 'self'" in h["Content-Security-Policy"]
    assert "unsafe-inline" not in h["Content-Security-Policy"]
```

- [ ] **Step 3: Run the `security-review` skill over the whole branch**

- [ ] **Step 4: Fix what it finds, each with a regression test**

- [ ] **Step 5: Write `docs/SECURITY-REVIEW.md`**

Three sections, no hedging: **Done** — each control with the test that proves it. **Open** — each finding not fixed, with its risk and why it was deferred. **Not in Phase 1** — form-level end-to-end encryption, device passcode gating of IndexedDB, and ODK Collect verified against the real app, each with the honest consequence of its absence.

- [ ] **Step 6: Run every suite one last time**

```bash
.venv/Scripts/python.exe -m pytest server/tests -v
node --test webapp/tests/
```

- [ ] **Step 7: Commit** — `git commit -m "docs: security review findings and fixes"`
