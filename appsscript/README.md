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


---

# Phone backend (Web App API) - Evidence Action

New file: `Backend.gs`. Paste it beside `Code.gs` (new file named `Backend`). It turns this Sheet into the server the phone app talks to. It runs **as you**, so field workers need **no Google account**.

**Each person has their own access code.** The code opens only the project that person is assigned to, and every row they collect is stamped with **their name**, taken from the code on the server (the phone cannot claim another name). To stop one person, switch off one row; nobody else is affected.

**Important:** the download page (`Page.html`) is now shown **only to you** (the owner). Anyone else, or anyone not signed in, sees "This page is not available". To let a colleague in, open Project Settings -> Script properties -> add `DOWNLOAD_EMAILS` = their email(s), comma separated.

## English - set it up (about 20 minutes, once)

1. **Paste.** In Extensions -> Apps Script click **+** -> **Script**, name it `Backend`, paste all of `appsscript/Backend.gs`, Ctrl+S. Also replace `Code.gs` with the new `appsscript/Code.gs` (one change in `doGet`), and `appsscript.json` with ours (first tick *Show "appsscript.json" manifest file* in Project Settings). **You should see:** three files - Code, Backend, Page.
2. **Run `setupProjects`.** In the function list choose `setupProjects`, click **Run**. Google asks you to authorise (see step 6). **You should see:** two new tabs, **Projects** and **People**, each with headings and one example row. After you reload the Sheet there is also a menu **Evidence Action survey**.
3. **Projects tab - one row per project:**

   | Project name | Drive folder id | Data spreadsheet id |
   |---|---|---|
   - *Drive folder id*: open the project's Drive folder; the id is the last part of the address (`.../folders/<this part>`). The `*.spec.json` form files and a `photos` folder live here.
   - *Each project needs its own Drive folder.* The phone tells projects apart by a code derived from the folder, not by the name, so two projects may share a name but never a folder (the Check menu reports it). Pointing a project at a different folder later makes phones treat it as a new project.
   - *Data spreadsheet id*: open the project's **own** data Google Sheet; the id is the long part between `/d/` and `/edit`. It must **not** be this control Sheet (the one holding Projects and People), and no two projects may share one spreadsheet. The script marks such a row unusable and the Check menu names it: a project pointed at the control Sheet would put beneficiary data beside the code hashes, and two projects on one spreadsheet would write into each other's tabs.
   - Project names must be **unique**.
4. **People tab - one row per person:**

   | Person name | Access code | Project | Active |
   |---|---|---|---|
   - *Person name*: how their rows will be labelled in the data (`_submitted_by`).
   - *Project*: the project name **exactly as on the Projects tab**.
   - *Active*: `yes` or `no`. `no` (or empty) stops that person **at once**, even on a phone already signed in.
   - *Access code*: **do not type it here.** Click the person's row, then menu **Evidence Action survey -> Set or change the code for the selected row**, and confirm. A strong 10-character code is made and shown **once**. Write it down and give it to that person. The cell then shows a long scrambled text starting `sha256$`; that is correct.
5. **Check.** Menu **Evidence Action survey -> Check the Projects and People tabs**. **You should see:** "No problems found" and how many people can open a project.
6. **Deploy.** **Deploy -> New deployment -> gear -> Web app.** Description `Survey API`. **Execute as: Me.** **Who has access: Anyone** (this lets workers without Google accounts in; they still need a valid code). **Deploy**. If asked: **Authorize access** -> your account -> *Google hasn't verified this app* -> **Advanced** -> **Go to ... (unsafe)** -> **Allow**. The script needs your Sheets and Drive because it works on your behalf.
   **If "Anyone" is not offered**, your organisation's administrator has blocked it and this design cannot work for people without Google accounts. Stop and tell the project team.
7. **Copy the Web app URL** (ends in `/exec`) for whoever sets up the phone app. In a browser it should show "This page is not available"; that is correct.
8. **Later code changes:** Deploy -> Manage deployments -> pencil -> Version **New version** -> Deploy. The URL stays the same.

**Codes: generated, not chosen.** A short, memorable code (`BIHAR2026`) is what makes someone willing to try guessing, and the codes are stored with a fast hash (Apps Script offers nothing slower). The menu is the only way to make one (10 characters, no look-alike letters); a code cannot be chosen by hand. **A code typed into a cell is cleared, with a note saying why** - and it should be treated as burnt, because Google Sheets **version history keeps what was typed**, readable by anyone with edit access. If that happened, generate a fresh code for that person from the menu.

**Revoke or change access:** one person - set Active to `no`, or give a new code. Everyone on a project - switch off those rows. Takes effect on the phone's next request. To end every session at once, delete the `TOKEN_SECRET` script property (Project Settings).

**If something goes wrong**

| You see | Do this |
|---|---|
| Phone says the code is not accepted | The same message appears for a wrong code, a switched-off person and an unknown person, on purpose. Check Active is `yes`, the Project name matches exactly, both ids are filled, and the code is the one you issued. Run *Check the Projects and People tabs*. |
| Code is refused though it is right | Two active people may share one code (refused deliberately), or a project name appears twice. Run the check. |
| Signing in feels slow after several wrong codes | Expected. Each wrong code makes the **next wrong code** wait a little longer (a few seconds at most). A right code is never delayed and never refused, however many wrong ones came before it, so one person mistyping cannot keep the team out. |
| Phone says "busy" or "server problem" | Nothing is lost; the phone keeps the record and tries again. If it lasts hours you may have hit Google's daily limit; try next day. |
| Authorization required again | Repeat the authorise step of 6. |
| A code cell went empty with a note on it | Someone typed a code by hand; the script cleared it. Use the menu to generate a code for that row. |

## हिंदी - फ़ोन बैकएंड (Web App API) - एक बार का सेटअप (लगभग 20 मिनट)

नई फ़ाइल: `Backend.gs`। इसे `Code.gs` के बराबर में पेस्ट कीजिए। यह इस Sheet को वह सर्वर बना देती है जिससे फ़ोन ऐप बात करता है। यह **आपके नाम से** चलती है, इसलिए फ़ील्ड वर्कर्स को **Google अकाउंट की ज़रूरत नहीं**।

**हर व्यक्ति का अपना एक्सेस कोड होता है।** कोड सिर्फ़ उसी प्रोजेक्ट को खोलता है जो उस व्यक्ति को दिया गया है, और उनकी भरी हर पंक्ति पर **उनका नाम** अपने-आप लगता है। नाम सर्वर कोड से तय करता है, फ़ोन किसी और का नाम नहीं लिख सकता। किसी एक को रोकना हो तो उसकी एक पंक्ति बंद कीजिए; बाकी किसी पर असर नहीं।

**ज़रूरी:** डाउनलोड पेज (`Page.html`) अब **सिर्फ़ आपको** दिखता है। बाकी सबको "This page is not available" दिखेगा। किसी साथी को देखने देना हो तो Project Settings -> Script properties में `DOWNLOAD_EMAILS` नाम से उनके ईमेल (कॉमा से अलग) जोड़िए।

1. **पेस्ट कीजिए।** Extensions -> Apps Script में **+** -> **Script**, नाम `Backend`, `appsscript/Backend.gs` का पूरा लिखा पेस्ट कीजिए, Ctrl+S। `Code.gs` नई वाली से और `appsscript.json` हमारी फ़ाइल से बदलिए (पहले Project Settings में *Show "appsscript.json" manifest file* टिक कीजिए)। **दिखना चाहिए:** तीन फ़ाइलें - Code, Backend, Page।
2. **`setupProjects` चलाइए।** फ़ंक्शन की सूची में `setupProjects` चुनिए, **Run** दबाइए। Google अनुमति माँगेगा (चरण 6)। **दिखना चाहिए:** दो नए टैब, **Projects** और **People**, हर एक में शीर्षक और एक उदाहरण पंक्ति। Sheet दोबारा खोलने पर **Evidence Action survey** मेन्यू भी दिखेगा।
3. **Projects टैब - हर प्रोजेक्ट की एक पंक्ति:** *Project name*; *Drive folder id* (प्रोजेक्ट के Drive फ़ोल्डर के पते का आख़िरी हिस्सा, `.../folders/<यह हिस्सा>`; फ़ॉर्म की `*.spec.json` फ़ाइलें और `photos` फ़ोल्डर यहीं रहते हैं); *Data spreadsheet id* (उस प्रोजेक्ट की **अपनी अलग** डेटा Sheet के पते में `/d/` और `/edit` के बीच का लंबा हिस्सा; **यही कंट्रोल Sheet नहीं चलेगी**, और दो प्रोजेक्ट एक ही Sheet साझा नहीं कर सकते — ऐसी पंक्ति को स्क्रिप्ट मना कर देती है और जाँच मेन्यू उसका नाम बता देता है)। प्रोजेक्ट के नाम **अलग-अलग** होने चाहिए।
4. **People टैब - हर व्यक्ति की एक पंक्ति:**
   - *Person name*: डेटा में उनकी पंक्तियों पर यही नाम लगेगा (`_submitted_by`)।
   - *Project*: प्रोजेक्ट का नाम, **ठीक वैसा जैसा Projects टैब में है**।
   - *Active*: `yes` या `no`। `no` (या खाली) करते ही वह व्यक्ति **तुरंत** रुक जाता है, पहले से साइन-इन फ़ोन पर भी।
   - *Access code*: **यहाँ टाइप मत कीजिए।** व्यक्ति की पंक्ति पर क्लिक कीजिए, फिर मेन्यू **Evidence Action survey -> Set or change the code for the selected row** चुनिए और पुष्टि कीजिए। 10 अक्षरों का मज़बूत कोड बनेगा और **एक ही बार** दिखेगा। उसे लिखकर उस व्यक्ति को दीजिए। सेल में `sha256$` से शुरू होने वाला लंबा गड़बड़ पाठ दिखेगा; यही सही है।
5. **जाँचिए।** मेन्यू **Evidence Action survey -> Check the Projects and People tabs**। **दिखना चाहिए:** "No problems found" और कितने लोग प्रोजेक्ट खोल सकते हैं।
6. **Deploy कीजिए।** **Deploy -> New deployment -> गियर -> Web app।** Description `Survey API`। **Execute as: Me।** **Who has access: Anyone** (इससे बिना Google अकाउंट वाले वर्कर आ पाते हैं; फिर भी सही कोड चाहिए)। **Deploy**। माँगे तो: **Authorize access** -> अपना अकाउंट -> *Google hasn't verified this app* -> **Advanced** -> **Go to ... (unsafe)** -> **Allow**। स्क्रिप्ट आपकी Sheets और Drive इसलिए माँगती है कि वह आपके नाम से चलती है।
   **अगर "Anyone" का विकल्प नहीं दिखता**, तो आपके संगठन के एडमिन ने उसे रोका है और यह तरीका बिना Google अकाउंट वाले लोगों के लिए नहीं चलेगा। रुकिए और प्रोजेक्ट टीम को बताइए।
7. **Web app URL** (अंत में `/exec`) फ़ोन ऐप सेट करने वाले को दीजिए। ब्राउज़र में "This page is not available" दिखे तो ठीक है।
8. **बाद में कोड बदलें तो:** Deploy -> Manage deployments -> पेंसिल -> Version **New version** -> Deploy। URL वही रहता है।

**कोड चुनिए नहीं, बनवाइए।** छोटा, याद रखने लायक कोड (`BIHAR2026`) ही अंदाज़ा लगाने की कोशिश को आसान बनाता है, और कोड एक तेज़ हैश में रखे जाते हैं। कोड सिर्फ़ मेन्यू से ही बनता है (10 अक्षर, मिलते-जुलते अक्षर नहीं); अपने मन से कोड चुना नहीं जा सकता। **सेल में टाइप किया कोड स्क्रिप्ट मिटा देती है** और वहाँ कारण का नोट लगा देती है — उस कोड को जला हुआ ही मानिए, क्योंकि Google Sheets की **version history** टाइप किया हुआ पाठ रख लेती है और एडिट-अधिकार वाला हर व्यक्ति उसे पढ़ सकता है। ऐसा हो गया हो तो मेन्यू से उस व्यक्ति का नया कोड बनवाइए।

**पहुँच बंद या बदलना:** एक व्यक्ति - Active `no` कीजिए या नया कोड दीजिए। पूरे प्रोजेक्ट को - उसकी सारी पंक्तियाँ बंद कीजिए। फ़ोन के अगले अनुरोध से असर होता है। सारे सेशन एक साथ ख़त्म करने हों तो Project Settings में `TOKEN_SECRET` प्रॉपर्टी मिटा दीजिए।

**कुछ गड़बड़ हो तो**

- *फ़ोन कहे कि कोड मंज़ूर नहीं:* ग़लत कोड, बंद किए गए व्यक्ति और अनजान व्यक्ति के लिए जानबूझकर एक ही संदेश आता है। Active `yes` है? Project का नाम ठीक मिलता है? दोनों id भरे हैं? कोड वही है जो दिया था? *Check the Projects and People tabs* चलाइए।
- *सही कोड फिर भी रद्द:* दो सक्रिय लोगों का कोड एक ही हो सकता है (जानबूझकर रद्द होता है), या कोई प्रोजेक्ट नाम दो बार है। जाँच चलाइए।
- *कई ग़लत कोड के बाद साइन-इन धीमा लगे:* यह ठीक है। हर ग़लत कोड के बाद **अगला ग़लत कोड** थोड़ा और इंतज़ार करता है (ज़्यादा से ज़्यादा कुछ सेकंड)। सही कोड न कभी रुकता है, न रद्द होता है — चाहे पहले कितने भी ग़लत कोड आए हों।
- *"busy" या "server problem":* कुछ खोया नहीं; फ़ोन रिकॉर्ड रखकर दोबारा कोशिश करता है। घंटों चले तो Google की रोज़ की सीमा आ गई होगी; अगले दिन देखिए।
- *फिर "Authorization required":* चरण 6 की अनुमति दोहराइए।
- *कोड वाला ख़ाना ख़ाली हो गया और उस पर नोट लगा है:* किसी ने हाथ से कोड टाइप किया था, स्क्रिप्ट ने उसे मिटा दिया। मेन्यू से नया कोड बनाइए।

## Backend tests

```
node --test appsscript/tests/
```

`backend.test.js` runs the whole request flow (`dispatch`) against in-memory fakes of Sheets and Drive. It does **not** cover `doPost` itself, real Sheets/Drive access, deployment, or Apps Script's own crypto, lock and trigger calls.
