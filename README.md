# Evidence Action survey platform

A tool for collecting survey data in the field, in rural Bihar, on ordinary Android
phones, with or without a network. You write each form in Excel (an **XLSForm**, the same
format SurveyCTO uses), upload it once, and the enumerators fill it on their phones. When
they get a network, the answers come to the server. You download the data as a CSV.

- How it is built, and what is **not** protected yet: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Running it day to day, backups, when something breaks: [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- Where the work stands: [`RESUME.md`](RESUME.md)
- **हिंदी में शुरू कैसे करें**: scroll down to *हिंदी में — शुरू कैसे करें*

## Read this before you rely on it

Plainly, so nobody is surprised:

- **Form-level end-to-end encryption is not built.** If someone breaks into the server, they
  can read the submissions. This is the same position as a SurveyCTO form with encryption
  switched off. Photos are encrypted on the server's disk, but the key is on the same server.
  The full design for fixing this (Phase 2) is in `ARCHITECTURE.md`.
- **The ODK Collect connection (OpenRosa) has never been tested against the real ODK Collect
  app.** Use the browser app on phones until someone tries Collect.
- **The Google Drive export has never been run with real Google credentials.** It has been
  tested only against a stand-in. Expect to fix something on the first live run. And the CSV
  download page **needs** Google set up: see *Google setup* below.
- Not supported: `pulldata`-style lookups from external files; `repeat_count` is not enforced;
  photo questions inside a repeat group share one slot; if a login-refresh reply is lost the worker
  must log in again (nothing queued is lost).
- Offline working **is verified in real Chrome** (the app installs, caches itself and opens with
  no network). It cannot be checked in the embedded test browser used while building; the one
  test that fails there (`test_the_app_shell_loads_with_the_network_disabled`) is a limit of that
  browser. Try it on a real Android phone before a rollout.

## What you need

- A computer or server with **Python 3.14** and **Node.js** (Node is only for the JavaScript tests).
- The project folder, `survey-platform`. These commands are for **Windows PowerShell**, run
  inside that folder. Folder names with spaces need quotes.
- For the live service: a web address (domain name) pointing at the server.

## 1. Set up

```powershell
py -3.14 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r server\requirements.txt
```

(`requirements.txt` mixes what the server needs with test tools. That is harmless; it is
noted in `docs/OPERATIONS.md`.)

Make your settings file:

```powershell
Copy-Item .env.example .env
```

Open `.env` in Notepad. Two lines **must** be filled in or the server refuses to start:

```
JWT_SECRET=
MEDIA_KEY=
```

Make a value for each by running this twice and pasting each answer after the `=`:

```powershell
.\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(48))"
```

Rules: each at least 32 characters, different from each other, and **kept secret**. Back
up `MEDIA_KEY` somewhere safe: if it is lost, every stored photo is unreadable forever.
`.env` is never committed to git.

Leave everything else blank for now. Blank means "use the default". The settings are listed
at the end of this file.

Make the database (once, and again after an update that changes the database):

```powershell
cd server
..\.venv\Scripts\python.exe -m alembic upgrade head
cd ..
```

If you get a message about a missing setting, read
the last line of the message; it names the setting.

## 2. Create the first admin

There is no sign-up page: the first admin is made once, from the computer, with a command.
Run it after `alembic upgrade head`, from the project folder (or from any folder; it finds
the database and `.env` by itself):

```powershell
.\.venv\Scripts\python.exe tools\create_admin.py create-admin --username YOURNAME --full-name "Your Name"
```

The same command from the `server` folder: `..\.venv\Scripts\python.exe -m app.cli create-admin --username YOURNAME`.

It asks for the password twice, with typing hidden. The password is never given on the command
line (it would stay in your shell history), and it must pass the same rules as the console:
at least 10 characters, nothing obvious. If the username already exists it says so and
changes nothing. `--full-name` is optional and defaults to the username. After that, sign in
to the console and make the other users there.

## 3. Start the server

```powershell
cd server
..\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000
```

Check `http://localhost:8000/health`: it should say `{"status":"ok"}`.

The server serves the API **and the browser app itself**: the enumerator app at
`http://localhost:8000/` and the console at `http://localhost:8000/console/`. The app calls
`/api/...` with no domain, so the app and the API must share one address, and this is how
they do. There is one thing to deploy and one address to put behind TLS (section 6). The
app is **not** to be hosted separately (for example on Cloudflare Pages): its `/api/` calls
would go to the wrong place.

Only the `webapp/` folder is served. Nothing else in the repository (`.env`, `server/`, the
database, `.git`) is reachable, and `/api/` and `/openrosa/` always take precedence over any
file. `tools/serve.js` remains as a test file server for the browser tests only.

## 4. Run the tests

Python (about 980 tests):

```powershell
.\.venv\Scripts\python.exe -m pytest server\tests -W error
```

JavaScript (573 tests):

```powershell
& "C:\Users\dibyendu.chatterjee_\AppData\Local\Programs\nodejs\node.exe" --test webapp\tests\
```

Browser tests (the real form screens, storage on the phone, the offline shell):

```powershell
node tools\serve.js 8008
```

Open `http://127.0.0.1:8008/webapp/tests/browser.html` **in Google Chrome**, wait until the
page says it has finished, and read the summary at the top. Expect **54 passed, 0 failed** in Chrome. In
the browser pane used during development one test fails, the offline-shell test. That is that
browser, not the app.

If the Python tests fail after you change a validation rule, the message will tell you to
regenerate the parity fixture. See `ARCHITECTURE.md`, section 5.

## 5. Day to day: projects, forms, people

The console is the web page at `/console/` on your address (for example
`https://survey.example.org/console/`). Sign in with the admin account.

- **Users**: create enumerators and supervisors, switch people off.
- **Forms**: press "Upload and check" to upload an XLSForm. You see every question first, then press "Publish version ...".  If the form
  uses something the platform cannot do, it is **refused with the name of the question**.
- **Projects** (the home page): one line per form, how many submissions, and a download button.
- **Exports**: **Download CSV** for a form.
- **Submissions**, **Audit**.

### Projects and giving people access

A **project** is a group of forms. Add a person to a project once, and every form in it
(including forms added later) reaches their phone.

> **The console cannot create projects or add people to them yet.** The console's Users page
> assigns people to **one form at a time**. Projects are managed with a few commands, below.
> A form uploaded in the console starts in "Default project".

Log in and keep the token for the following commands (PowerShell; change the address and
the password):

```powershell
$base = "https://survey.example.org"
$login = Invoke-RestMethod -Method Post -Uri "$base/api/auth/login" -ContentType "application/json" `
  -Body (@{username="YOUR_ADMIN"; password="YOUR_PASSWORD"} | ConvertTo-Json)
$h = @{ Authorization = "Bearer $($login.access_token)" }
```

(The token lasts 15 minutes; run these lines again when it stops working.)

Make a project, and put a form in it:

```powershell
$p = Invoke-RestMethod -Method Post -Uri "$base/api/projects" -Headers $h -ContentType "application/json" `
  -Body (@{name="IFA Bihar"} | ConvertTo-Json)
Invoke-RestMethod -Method Put -Uri "$base/api/projects/$($p.id)/forms/ifa_visit" -Headers $h
```

(`ifa_visit` is the form's id, the name in the `form_id` setting of the XLSForm. It
is shown on the Forms page.)

Add a person to the project (find the user's number with `Invoke-RestMethod -Uri "$base/api/users" -Headers $h`):

```powershell
Invoke-RestMethod -Method Post -Uri "$base/api/projects/$($p.id)/members" -Headers $h -ContentType "application/json" `
  -Body (@{user_id=5} | ConvertTo-Json)
```

List projects: `Invoke-RestMethod -Uri "$base/api/projects" -Headers $h`. Remove a person:
`Invoke-RestMethod -Method Delete -Uri "$base/api/projects/PROJECT_ID/members/USER_ID" -Headers $h`.

These commands were run against a scratch server while writing this guide
(create project, create user, add member). The Put (move a form into a project) is covered by
the automated tests.

**Who sees what:** an admin sees everything. A supervisor is intended to see only the
projects they belong to; that change was being applied when this was written (see
`ARCHITECTURE.md`, section 2), so until it is confirmed, assume supervisors see all forms.
An enumerator sees only the forms they have been given.

### Getting the CSV

1. In the console, open **Exports** (or the download button on the home page) and press
   **Download CSV** for the form.
2. The server builds the files, saves them to the Drive folder, and the CSV downloads to
   your computer. Hindi text opens correctly in Excel.
3. In the Drive folder you will also find a CSV for each repeat group (for example one row
   per child), a zip of the photos, and `export_errors.txt` if anything was skipped. Each name
   carries the form and the time.

**Requires the Google setup below.** Without it the button says "DRIVE_FOLDER_ID is not set".

## 6. Putting it on the internet, with TLS

TLS is the padlock (https). Without it, passwords and health data cross the network readable.
Do not run the real service without it. Phones also will not install the app or run the offline
part of it without https.

You need: a server (any ordinary Linux machine will do), a domain name whose address points at
it, and ports 80 and 443 open. This is a standard setup. **It has not been run for this
project yet** (no hosting has been chosen), so treat the file below as a starting point
and test it.

1. Put the project on the server, make the `.venv`, `.env` and database as in sections 1 and 2.
2. Run the API (one worker; see `docs/OPERATIONS.md`) so it starts at boot, for
   example with systemd. In `/etc/systemd/system/survey.service`:

   ```
   [Unit]
   Description=Survey platform API
   After=network.target

   [Service]
   WorkingDirectory=/srv/survey-platform/server
   ExecStart=/srv/survey-platform/.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
   Restart=always
   User=survey

   [Install]
   WantedBy=multi-user.target
   ```

3. Install **Caddy**, which gets and renews the TLS certificate by itself. Its file
   (`/etc/caddy/Caddyfile`):

   ```
   survey.example.org {
       encode gzip

       # A submission can hold up to 20 photos of 5 MB. Refuse anything bigger here, before it
       # reaches the application (see docs/OPERATIONS.md).
       handle /api/* {
           request_body {
               max_size 110MB
           }
           reverse_proxy 127.0.0.1:8000
       }
       handle /openrosa/* {
           request_body {
               max_size 110MB
           }
           reverse_proxy 127.0.0.1:8000
       }
       handle /health {
           reverse_proxy 127.0.0.1:8000
       }

       # The app and the console: the files in webapp/
       handle {
           root * /srv/survey-platform/webapp
           header /sw.js Cache-Control "no-cache"
           file_server
       }
   }
   ```

4. In `.env` add these two lines, so the server knows the proxy is in front of it
   (**without them every phone looks like one visitor and sixty failed logins lock out a whole
   district**):

   ```
   TRUST_PROXY_HEADERS=true
   TRUSTED_PROXY_HOPS=1
   ```

5. Restart the API. Open `https://survey.example.org/health`, then `/console/`.

Do **not** serve the whole project folder: `.env`, the database and the Google key sit
there. Serve only `webapp/`.

On an Android phone, open the address in Chrome and choose **Install app** / **Add to Home screen**.

## Google setup (Drive, and optionally Sheets)

The CSVs go to a Google Drive folder, and the console's download goes through that folder.
This is the step that catches everyone.

### The trap: a service account has no storage of its own

The server logs in to Google as a **service account**, a robot account with its own
email address. A service account has **no Drive storage quota**. If the destination folder is in a
normal "My Drive", uploads fail with an error like:

```
storageQuotaExceeded: Service Accounts do not have storage quota.
```

**The folder must be in a Shared Drive**, and the service account must be a member of that Shared
Drive with the role **Content manager**. (A plain "share with Editor" on a My Drive folder does
**not** fix it.)

> **Your current folder is in My Drive. The first live export will fail until it is moved.**
> Shared Drives need Google Workspace (they are not available on a free personal Gmail account).

### Steps

1. Go to the Google Cloud Console, `console.cloud.google.com`, and make (or choose) a project.
2. **APIs and services, Library:** switch on **Google Drive API** and **Google Sheets API**.
3. **IAM and admin, Service accounts:** create a service account (any name, for example
   `survey-export`). Open it, then **Keys, Add key, Create new key, JSON**. A `.json` file
   downloads. This file is a password. Keep it **outside** the project folder, for example
   `C:\secrets\survey-google.json` or `/etc/survey/google.json`. Never email it, never commit
   it. (If your organisation blocks key creation, ask whoever administers Google Cloud.)
4. Note the service account's email, which looks like `survey-export@yourproject.iam.gserviceaccount.com`.
5. In Google Drive, make a **Shared Drive** (left menu, Shared drives, New). **Add members:** add the
   service account email with the role **Content manager**. Add yourself and the data team too.
6. Move the export folder into the Shared Drive, or make a new folder inside it.
   Open the folder; the address looks like `https://drive.google.com/drive/folders/1AbC...`. The
   part after `/folders/` is the **folder id**.
7. Optional, for a live Google Sheet: make a Sheet, share it with the service account email as
   **Editor**, and add a tab whose name is **exactly the form id** (for example `ifa_visit`). The
   sheet id is the part of its address between `/d/` and `/edit`.
8. Fill in `.env`:

   ```
   GOOGLE_SERVICE_ACCOUNT_FILE=C:\secrets\survey-google.json
   DRIVE_FOLDER_ID=1AbC...
   GOOGLE_SHEET_ID=
   ```

   `GOOGLE_SHEET_ID` is optional; leave it blank to skip the Sheet.
9. Restart the server and press **Download CSV** for a form that has at least one submission.

Keep the Shared Drive limited to named people. The exports in it are **not encrypted**.

If the export fails, the page shows Google's message. See *When an export fails* in
`docs/OPERATIONS.md`.

## Settings (`.env`)

| Setting | Meaning | Default |
|---|---|---|
| `JWT_SECRET` | Signs logins. **Required**, 32+ characters. | none |
| `MEDIA_KEY` | Encrypts photos on disk. **Required**, 32+ characters. | none |
| `DATABASE_URL` | Where the data lives. A relative SQLite path is taken from the project folder. | `sqlite:///./server/survey.db` |
| `MEDIA_ROOT` | Folder for photos. | `server/media` |
| `MAX_MEDIA_BYTES` | Largest single photo or file. Phones shrink photos to fit. | 5 MiB |
| `CORS_ORIGINS` | Extra website addresses allowed to call the API. Blank is right when the app is on the same address. | blank |
| `TRUST_PROXY_HEADERS`, `TRUSTED_PROXY_HOPS` | Set to `true` and `1` behind Caddy or nginx. | `false`, `1` |
| `FORM_TIMEZONE` | What "today" means in form rules. | `Asia/Kolkata` |
| `DUPLICATE_KEYS` | Per form, which answers identify "the same visit", as JSON. | whole-form match |
| `GOOGLE_SERVICE_ACCOUNT_FILE`, `DRIVE_FOLDER_ID`, `GOOGLE_SHEET_ID` | Google export. | none |
| `REFRESH_TOKEN_DAYS`, `LOGIN_RATE_LIMIT_PER_USERNAME`, `LOGIN_RATE_LIMIT_PER_IP`, `LOGIN_RATE_LIMIT_WINDOW_SECONDS` | Login lifetime and lock-out limits. | 30, 5, 60, 900 |

---

## हिंदी में — शुरू कैसे करें

यह सर्वर और ऐप हमारी फ़ील्ड टीमों के लिए है। फ़ॉर्म एक्सेल (XLSForm) में बनता है, एक बार अपलोड होता है, और ASHA, AWW, शिक्षक या सर्वेयर अपने फ़ोन पर उसे भरते हैं। नेटवर्क न हो तो भी भर सकते हैं; नेटवर्क मिलते ही जवाब सर्वर पर पहुँच जाते हैं।

**पहले यह जान लीजिए**

- अभी **एंड-टू-एंड एन्क्रिप्शन नहीं बना है।** अगर कोई सर्वर में सेंध लगा ले, तो वह भरे हुए जवाब पढ़ सकता है। यह वैसा ही है जैसे SurveyCTO में एन्क्रिप्शन बंद हो।
- ODK Collect ऐप के साथ इसे **कभी असली फ़ोन पर आज़माया नहीं गया है।** अभी ब्राउज़र वाला ऐप ही इस्तेमाल करें।
- Google Drive में फ़ाइल भेजना **अभी तक असली Google खाते से चलाकर नहीं देखा गया है।**

### 1. इंस्टॉल करना

प्रोजेक्ट फ़ोल्डर में PowerShell खोलिए और ये चलाइए:

```powershell
py -3.14 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r server\requirements.txt
Copy-Item .env.example .env
```

`.env` को Notepad में खोलिए। `JWT_SECRET=` और `MEDIA_KEY=` के आगे दो अलग-अलग गुप्त मान भरना ज़रूरी है (कम से कम 32 अक्षर)। हर मान के लिए यह एक बार चलाकर जवाब चिपकाइए:

```powershell
.\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(48))"
```

`MEDIA_KEY` कहीं सुरक्षित जगह भी लिख लीजिए। खो गई तो सारी फ़ोटो हमेशा के लिए खुलना बंद हो जाएँगी।

फिर डेटाबेस बनाइए:

```powershell
cd server
..\.venv\Scripts\python.exe -m alembic upgrade head
cd ..
```

### 2. पहला एडमिन बनाना

प्रोजेक्ट फ़ोल्डर में यह कमांड चलाइए:

```powershell
.\.venv\Scripts\python.exe tools\create_admin.py create-admin --username आपका_यूज़रनेम --full-name "आपका नाम"
```

पासवर्ड दो बार पूछेगा (पासवर्ड कम से कम 10 अक्षर का; टाइप करते समय दिखेगा नहीं)।

### 3. सर्वर चलाना

```powershell
cd server
..\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000
```

असली इस्तेमाल के लिए सर्वर पर https (TLS) ज़रूर लगाइए। इसका तरीका ऊपर अंग्रेज़ी हिस्से में *Putting it on the internet, with TLS* में है।

### 4. प्रोजेक्ट बनाना

प्रोजेक्ट यानी फ़ॉर्मों का एक समूह। किसी व्यक्ति को प्रोजेक्ट में एक बार जोड़ दें तो उसके फ़ोन पर उस प्रोजेक्ट के सारे फ़ॉर्म आ जाते हैं, बाद में जुड़ने वाले भी।

**अभी कंसोल में प्रोजेक्ट बनाने का बटन नहीं है।** प्रोजेक्ट कुछ कमांड से बनता है। ऊपर अंग्रेज़ी हिस्से में *Projects and giving people access* देखिए: वहाँ `$p = Invoke-RestMethod ... /api/projects` वाली लाइनें हैं। कंसोल का **Users** पेज एक-एक फ़ॉर्म पर लोगों को जोड़ सकता है।

### 5. फ़ॉर्म अपलोड करना

कंसोल खोलिए (`https://आपका-पता/console/`), एडमिन से लॉगिन कीजिए, **Forms** पेज पर XLSForm की फ़ाइल चुनिए। **Upload and check** दबाइए। सारे सवाल दिखेंगे। ठीक लगें तो **Publish version** दबाइए। अगर फ़ॉर्म में कुछ ऐसा है जो यह प्लेटफ़ॉर्म नहीं कर सकता, तो वह उस सवाल का नाम बताकर मना कर देगा। इसे ठीक करके फिर अपलोड करें। अपलोड हुआ फ़ॉर्म पहले "Default project" में रहता है।

### 6. लोगों को जोड़ना

कंसोल के **Users** पेज पर नया यूज़र बनाइए (भूमिका: `enumerator` यानी भरने वाला, या `supervisor`)। फिर उसे प्रोजेक्ट में जोड़िए (ऊपर वाले कमांड से) या उसी पेज पर फ़ॉर्म से जोड़िए।

फ़ोन में: Chrome में अपना पता खोलिए, **Install app** / **होम स्क्रीन में जोड़ें** चुनिए। जब नेटवर्क हो, ऐप की **फ़ॉर्म अपडेट करें** बटन दबाने से नए फ़ॉर्म आ जाते हैं।

### 7. CSV कहाँ मिलती है

कंसोल में **Exports** पर फ़ॉर्म के आगे **Download CSV** दबाइए। फ़ाइल आपके कंप्यूटर में उतरेगी (एक्सेल में हिंदी ठीक दिखेगी)। इसी समय Drive के फ़ोल्डर में भी रखी जाती है। वहाँ दोहराए जाने वाले हिस्सों (जैसे हर बच्चे की एक पंक्ति) की अलग CSV और फ़ोटो की एक zip भी होती है।

**ज़रूरी:** Drive का फ़ोल्डर **Shared Drive** में होना चाहिए, और उस Shared Drive में सर्विस अकाउंट **Content manager** के रूप में जुड़ा होना चाहिए। अपने निजी *My Drive* के फ़ोल्डर में यह `storageQuotaExceeded` की गलती देगा, क्योंकि सर्विस अकाउंट के पास अपनी स्टोरेज नहीं होती। पूरे कदम ऊपर *Google setup* में हैं। `GOOGLE_SERVICE_ACCOUNT_FILE` और `DRIVE_FOLDER_ID` भरे बिना डाउनलोड नहीं चलेगा।

कुछ गड़बड़ हो तो `docs/OPERATIONS.md` देखिए।
