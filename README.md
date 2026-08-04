# WorshipNotationScore

Chord & Number Score Builder — arrange chords and number (Nashville) notation, ready to play and export to PDF.

**Live demo:** https://dhandyjoe.github.io/worship-notation-score-app/

## Features

- 🎸 Chord palette, slash-chord builder, and full Nashville Number System (with upper/lower octave dots)
- 🥁 Rhythm subdivisions ½ / ⅓ / ¼ per beat (nested up to two levels)
- 📝 Per-beat lyrics — paste a sentence to auto-distribute words across beats
- 🔁 Transpose the whole score by semitone (chords + key)
- 🌗 Light/dark theme, zoom, and a dedicated PDF-layout preview
- 📄 Export to PDF (print) and save/load projects as `.chordsheet.json`

## Running

The app is built from native ES modules, so it must be served over HTTP (opening
`index.html` via `file://` will break module loading):

```sh
python3 -m http.server 4173
# then open http://127.0.0.1:4173/
```

> ⚠️ The score lives in memory for the session only — use **Export .file** to save your work.

## Deployment (GitHub Pages)

This is a fully static site (no build step). It is deployed with **Settings → Pages → Deploy from a branch → `master` / `/root`**.

- All asset paths are **relative**, so the app works under the `/worship-notation-score-app/` subpath.
- A `.nojekyll` file at the repo root disables Jekyll processing.
- To publish changes: commit and `git push origin master` — Pages redeploys automatically.
- **Firebase login** requires the Pages host (`dhandyjoe.github.io`) to be listed under
  **Firebase Console → Authentication → Settings → Authorized domains**. See
  [`docs/FIREBASE-SETUP.md`](docs/FIREBASE-SETUP.md).

## Architecture

The project uses a clean, flat layout that keeps concerns separated:

```
chord-sheet/
├── index.html          # App shell (server entry point)
├── README.md
├── src/                # ES modules (application logic)
│   ├── app.js          #   bootstrap entry — calls initEvents()
│   ├── events.js       #   user interaction, listeners, import/export
│   ├── render.js       #   view layer — builds score HTML
│   ├── store.js        #   single source of truth for state
│   ├── notation.js     #   pure music/notation logic (unit-tested)
│   ├── pdf.js          #   PDF export pipeline
│   ├── pdfOptions.js   #   PDF layout options modal
│   ├── dom.js          #   thin browser helpers
│   ├── cloud.js        #   Firebase wrapper (lazy-loaded auth + Firestore)
│   ├── cloudUI.js      #   login modal + "My Songs" gallery
│   └── firebase-config.js  # public-safe Firebase web config
├── styles/             # Stylesheets
│   ├── styles.css      #   design tokens (:root variables)
│   ├── ui.css          #   app shell, ribbon, responsive, dark theme
│   └── preview.css     #   score canvas + print/PDF layout
├── assets/             # Static assets (favicon)
├── docs/               # Project docs (Firebase / Firestore setup)
├── samples/            # Example .chordsheet.json songbooks
└── tests/              # Unit + regression tests
    ├── unit.test.mjs
    └── regression.mjs
```

The JavaScript is split into small, focused ES modules with an acyclic dependency graph:

| Module            | Responsibility                                            | Depends on                   |
| ----------------- | --------------------------------------------------------- | ---------------------------- |
| `src/notation.js` | Pure music/notation + section-data logic (no DOM)         | —                            |
| `src/dom.js`      | Thin browser helpers (`$`, `toast`, `prefersTap`)         | —                            |
| `src/store.js`    | Single source of truth for state + palette selection      | notation                     |
| `src/render.js`   | View layer: builds score HTML and writes it to the DOM    | notation, dom, store         |
| `src/events.js`   | All user interaction, listeners, import/export, bootstrap | notation, dom, store, render |
| `src/app.js`      | Entry point (`initEvents()`)                              | events                       |
| `src/cloud.js`    | Firebase wrapper — lazy-loads auth + Firestore from CDN   | firebase-config              |
| `src/cloudUI.js`  | Login modal + "My Songs" cloud gallery                    | cloud, dom                   |

`render.js` never imports `events.js`; instead `events.js` injects its DOM-binding
hooks via `initRender(...)`, which keeps the module graph free of cycles. The cloud
feature is self-contained: `cloudUI` talks to Firebase only through `cloud.js`, and
to the editor only through injected callbacks — so it never imports `events.js`.

### Cloud sync (optional)

Sign-in is **optional** — the editor works fully without an account. Signing in
adds a personal cloud library (**Save to Cloud** / **My Songs**) backed by Firebase
Auth + Firestore. The Firebase web config in `src/firebase-config.js` is
**public-safe**; data is protected by Firestore security rules and the project's
authorized domains. See [`docs/FIREBASE-SETUP.md`](docs/FIREBASE-SETUP.md) for the
Firestore rules, data model, and setup checklist.

### Stylesheets

| File                 | Responsibility                                                       |
| -------------------- | -------------------------------------------------------------------- |
| `styles/styles.css`  | Design tokens (`:root` variables)                                    |
| `styles/ui.css`      | Application shell, ribbon, dark theme, responsive rules              |
| `styles/preview.css` | Score canvas + print/PDF layout (`@media print` / `is-print-layout`) |

## Testing

**Unit tests** (pure logic — transpose, normalization, slots; no browser needed):

```sh
node --test tests/unit.test.mjs
```

**Regression tests** (layout/print geometry — requires Chrome with remote debugging):

```sh
# Terminal 1 — app server
python3 -m http.server 4173
# Terminal 2 — Chrome with a debugging port
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9223
# Terminal 3 — run the suite
node tests/regression.mjs
```
