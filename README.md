# BKM Item Returns

A mobile-first web app for logging item returns straight into a Google Sheet.

Each submission records:

- **Date** (defaults to today)
- **Customer** — text field with autocomplete suggestions pulled from the
  customer list in the sheet
- **Item name**
- **Quantity** (with +/- stepper)
- **With paper** — toggle, off by default
- **Remarks**

New customers you type are automatically added back to the customer list, so
the autocomplete improves over time.

## Why Google Apps Script?

The app is a [Google Apps Script](https://script.google.com) web app bound to
your spreadsheet. This means:

- No separate server, hosting, or database to manage.
- No API keys or OAuth credentials to wire up — the script already has
  permission to read and write *its own* spreadsheet.
- One URL you can open (and "Add to Home Screen") on any phone.

The source lives in [`apps-script/`](apps-script/):

| File              | Purpose                                            |
| ----------------- | -------------------------------------------------- |
| `Code.gs`         | Server-side: serves the page, reads/writes the sheet |
| `Index.html`      | The mobile UI (HTML + CSS + JS in one file)        |
| `appsscript.json` | Project manifest (timezone + web app settings)     |

## Setup

### 1. Create the spreadsheet

1. Create a new Google Sheet (this becomes your returns database).
2. Add a tab named **`Customers`**. Put one customer name per row in
   column A. (A header cell saying `Customer` in A1 is fine — it's skipped.)
   You can leave this empty and let it fill up as you submit returns.
3. The **`Returns`** tab is created automatically on the first submission,
   with headers: `Date | Customer | Item Name | Quantity | With Paper |
   Remarks | Submitted At`.

### 2. Add the script

1. In the sheet, go to **Extensions → Apps Script**.
2. Delete the default `Code.gs` contents and paste in this repo's
   `apps-script/Code.gs`.
3. Click **+ → HTML** and create a file named **`Index`** (no extension).
   Paste in `apps-script/Index.html`.
4. (Optional) Open **Project Settings → "Show appsscript.json"** and match
   the contents of `apps-script/appsscript.json`. Adjust `timeZone` to yours.
5. Save.

> Using [`clasp`](https://github.com/google/clasp)? You can `clasp clone`
> your script project and push the `apps-script/` folder directly.

### 3. Deploy as a web app

1. Click **Deploy → New deployment**.
2. Select type **Web app**.
3. Set:
   - **Execute as:** *Me*
   - **Who has access:** *Anyone* (or *Anyone within your organization*).
     Pick whatever matches who should be able to log returns.
4. Click **Deploy**, authorize the requested permissions, and copy the
   **web app URL**.

### 4. Use it on your phone

Open the web app URL on your phone and add it to your home screen for an
app-like experience:

- **iPhone (Safari):** Share → *Add to Home Screen*
- **Android (Chrome):** ⋮ menu → *Add to Home screen*

Submit a return and watch the row appear in the `Returns` tab.

## Updating

After editing the code, redeploy: **Deploy → Manage deployments → ✎ (edit)
→ Version: New version → Deploy**. Keeping the same deployment preserves the
URL.

## Configuration

Sheet/tab names and column headers are defined at the top of `Code.gs`:

```js
var RETURNS_SHEET = 'Returns';
var CUSTOMERS_SHEET = 'Customers';
```

Change these if you prefer different tab names.
