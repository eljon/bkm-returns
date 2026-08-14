# BKM Item Returns

A mobile-first web app for logging item returns, backed by
[Cloud Firestore](https://firebase.google.com/docs/firestore).

Each submission records:

- **Date** — defaults to today
- **Customer** — text field with autocomplete pulled from recent returns
- **Item**
- **QTY** — with a +/- stepper
- **DR #** — delivery-receipt number (optional)

New returns appear in a **Recent returns** list right below the form, and the
customer names you enter feed the autocomplete over time.

The whole app is static HTML/CSS/JS (no build step) that talks directly to
Firestore from the browser, so it can be hosted anywhere that serves static
files. This repo is set up for **GitHub Pages** (served from the repo root),
with Firestore as the database.

## Project layout

| Path                    | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `index.html`            | Mobile UI (HTML + CSS)                          |
| `app.js`                | Firestore reads/writes (Firebase modular SDK)  |
| `firebase-config.js`    | Your project's web config                       |
| `manifest.webmanifest`  | PWA manifest for "Add to Home Screen"           |
| `.nojekyll`             | Tells GitHub Pages to serve files as-is         |
| `firestore.rules`       | Security rules for the `returns` collection     |
| `firestore.indexes.json`| Firestore index definitions (none needed yet)   |
| `firebase.json`         | Firestore config (used by the Firebase CLI)     |
| `.firebaserc`           | Default Firebase project alias                  |

> GitHub Pages hosts the **website**. It does **not** deploy the Firestore
> **security rules** — those have to be published to Firebase separately (see
> step 3 below).

## Data model

A return is one **transaction** that can hold several items. Each item is
stored as its own document in the `returns` collection, and all items from the
same transaction share a `txnNo`:

```
returns/{autoId}
  txnNo:     "R-0042"        // string, shared by items in one return
  seq:       42              // integer, the running transaction number
  date:      "2026-08-14"    // string, YYYY-MM-DD
  customer:  "Acme Corp"      // string
  item:      "Coffee Mug"     // string
  condition: "Good"           // "Good" | "Defective"
  qty:       3                // integer >= 1
  drNumber:  "DR-1024"        // string ("" when omitted)
  createdAt: <server timestamp>
```

Transaction numbers are **sequential** (`R-0001`, `R-0002`, …). A single
`counters/returns` document holds the running count; each save bumps it by one
inside a Firestore transaction, so the same number is never reused. The
**Recent returns** list groups documents by `txnNo` so each transaction shows
as one card with its line items.

## Setup

### 1. Create a Firebase project

1. Go to the [Firebase console](https://console.firebase.google.com) and
   **Add project**.
2. In **Build → Firestore Database**, click **Create database** and start in
   **production mode** (the rules in this repo will secure it).
3. In **Project settings → General → Your apps**, click the web icon
   (`</>`) to register a web app, then copy the `firebaseConfig` object.

### 2. Wire up the config

Paste your values into [`firebase-config.js`](firebase-config.js),
replacing the `YOUR_*` placeholders. Also set your project id in
[`.firebaserc`](.firebaserc).

> The values in `firebaseConfig` are **not secrets** — they only identify your
> project to the client SDK. Your data is protected by the Firestore security
> rules, not by hiding this config.

### 3. Publish the security rules to Firestore

GitHub Pages only hosts the website, so you must load the rules into Firebase
yourself. Easiest way — no tooling required:

1. Firebase console → **Firestore Database → Rules** tab.
2. Delete what's there and paste the contents of
   [`firestore.rules`](firestore.rules).
3. Click **Publish**.

(Or, if you have the [Firebase CLI](https://firebase.google.com/docs/cli):
`firebase deploy --only firestore:rules`.)

Without this step the database stays locked and the app can't read or write.

### 4. Turn on GitHub Pages

1. GitHub repo → **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. **Branch:** pick the branch these files are on, **Folder:** `/ (root)`.
4. Click **Save**. After a minute Pages shows your live URL, e.g.
   `https://<your-user>.github.io/bkm-returns/`.

### 5. Use it on your phone

Open the Pages URL on your phone and add it to your home screen:

- **iPhone (Safari):** Share → *Add to Home Screen*
- **Android (Chrome):** ⋮ menu → *Add to Home screen*

Submit a return and watch it appear in the **Recent returns** list — and in
the Firestore console under the `returns` collection.

## Security notes

The default [`firestore.rules`](firestore.rules) let **anyone** with the app
URL create well-formed returns (no login), while making existing records
**read-only and immutable**. That's convenient for an internal tool but means
the create endpoint is open to the public.

To lock it down, add [Firebase Authentication](https://firebase.google.com/docs/auth)
and change the `create` rule to require a signed-in user:

```
allow create: if request.auth != null && isValidReturn(request.resource.data);
```

## Updating

Edit the site files and push — GitHub Pages redeploys automatically and
keeps the same URL. If you change `firestore.rules`, re-publish them in the
Firestore **Rules** tab (or `firebase deploy --only firestore:rules`).
