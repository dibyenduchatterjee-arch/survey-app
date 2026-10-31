# Setup — what you do, step by step

**सोमवार के लिए सेटअप — क्या-क्या करना है**

Everything else is done. These are the steps only you can do, because they happen inside
your own Google account. Allow about 20 minutes.

---

## Step 1 — Create the data spreadsheet

1. In your Drive folder **Survey CTO Type APK**, create a new **Google Sheet**.
   Name it something like `Survey Platform — Control`.
2. Open it. This one sheet holds your project list, your team's access codes, and
   (later) the collected data.

**हिंदी:** अपने ड्राइव फ़ोल्डर में एक नई Google Sheet बनाइए और उसे खोलिए।

---

## Step 2 — Paste the Apps Script

1. In that Sheet: **Extensions → Apps Script**. A code editor opens.
2. Delete whatever is in `Code.gs`.
3. From this project's `appsscript/` folder, copy each file's contents into a file of the
   same name in the editor (use the **+** next to *Files* to add one):
   - `Code.gs` — the download page
   - `Backend.gs` — the API the phone app talks to
   - `Page.html` — the download page's screen
4. Click **Save** (the disk icon).

**हिंदी:** Extensions → Apps Script खोलिए, और `appsscript/` फ़ोल्डर की फ़ाइलें वैसी ही
कॉपी कर दीजिए।

---

## Step 3 — Create the two tabs

1. In the Apps Script editor, choose the function **`setupProjects`** from the dropdown at
   the top and click **Run**.
2. The first time, Google asks for permission. Click **Review permissions** → choose your
   account → it may warn *"Google hasn't verified this app"* → click **Advanced** →
   **Go to (your project name)** → **Allow**.
   This warning is normal for a script you wrote yourself. You are granting it access to
   your own Sheet and Drive, nothing else.
3. Go back to the Sheet. Two new tabs appear: **Projects** and **People**.

**हिंदी:** `setupProjects` चलाइए। परमिशन माँगेगा — Advanced → Go to → Allow दबाइए।
यह चेतावनी सामान्य है, क्योंकि स्क्रिप्ट आपकी अपनी है।

---

## Step 4 — Fill in your projects

In the **Projects** tab, one row per project:

| Project name | Drive folder id | Data spreadsheet id |
|---|---|---|
| Anemia Mukt Bihar | *(see below)* | *(see below)* |

- **Drive folder id** — create a folder for that project inside your main folder, open it,
  and copy the long code from the address bar after `/folders/`.
- **Data spreadsheet id** — you can use this same Sheet. Its id is the long code in its own
  address, between `/d/` and `/edit`.

**हिंदी:** हर प्रोजेक्ट के लिए एक पंक्ति। फ़ोल्डर का id पते में `/folders/` के बाद वाला
लंबा कोड है।

---

## Step 5 — Add your team and their codes

In the **People** tab, one row per person:

| Name | Code | Project | Active |
|---|---|---|---|
| Sunita Devi | *(generated)* | Anemia Mukt Bihar | yes |

Use the Sheet's **Survey Platform** menu → **Set a person's code** to generate one. Do not
invent short codes yourself — a generated code is much harder to guess.

Each person gets **their own code**. That is how you know who collected which row, and how
you remove one person without disturbing anyone else: set their **Active** to `no`, and they
lose access immediately.

**हिंदी:** हर व्यक्ति का अपना कोड। किसी को हटाना हो तो उसका **Active** `no` कर दीजिए —
बाक़ी सब पर कोई असर नहीं पड़ेगा।

---

## Step 6 — Publish the script

1. In the Apps Script editor: **Deploy → New deployment**.
2. Click the gear next to *Select type* → **Web app**.
3. **Execute as:** *Me*. **Who has access:** **Anyone**.
4. **Deploy** → copy the **Web app URL**. It ends in `/exec`.

**Send me that URL.** I put it into the app and publish, and your link starts working.

> *"Anyone" sounds alarming but is correct here.* The URL alone does nothing — without a
> valid person's code it returns nothing at all. It has to be "Anyone" because your field
> staff do not sign in with Google accounts.

**हिंदी:** Deploy → New deployment → Web app → Execute as: Me, Who has access: **Anyone** →
URL कॉपी करके मुझे भेज दीजिए।

---

## Step 7 — Publish a form

On this laptop, for each XLSForm:

```
.\.venv\Scripts\python.exe tools\publish_form.py --xlsx "path\to\your-form.xlsx" --project-folder <the project folder id>
```

It checks the form, and tells you exactly which question is wrong if something cannot be
used. Nothing is uploaded unless the whole form is good.

---

## Step 8 — Try it

1. Open your app link on a phone or in a browser.
2. Type one of the codes from the **People** tab.
3. The forms for that person's project appear. Fill one in.
4. Turn the network off, fill another, turn it back on — it sends by itself.
5. Open your Sheet: the rows are there, one tab per form.

---

## What to show on Monday

The point is not the screens. It is this: **Google Forms is not enough for these surveys,
and Kobo or SurveyCTO would put beneficiary names, GPS locations and photographs on somebody
else's server.** Here the data never leaves Evidence Action's own Drive.

Worth demonstrating in this order:

1. Enter a code → only that project's forms appear. Enter a different person's code → a
   different project. That is the access control, visible in one minute.
2. Fill a form **with the network switched off** — this is what field reality looks like.
3. Switch the network on → the row appears in your Sheet.
4. Open the download page → choose dates and a district → download the CSV.

---

## If something goes wrong

- **"This app has not been set up yet"** — the Apps Script URL has not reached the app yet.
  Send me the `/exec` URL.
- **A code is refused** — check the **People** tab: spelling, and **Active** set to `yes`.
- **"Old version" message** — the Apps Script needs redeploying: Deploy → *Manage
  deployments* → edit → **New version** → Deploy.
- **Publishing a form fails with a storage error** — the Drive folder must be in a **Shared
  drive**, not My Drive. A script cannot store files in a personal My Drive on your behalf.
