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
Firestore from the browser, and it's deployed on **Firebase Hosting**.

## Project layout

| Path                        | Purpose                                        |
| --------------------------- | ---------------------------------------------- |
| `public/index.html`         | Mobile UI (HTML + CSS)                          |
| `public/app.js`             | Firestore reads/writes (Firebase modular SDK)  |
| `public/firebase-config.js` | Your project's web config — **fill this in**   |
| `public/manifest.webmanifest` | PWA manifest for "Add to Home Screen"        |
| `firebase.json`             | Hosting + Firestore config                      |
| `firestore.rules`           | Security rules for the `returns` collection     |
| `firestore.indexes.json`    | Firestore index definitions (none needed yet)   |
| `.firebaserc`               | Default Firebase project alias — **fill this in** |

## Data model

Documents are stored in a single `returns` collection:

```
returns/{autoId}
  date:      "2026-08-14"     // string, YYYY-MM-DD
  customer:  "Acme Corp"       // string
  item:      "Coffee Mug"      // string
  qty:       3                 // integer >= 1
  drNumber:  "DR-1024"         // string ("" when omitted)
  createdAt: <server timestamp>
```

## Setup

### 1. Create a Firebase project

1. Go to the [Firebase console](https://console.firebase.google.com) and
   **Add project**.
2. In **Build → Firestore Database**, click **Create database** and start in
   **production mode** (the rules in this repo will secure it).
3. In **Project settings → General → Your apps**, click the web icon
   (`</>`) to register a web app, then copy the `firebaseConfig` object.

### 2. Wire up the config

Paste your values into [`public/firebase-config.js`](public/firebase-config.js),
replacing the `YOUR_*` placeholders. Also set your project id in
[`.firebaserc`](.firebaserc).

> The values in `firebaseConfig` are **not secrets** — they only identify your
> project to the client SDK. Your data is protected by the Firestore security
> rules, not by hiding this config.

### 3. Deploy

Install the CLI once, then log in and deploy:

```bash
npm install -g firebase-tools
firebase login
firebase deploy            # deploys hosting + Firestore rules & indexes
```

Firebase prints a **Hosting URL** like `https://YOUR_PROJECT_ID.web.app` —
that's your app.

You can also run it locally first:

```bash
firebase emulators:start   # Hosting + Firestore emulators
# or just serve the static site:
firebase serve --only hosting
```

### 4. Use it on your phone

Open the Hosting URL on your phone and add it to your home screen:

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

Edit files under `public/` (or the rules) and run `firebase deploy` again.
Hosting keeps the same URL across deploys.
