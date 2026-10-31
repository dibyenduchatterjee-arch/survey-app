# Evidence Action - survey data download page (Google Sheet add-on page)

A web page that opens from your survey Google Sheet. You pick the form, the dates, the district
and block, see how many rows match, and download a CSV that opens correctly in Excel, Hindi
included. No server and no installs: it is a few lines of script pasted into the Sheet.

Files: `Code.gs` (the logic), `Page.html` (the page), `appsscript.json` (optional settings).

## English - set it up (about 10 minutes, once)

You need: the Google Sheet the phone app writes to, opened with the Google account that owns it.

1. **Open the Sheet.** You should see one tab at the bottom for each form.
2. **Extensions -> Apps Script.** A new browser tab opens with a code editor. It has one file,
   `Code.gs`, containing a little starter code (`function myFunction() {}`).
3. **Paste Code.gs.** Click `Code.gs`, select everything (Ctrl+A), delete it, and paste the whole
   content of `appsscript/Code.gs` from this project. Press Ctrl+S.
4. **Add Page.html.** Click the **+** next to *Files* -> **HTML**. Type the name `Page` (the editor
   adds `.html`). Select everything in the new file, delete it, paste the content of
   `appsscript/Page.html`, press Ctrl+S. The names must be exactly `Code.gs` and `Page.html`.
5. **Optional - Indian time zone.** Project Settings (gear icon) -> tick *Show "appsscript.json"
   manifest file in editor*. Open `appsscript.json` and replace its content with ours. (The page
   already counts dates in Indian time without this; it is only a safety net.)
6. **Also set the Sheet's time zone** (back in the Sheet: File -> Settings -> Time zone ->
   *(GMT+05:30) India Standard Time*). This matters if the received time is stored as a Sheets date.
7. **Deploy.** Top right: **Deploy -> New deployment**. Click the gear next to *Select type* ->
   **Web app**.
   - Description: `Survey download`
   - **Execute as: Me** (your account)
   - **Who has access: Only myself** to begin with. If a colleague needs the page, choose *Anyone
     within Evidence Action* (only if your Google Workspace has that option) or add them to the
     Sheet and deploy again - remember **everyone who can open the page can download all data in
     this Sheet**, as the page runs as you.
   - Click **Deploy**.
8. **Authorise.** Google shows *Authorization required* -> **Authorize access** -> pick your
   account. You may see *Google hasn't verified this app*: this is your own script, so click
   **Advanced** -> **Go to (project name) (unsafe)** -> **Allow**. This happens once.
9. **Copy the Web app URL** (it ends in `/exec`) and open it. Bookmark it - this is the page you
   will use every week.

**What you should see:** a page headed *Evidence Action - Survey data download* with three boxes:
1 choose the form, 2 dates and places, 3 count and the Download button. Choose a form: the number
of rows appears, and dropdowns for district, block and any other category columns it finds.

**Every time you change the code later:** Deploy -> **Manage deployments** -> pencil icon ->
Version: **New version** -> Deploy. The URL stays the same. (Editing alone does not change the live page.)

### Using it every week

1. Choose the form. 2. Pick *Date from / Date to* (leave blank for everything), then district,
then block - the block list shows only that district's blocks. 3. Read the count and the summary
line, then click **Download CSV**. Double-click the file; Hindi opens correctly in Excel.

If nothing matches you are told so plainly; the download then contains only the column names.

### If something goes wrong

| You see | Do this |
|---|---|
| *Authorization required* again | Repeat step 8. It asks again after you change the code. |
| Blank page or *Script function not found: doGet* | `Code.gs` was not saved, or was pasted wrongly. Re-paste step 3. |
| *Exception: ... Page* / page not found | The HTML file must be named exactly `Page`. |
| Count looks too small | Check the *Date taken from column* (shown if more than one) and the time zone in step 6. Rows whose date cannot be read are listed in a yellow warning. |
| Hindi shows as ???? in Excel | Open the CSV by double-clicking, not via *Data -> From text*. The file does carry the UTF-8 marker Excel needs. |
| Download does not start | Allow downloads for the page in the browser's address bar, then click again. |

## हिंदी - सेटअप (एक बार, लगभग 10 मिनट)

ज़रूरत: वह Google Sheet जिसमें फ़ोन ऐप डेटा लिखता है, उसी Google अकाउंट से खुला हुआ जो उसका मालिक है।

1. **Sheet खोलिए।** नीचे हर फ़ॉर्म का एक टैब दिखना चाहिए।
2. **Extensions -> Apps Script** दबाइए। नए टैब में कोड का एडिटर खुलेगा। उसमें `Code.gs` नाम की एक फ़ाइल होगी जिसमें थोड़ा शुरुआती कोड (`function myFunction() {}`) है।
3. **Code.gs पेस्ट कीजिए।** `Code.gs` पर क्लिक कीजिए, Ctrl+A से सब चुनिए, मिटाइए, और इस प्रोजेक्ट की `appsscript/Code.gs` का पूरा लिखा हुआ पेस्ट कीजिए। Ctrl+S दबाइए।
4. **Page.html जोड़िए।** *Files* के आगे **+** -> **HTML**। नाम लिखिए `Page` (एडिटर खुद `.html` जोड़ देगा)। नई फ़ाइल का सब कुछ मिटाकर `appsscript/Page.html` का पूरा लिखा हुआ पेस्ट कीजिए, Ctrl+S दबाइए। नाम ठीक `Code.gs` और `Page.html` ही होने चाहिए।
5. **वैकल्पिक - भारतीय समय।** Project Settings (गियर) -> *Show "appsscript.json" manifest file in editor* पर टिक कीजिए। `appsscript.json` खोलकर उसका लिखा हुआ हमारी फ़ाइल से बदल दीजिए। (इसके बिना भी पेज तारीखें भारतीय समय में ही गिनता है।)
6. **Sheet का टाइम ज़ोन भी तय कीजिए** (Sheet में File -> Settings -> Time zone -> *(GMT+05:30) India Standard Time*)।
7. **Deploy कीजिए।** ऊपर दाईं ओर **Deploy -> New deployment**। *Select type* के पास गियर -> **Web app**।
   - Description: `Survey download`
   - **Execute as: Me** (आपका अकाउंट)
   - **Who has access: Only myself** से शुरू कीजिए। किसी साथी को चाहिए तो *Anyone within Evidence Action* चुनिए (अगर आपके Workspace में यह विकल्प है), या उन्हें Sheet में जोड़कर दोबारा Deploy कीजिए। **याद रखिए: पेज आपके नाम से चलता है, इसलिए जो भी पेज खोल सकता है वह इस Sheet का सारा डेटा डाउनलोड कर सकता है।**
   - **Deploy** दबाइए।
8. **अनुमति दीजिए।** *Authorization required* दिखेगा -> **Authorize access** -> अपना अकाउंट चुनिए। *Google hasn't verified this app* दिख सकता है। यह आपकी अपनी स्क्रिप्ट है, इसलिए **Advanced** -> **Go to (प्रोजेक्ट का नाम) (unsafe)** -> **Allow**। यह सिर्फ़ एक बार होगा।
9. **Web app URL** (अंत में `/exec`) कॉपी करके खोलिए। इसे बुकमार्क कर लीजिए, हर हफ़्ते यही पेज चलेगा।

**क्या दिखना चाहिए:** *Evidence Action - सर्वे डेटा डाउनलोड* शीर्षक वाला पेज, तीन हिस्सों में: 1 फ़ॉर्म चुनें, 2 तारीख और जगह, 3 गिनती और डाउनलोड बटन। फ़ॉर्म चुनते ही पंक्तियों की संख्या दिखेगी, और जिला, ब्लॉक तथा बाकी श्रेणी वाले कॉलम के ड्रॉपडाउन आएँगे।

**बाद में कोड बदलें तो:** Deploy -> **Manage deployments** -> पेंसिल -> Version: **New version** -> Deploy। URL वही रहेगा। (सिर्फ़ एडिट करने से चालू पेज नहीं बदलता।)

### हर हफ़्ते का इस्तेमाल

1. फ़ॉर्म चुनिए। 2. *कब से / कब तक* तारीख चुनिए (खाली छोड़ें तो सब), फिर जिला, फिर ब्लॉक। ब्लॉक की सूची में सिर्फ़ उसी जिले के ब्लॉक आते हैं। 3. गिनती और सारांश वाली पंक्ति पढ़कर **CSV डाउनलोड करें** दबाइए। फ़ाइल पर डबल-क्लिक कीजिए, एक्सेल में हिंदी सही खुलेगी।

कुछ न मिले तो पेज साफ़ बता देता है; तब डाउनलोड में सिर्फ़ कॉलम के नाम होते हैं।

## How it decides things (assumptions)

- Row 1 of each tab is the column names; column 1 is the submission uuid. Names are read from the sheet, never assumed.
- **Date column:** first a column whose name contains `received`, else `_finished_at`, else `_started_at`. If there is more than one candidate the page offers a choice. (The phone app today writes `_started_at` and `_finished_at`; use the received column once it exists.)
- Dates are Indian dates. Text such as `2026-10-31T22:30:00Z` is converted to IST (that is 1 Nov, 04:00). Text with no zone is read as IST. Real Sheets dates are exact moments and are converted to IST.
- **Dropdowns:** `district` and `block` (also `district_name`, `block_name`, Hindi जिला / प्रखंड) first, in that order; then any other column with at most 40 distinct values that repeat and are short text. Never the id, `_` metadata or date columns.
- Repeat tabs (first column `parent_uuid`, named `<form>_<repeat>`): the parent form's columns are added so district, block and date can be filtered there too.
- CSV: UTF-8 with BOM, CRLF line endings, values starting with `= + - @` get a leading `'`, numbers stay numbers, Sheets dates are written as `YYYY-MM-DD HH:MM:SS` in IST.

## Tests

```
node --test appsscript/tests/
```

Covers the pure logic only. `doGet`, reading the Sheet, the web page itself and deployment run only
inside Google and are **not** tested here.
