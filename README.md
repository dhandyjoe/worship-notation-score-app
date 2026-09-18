# WorshipNotationScore

Chord & Number Score Builder — arrange chords and number (Nashville) notation, ready to play and export to PDF.

**Live demo:** https://dhandyjoe.github.io/worship-notation-score-app/

## Features

- 🎸 Chord palette, slash-chord builder, and full Nashville Number System (with upper/lower octave dots)
- 📝 **Three writing modes** — chosen in the **New Song** dialog, where each mode gets its
  own animated preview card: **Chord Chart** (beat grid + chords), **Nashville Numbers**
  (degrees 1–7, optional lyrics under each beat) and **ChordPro** (lyrics with chords in
  `[brackets]` — the simplest one, no rhythm notation at all). A new ChordPro song opens
  with two ready-to-type sections, **Intro** and **Verse**.
- 🎹 **Instrumental playback** — chords & Nashville numbers are resolved to real piano audio
  (multi-sample **Salamander Grand Piano** V3 — Yamaha C5, recorded by Alexander Holm). Letter
  chords play as a chord, Nashville numbers as a single note; empty beats can click as a metronome.
- 🥁 Rhythm subdivisions ½ / ⅓ / ¼ per beat (nested up to two levels)
- 📝 Per-beat lyrics — paste a sentence to auto-distribute words across bars
- ♻️ Transpose all chords by semitone (chords + key) — works in every mode, including ChordPro
- 🌗 Light/dark theme, zoom, and a dedicated PDF-layout preview
- 📄 Export to PDF (print) and save/load projects as `.chordsheet.json`
- 📁 **Albums (Fase 3/4)** — shared albums (e.g. a church praise team) where an
  owner curates arrangements and every member can read them. Joining is
  **self-service with an invite code** verified **server-side by Firestore rules**
  (no password sharing, no links — each musician uses their own account). Members
  view read-only and can save a private copy; any owner may invite, promote
  co-owners, or remove members.

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
│   ├── chordPro.js     #   pure ChordPro parser/transposer/normalizer (unit-tested)
│   ├── chordProEditor.js  # ChordPro workspace UI (editor panel + palette)
│   ├── pdf.js          #   PDF export pipeline
│   ├── pdfOptions.js   #   PDF layout options modal
│   ├── dom.js          #   thin browser helpers
│   ├── cloud.js        #   Firebase wrapper (lazy-loaded auth + Firestore)
│   ├── cloudUI.js      #   login modal + "My Songs"/"Albums" home + album UI
│   └── firebase-config.js  # public-safe Firebase web config
├── styles/             # Stylesheets
│   ├── styles.css      #   design tokens (:root variables)
│   ├── ui.css          #   app shell, ribbon, responsive, dark theme
│   ├── preview.css     #   score canvas + print/PDF layout
│   └── chordpro.css    #   ChordPro workspace + its print layout (self-contained)
├── assets/             # Static assets (favicon)
├── docs/               # Project docs (Firebase / Firestore setup)
└── tests/              # Unit + regression tests
    ├── unit.test.mjs
    └── regression.mjs
```

The JavaScript is split into small, focused ES modules with an acyclic dependency graph:

| Module            | Responsibility                                            | Depends on                   |
| ----------------- | --------------------------------------------------------- | ---------------------------- |
| `src/notation.js` | Pure music/notation + section-data logic (no DOM)         | —                            |
| `src/chordPro.js` | Pure ChordPro parse/transpose/normalize (no DOM)           | notation                     |
| `src/dom.js`      | Thin browser helpers (`$`, `toast`, `prefersTap`)         | —                            |
| `src/store.js`    | Single source of truth for state + palette selection      | notation                     |
| `src/render.js`   | View layer: builds score HTML and writes it to the DOM    | notation, dom, store, chordPro |
| `src/chordProEditor.js` | ChordPro workspace UI (editor panel, palette, sections) | chordPro, notation, dom, store |
| `src/events.js`   | All user interaction, listeners, import/export, bootstrap | notation, chordPro, dom, store, render, chordProEditor |
| `src/app.js`      | Entry point (`initEvents()`)                              | events                       |
| `src/cloud.js`    | Firebase wrapper — lazy-loads auth + Firestore from CDN   | firebase-config, notation    |
| `src/cloudUI.js`  | Login modal + "My Songs"/"Albums" home + album UI      | cloud, dom, notation         |

`render.js` never imports `events.js`; instead `events.js` injects its DOM-binding
hooks via `initRender(...)`, which keeps the module graph free of cycles. The cloud
feature is self-contained: `cloudUI` talks to Firebase only through `cloud.js`, and
to the editor only through injected callbacks — so it never imports `events.js`.
`chordProEditor.js` follows the same rule (`initChordProEditor(...)`), so the
ChordPro workspace never imports `events.js` either.

### ChordPro mode

A third writing mode for musicians who just want lyrics with chords above them —
no beat grid, no rhythm notation. Each section keeps its source text verbatim in
`section.chordPro`, and rendering/transposing are pure transforms over that text.

Supported syntax (a deliberate, minimal subset of the ChordPro spec):

```
[C]Amazing [G]grace        inline chords — letter, slash (G/B), Nashville (1, ♭7) and N.C.
{soc} / {eoc}              section header (also {sov}, {sob}, {sopc}, long {start_of_*})
{c: play softly}           comment line
{title:} {artist:} {key:}  metadata (read on .cho/.pro import)
[Verse 1]                  a bracket-only line that is NOT a chord = section label
```

Why not the `chordsheetjs` npm package: this app is a no-build-step static site with
a service-worker offline shell, so a runtime dependency would break both the
"serve over HTTP" workflow and offline use. The hand-written parser is ~400 lines of
pure code, unit-tested, and **unknown directives are parsed then ignored**, so text
pasted from another ChordPro app can never break a score.

Editor behaviour: the left panel holds the song metadata (title, creator, key, time
signature, transpose) plus one plain text field per section — chords are typed inline
as `[C]`, and the right panel updates live as you type. There is intentionally **no
chord palette and no drag & drop** in this mode: typing brackets is the whole point
for beginners. Typing commits through a debounced save, so one typing burst is one
undo step.

**Starting a ChordPro song.** **+ New Song** first asks for the first arrangement's name,
then shows the three mode cards — pick **♬ ChordPro** and the editor opens with two
sections already in place, so the format is obvious at a glance:

```
Intro    [C] [Am7] [Dm7] [G7] [Cmaj7]                          ← chord-only progression
Verse    [C]Type your lyric here and wrap each [G]chord in square [Am]brackets [F]
```

Both are ordinary sections — rename, reorder (↑ ↓), delete (×) or add more with
**+ Add section** (up to `MAX_SECTIONS`). Only ChordPro gets this two-section start; the
other two modes still begin with a single empty *Intro*.

**Adjacent chords stay readable.** The parser keeps the whitespace *between* bracketed
chords instead of throwing it away, and a run of chords with no lyrics after it is flagged
`is-chord-only`, which gets a little trailing padding. So `[C] [Am7] [Dm7] [G7] [Cmaj7]`
renders as `C Am7 Dm7 G7 Cmaj7` with breathing room — not the collided `CAm7Dm7G7Cmaj7`.

**Print parity.** The right-hand pane is labelled *LIVE PREVIEW · Exported to PDF exactly
like this*, and that is literally true: the ChordPro page reuses the Chord Chart print
geometry (same page padding, title margin, `KEY`/`TIME` row and section-label box), only
the lyrics are printed at score size (chord ≈ 5.4 mm, lyric ≈ 4.3 mm, both derived from the
PDF-options sliders). Chord size, lyric size, paper and margins are stored **per song**, and
the label above the preview lines up with the preview's own content column.

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
| `styles/chordpro.css`| ChordPro workspace + its print layout — fully self-contained (`cp-`-prefixed selectors or `body[data-editor-mode="chordpro"]` gated, so the two original modes are untouched) |

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
