# Running the survey platform: operations guide

For the person who deploys it and keeps it running. Setup is in `README.md`; how it is
built is in `ARCHITECTURE.md`. Commands are Windows PowerShell from the project folder
unless a path says Linux.

## Before real data arrives: a checklist

- [ ] `JWT_SECRET` and `MEDIA_KEY` set; `MEDIA_KEY` copied somewhere safe, away from the server.
- [ ] Running behind https (Caddy or nginx), see `README.md` section 6.
- [ ] **Upload size limit set at the proxy** (below).
- [ ] **`TRUST_PROXY_HEADERS=true` and `TRUSTED_PROXY_HOPS=1` set** (below).
- [ ] **One server worker process** (below).
- [ ] Google: the folder is in a **Shared Drive** and the service account is a **Content manager**.
- [ ] A **backup has been made and a restore has been tried once.**
- [ ] Decided: SQLite or PostgreSQL (below). Decide **before** collecting real data; moving later is harder.
- [ ] Everyone who will see data knows: **answers are not end-to-end encrypted** (`ARCHITECTURE.md`).

## What has to be protected

| Thing | Where | If lost | If stolen |
|---|---|---|---|
| The database | `server/survey.db` (SQLite) or PostgreSQL | All submissions are gone. | Every answer, name and GPS point is readable. |
| Photos | `server/media/` (or `MEDIA_ROOT`) | Photos gone. | Encrypted, but see `MEDIA_KEY`. |
| `MEDIA_KEY` | `.env` | **Every photo becomes unreadable forever.** | With the photos, they can be decrypted. |
| `JWT_SECRET` | `.env` | Everyone is logged out; change it and carry on. | Anyone can sign in as any user, including admin. Change it at once (everyone logs in again). |
| Google key file | wherever `GOOGLE_SERVICE_ACCOUNT_FILE` points | Make a new key in Google Cloud. | They can read and write the Shared Drive. Delete that key in Google Cloud at once. |

## Backups

What to copy: the **database**, the **photos folder**, and **`.env`** (kept separately,
in a safer place, because it holds the keys). The Google key file lives outside the
project; it can be replaced, so it matters less.

**A backup contains readable answers.** Store it with the same care as the server.

### SQLite (the default)

Do not simply copy `survey.db` while the server is running; it may be half-written. Use the
database's own backup, which is safe while the server runs. This was tested on a scratch database:

```powershell
.\.venv\Scripts\python.exe -c "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()" server\survey.db D:\backups\survey-2026-11-01.db
```

Then copy the photos:

```powershell
robocopy server\media D:\backups\media /E
```

**Order matters: database first, photos second.** A photo is saved before its database row,
so photos copied after the database always include every photo the database mentions.
(Linux: `cp -a server/media /backups/`.)

How often: once a day while data is coming in; and before every update.

### PostgreSQL

Use `pg_dump` (for example `pg_dump -Fc survey > survey-2026-11-01.dump`) plus the photos folder, in the same order.

### Trying a restore (do this once, before you need it)

1. Put a **copy** of the project somewhere else (or a clean folder), with the same `.env`.
2. Put the backed-up database where `DATABASE_URL` points, and the photos in `MEDIA_ROOT`.
3. Start the server there, log in, open a submission that has a photo, and run an export.
4. If the photo shows and the export works, the backup is good.

A backup you have never restored is a hope, not a backup.

## SQLite to PostgreSQL

SQLite is one file and is fine for one server and a few hundred workers. Move to PostgreSQL
when you want the database on a separate machine, several users at the console at once at
volume, or hosted backups.

What is true today:

- The server works through SQLAlchemy and the table definitions are written for both
  (including the "only one current version" rule). **It has never been run against PostgreSQL.**
  Treat the first run as a test.
- The PostgreSQL driver is **not** in `requirements.txt`. Install one, for example
  `.\.venv\Scripts\python.exe -m pip install "psycopg[binary]"`.
- Set `DATABASE_URL=postgresql+psycopg://user:password@host:5432/survey` in `.env`.
- Make the tables with `cd server; ..\.venv\Scripts\python.exe -m alembic upgrade head`.
- **There is no tool to copy existing rows from SQLite to PostgreSQL.** If you have no real
  data yet, simply start on PostgreSQL. If you do, you need a copy step
  (for example the `pgloader` program, or a small script) and a rehearsal on a copy first.
  Do not switch a live system without one.
- The audit log is append-only by **discipline and a test**, not by a database rule (SQLite
  cannot express one). On PostgreSQL you can add it: give the application's database user
  `INSERT` and `SELECT` on `audit_log` and **no** `UPDATE` or `DELETE`.

## Keys: rotating `MEDIA_KEY`

Do this if the key may have leaked, or as a routine. **Changing the key in `.env` alone
breaks every existing photo**: they are encrypted with the old one. The server will
then skip them in exports (listed in `export_errors.txt`) and show nothing in the console.
The photos are not lost if you still hold the old key, but they stay unreadable until
re-encrypted.

1. Stop the server.
2. **Back up the photos folder and the database.**
3. Make a new key (`README.md` section 1).
4. Put the **old** key in a temporary variable, and the **new** key in `.env` as `MEDIA_KEY`.
5. Save the script below as `rotate_media_key.py` in the project folder and run it.
6. Start the server. Open a submission with a photo to check. Run an export.
7. Delete the script's temporary variable. Keep the old key until you are sure.

```powershell
$env:OLD_MEDIA_KEY = "the old key"
.\.venv\Scripts\python.exe rotate_media_key.py
Remove-Item Env:OLD_MEDIA_KEY
```

```python
# Re-encrypts every stored photo from OLD_MEDIA_KEY to the MEDIA_KEY now in .env.
# Stop the server first. Back up the media folder first.
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "server"))

from cryptography.exceptions import InvalidTag  # noqa: E402
from cryptography.hazmat.primitives import hashes  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402
from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.core.crypto import _INFO  # noqa: E402
from app.db.models import MediaFile  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402


def cipher(secret: str) -> AESGCM:
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=_INFO).derive(secret.encode("utf-8"))
    return AESGCM(key)


old_secret = os.environ.get("OLD_MEDIA_KEY", "")
if len(old_secret) < 32:
    sys.exit("Set OLD_MEDIA_KEY to the key you are replacing before running this.")
settings = get_settings()
old, new = cipher(old_secret), cipher(settings.media_key.get_secret_value())
root = Path(settings.media_root)

with SessionLocal() as db:
    paths = sorted({root / p for p in db.scalars(select(MediaFile.storage_path))})

staged, bad = [], []
for path in paths:  # phase 1: write every re-encrypted copy beside the original; change nothing yet
    try:
        blob = path.read_bytes()
        plain = old.decrypt(blob[:12], blob[12:], None)
    except (OSError, InvalidTag):
        bad.append(path)
        continue
    nonce = os.urandom(12)
    tmp = path.with_name(path.name + ".rot")
    tmp.write_bytes(nonce + new.encrypt(nonce, plain, None))
    staged.append((path, tmp))

if bad:
    for _, tmp in staged:
        tmp.unlink(missing_ok=True)
    print("STOPPED. Nothing was changed. These files could not be read with OLD_MEDIA_KEY:")
    for p in bad:
        print("  ", p)
    sys.exit(1)

for path, tmp in staged:  # phase 2: swap them in
    os.replace(tmp, path)
print(f"Done: {len(staged)} files re-encrypted. Start the server.")
```

It was tested on a scratch database with one photo: after running it, the photo decrypted with the
new key; running it a second time stopped without changing anything. It works in two steps: it first
makes a re-encrypted copy of every file and swaps them in only if **all** could be read, so a bad
file stops it before anything has changed. If it stops, nothing was changed; fix the cause (usually
a wrong old key, or a missing file) and run again. It does not touch `JWT_SECRET`, which you can
change at any time (everyone then logs in again).

## When an export fails

The console shows Google's own message. Find yours below.

| What you see | What it means | What to do |
|---|---|---|
| `DRIVE_FOLDER_ID is not set` (HTTP 503) | The setting is blank. | Fill `DRIVE_FOLDER_ID` in `.env`, restart. |
| `GOOGLE_SERVICE_ACCOUNT_FILE is not set` | Same, for the key file. | Fill it in, restart. |
| `The service-account key file was not found: ...` or `could not be used` | Wrong path, or not a Google key file. | Check the path in `.env`. The path is taken from the project folder if it is not complete. |
| `storageQuotaExceeded`, or "Service Accounts do not have storage quota" | The folder is in a normal **My Drive**. A service account has no storage. | Move the folder into a **Shared Drive** and make the service account a **Content manager** of it (`README.md`, Google setup). |
| HTTP 404 "File not found" for the folder | The folder id is wrong, or the service account cannot see the folder. | Check `DRIVE_FOLDER_ID`; make sure the service account is a member of the Shared Drive. |
| HTTP 403 "insufficient permissions" | The service account is only a Viewer, or the API is not switched on. | Make it **Content manager**. Check Drive API and Sheets API are enabled in Google Cloud. |
| Sheet error (usually HTTP 400, "Unable to parse range") | The Sheet has no tab named exactly like the form id. | Add the tab, same spelling and capitals; share the Sheet with the service account as Editor. |
| `... failed after 4 attempts` or "connection problem" | Google or the network was unreachable. | Wait and try again. |
| Status stays **running** for many minutes | The server was restarted while the export ran. **There is no automatic clean-up of such jobs yet.** The job row will stay "running". | Press Download CSV again to start a new job. The old stuck row is harmless. |
| Download works for the export but fails with HTTP 502 | The file was saved, but the server could not fetch it back from Drive. | Try again; or open the file in the Drive folder directly. |
| `This form has no uploaded version, so there is nothing to export` | The form has no versions. | Upload and publish the form. |

Notes:

- A failed export keeps its error text; nothing is lost. The submissions themselves are not
  affected by an export failure. **Your data is safe in the server's database.**
- A damaged photo or a bad GPS value does **not** fail an export. It is skipped and listed in
  `export_errors.txt` in the Drive folder. Open that file when the count of photos looks short.
- Because the Drive export has never been run with real credentials, the first live failure may
  say something not in this table. Copy the exact message, and the time, before changing anything.
- Each export saves a **new set of files**, with the time in the name. Old ones are not
  overwritten or removed. Tidy the Drive folder by hand now and then.

## Settings that matter at the proxy and the server

### Upload size limit, at the proxy

The application caps each photo (`MAX_MEDIA_BYTES`, 5 MiB) and a form upload (5 MB), but the
web framework (Starlette) has already **received and spooled the whole request** by the time that
cap is checked. Someone sending a 5 GB file would fill the server's disk and memory before the
application could say no. Refuse it earlier, **at the reverse proxy**:

- Caddy: `request_body { max_size 110MB }` (the Caddy file in `README.md` has it).
- nginx: `client_max_body_size 110m;`

110 MB is the largest legitimate submission: 20 photos of 5 MiB, plus the answers. If your forms
never carry more than a few photos you can set it lower, for example 30 MB, but then check
`MAX_MEDIA_BYTES` times your busiest form's photo count.

### Behind a proxy: `TRUST_PROXY_HEADERS` and `TRUSTED_PROXY_HOPS`

Login limits count by address. Behind Caddy or nginx, every phone appears to come from the
proxy's own address unless the server is told to read the real one from the `X-Forwarded-For`
header. If you do not set this, **all workers share one limit, and sixty failed logins in 15
minutes lock out a whole district.** In `.env`:

```
TRUST_PROXY_HEADERS=true
TRUSTED_PROXY_HOPS=1
```

`1` is for one proxy (one Caddy or one nginx). Add a hop for each further proxy in front (for
example a CDN). Do **not** set `true` when phones reach the server directly, with no proxy:
the header can then be forged and the limit avoided. The server writes a warning to its log if
it sees forwarded headers while the setting is `false`.

### One worker process

The login limiter keeps its counts **in the memory of one process**. If you start the server with
several workers (`--workers 4`), each keeps its own counts, so the real limit is four times
bigger and a worker restart forgets everything. Run **one** worker (the default `uvicorn` command in
`README.md`). One process is plenty for this load. If you must use several, expect a weaker lock-out
or ask for a shared limiter (a database or Redis) to be built.

The same applies to export jobs: they run inside the server process and end if the server stops.

### `requirements.txt` mixes runtime and test tools

`server/requirements.txt` is a plain `pip freeze`, so it lists the test tools
(`pytest`, `pip_audit`, `pip-requirements-parser` and others) together with what the server
needs. It does no harm, but a production server carries extra software it does not use. Before a
careful production deployment, split it into a short runtime list and a development list (and
keep the exact versions). Until then, installing it as is works. The test tools do not run
unless started.

### Phone storage: the rejected store is never emptied

When the server refuses a submission, the phone keeps the answers and photos in a separate
**rejected** store. The home screen lists them ("The server did not accept these forms") with a Retry
button, but **nothing ever removes them**. Over months, on a cheap phone, the store grows. What to do: find out why
the server refused (the reason is kept with each item), fix the cause (often a form not assigned, or a
form version the server does not know), press Retry, and watch the list shrink. If a phone is short of space and items
that will never be accepted are still there, clearing the app's data frees the space **but also deletes
anything unsent**, so first check that the queue is empty and nothing in the rejected list still matters.
A tidy-up button for this has not been built.

## Keeping it running

- **Health:** `https://your-address/health` should say `{"status":"ok"}`. Point any uptime monitor at it.
- **Logs:** the server prints to its console or to `journalctl -u survey` under systemd. Export failures and
  proxy warnings appear there.
- **Updating:** stop the server, **take a backup**, update the files, `pip install -r server\requirements.txt`,
  `cd server; ..\.venv\Scripts\python.exe -m alembic upgrade head`, start the server. If `webapp/` changed, also change
  `VERSION` in `webapp/sw.js` (for example `v1` to `v2`) so phones fetch the new app files
  instead of the old cached ones. Phones update the next time the app is opened with a network.
- **A database made before Projects existed must be rebuilt.** The project tables were added
  by editing the first migration, since nothing had been deployed. A test database from before that
  point cannot be upgraded; delete it and run `alembic upgrade head`. A real deployment started
  after Projects needs nothing.
- **A lost or stolen phone:** deactivate the user in the console (Users). That ends the login. Anything
  already queued on that phone stays on it.
- **A forgotten password:** an admin sets a new one (Users page, or `PATCH /api/users/{id}` with `password`).
  If **every admin** has lost their password, make a new admin with `make_admin.py` (`README.md`, section 2).
- **A locked-out username:** five failed logins lock that username for 15 minutes. It clears
  by itself; there is no unlock button. Someone who knows a username can use this to annoy that person.
- Old submissions are never deleted by the platform. Disk usage grows with photos; watch free space.

## Not covered yet

Security review by an independent person; a PostgreSQL trial; a real ODK Collect trial; a real
Google trial; a tool to empty the phone's rejected store; automatic tidy-up of stuck export jobs;
end-to-end encryption (`ARCHITECTURE.md`, section 8).
