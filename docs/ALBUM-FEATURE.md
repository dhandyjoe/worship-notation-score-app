# Albums — feature reference (Fase 3 + 4)

Feature: **shared albums with invite-code self-join**, built for GKJ Nehemia so
the music leader can curate arrangements and every musician can read them.

## Decisions (agreed with the team)

| Topic | Decision |
| --- | --- |
| Access model | Every musician uses **their own account** (Google / email). No shared password. |
| Joining | **Self-service invite code** only — no invite links. Code verified **server-side in Firestore rules**. |
| Roles | `owner` (full) and `member` (read-only) for MVP. The `role` field can later gain an `editor` role without data migration. |
| Multi-owner | Any owner may **promote another member to co-owner** (all owners equal). The rules forbid an owner from writing their own membership, so the **last owner can never be demoted/removed** and leave the album owner-less. |
| Member rights | Read the album, play, **change Key / Time signature / BPM**, **transpose**, export PDF, and **save a private copy to My Songs**. Everything that edits the arrangement (chords/numbers, lyrics, bars, sections, copy/paste, rename, reset, import) is locked. |
| Member identity | A member row shows `Auth.displayName` when it exists (Google sign-in fills it). Email/password sign-up does **not** set one, so the name is derived from the email's local part (`dhandy.joe@gmail.com` → **Dhandy Joe**); "Musician" is only the last-resort label for id-like addresses (e.g. `x7k2p9@…`). The email is always shown under the name. |
| Song storage | Album songs are **standalone copies** under `albums/{id}/songs/...` (same version model as `users/{uid}/songs`). Owners create songs **directly in the album**; "Add from My Songs" copies an existing song (all arrangements) as a bonus. |
| UI | Home gains a **My Songs | Albums** tab. Album detail shows the song grid, owner actions (Invite, Add from My Songs, New Song, Members) and member actions (Leave). The home toolbar's **New Song / Attach Link** buttons belong to My Songs and are hidden while the Albums tab is active (that tab has its own **New Album / Join with code** actions). Editor shows a context pill + read-only banner for members, and the save button becomes "Save a copy". |

## Data model

```
albums/{albumId}                                → { name, description, createdBy, createdAt, updatedAt, songCount }
albums/{albumId}/songs/{songId}                 → metadata (same shape as user songs)
albums/{albumId}/songs/{songId}/versions/{id}   → arrangements (same shape as user versions)
albums/{albumId}/members/{uid}                  → { uid, role, name, email, joinedAt, addedBy }
inviteCodes/{code}                              → { albumId, active, createdAt, createdBy }   (doc ID = code)
users/{uid}/albumMemberships/{albumId}          → enumerable "my albums" pointer
```

## Security model (Firestore rules)

- `albums/{albumId}/**` — read = member, write = owner. The album document's
  **create** additionally has a dedicated rule so the creator can seed it before
  any membership exists (`createdBy == uid`).
- Member `create` grants join **only** when `inviteCodes/{code}` exists, is
  `active`, and `albumId` matches the path being written (fully server-side).
  The album **creator** may also seed their own `owner` membership (the rule
  checks `albums/{albumId}.createdBy == uid`).
- `inviteCodes/{code}` — GET allowed to resolve code→album at join; `list`/`delete`
  denied for everyone; create/update gated to the album's owner (checked on the
  write's data, no self-referencing `get()`).
- Member self-update allowed only to strip the `inviteCode` field (role locked);
  member self-delete = leaving; owners manage other members.
- `albums/{albumId}/members/{uid}` — read: **always your own row** (`uid ==
  auth.uid`) plus the member list for members, so stale membership pointers
  self-heal instead of surfacing as a permission error. Create = self via invite
  code / owner-seed; update/delete = owners (or self-leave for members).
- Full rules text: `docs/FIREBASE-SETUP.md`.

## Save direction & version scope (editor)

The editor keeps a **cloud context** (`scope`, `albumId`, `albumName`, `role` +
`songId`, `versionId`, `versionLabel`) that decides where everything is read and
written. The album fields are preserved through the editor's context
normalization (`events.js → setCloudContext`) — dropping them is what used to
send album actions to the My Songs path (empty version list, stray songs).

| Action | Where it writes |
| --- | --- |
| **Save to Album** (owner, `#/album/...`) | `albums/{albumId}/songs/{songId}/versions` — never `users/{uid}/songs` |
| **Save a copy** (member) | private copy under `users/{uid}/songs`, then the editor switches to that copy (context + URL), so later saves stay in My Songs |
| **Save to Cloud** (My Songs song) | `users/{uid}/songs/{songId}/versions` |
| Version list / switch / rename / delete | follows the same scope (`listAlbumVersions` vs `listVersions`) |
| Rename + YouTube link of an album version | persisted in ALBUM scope on the next Save (`persistPendingVersionDetails`) |

Save direction is resolved in layers — cloud context → in-memory album memo
(`activeAlbumCtx`) → current URL — so a lost context or a rewritten hash can
never redirect an album save into the personal library. A final assertion
throws instead of silently creating a stray My Songs song.

**Add from My Songs** copies **every arrangement** of the source song, content
included (sections/bars/chords/lyrics/key/meter/editorMode/YouTube link), and
carries the source `label`/`number` over so the album keeps the same version
names and ordering. The copy is **all-or-nothing**: if one write fails midway,
the partially copied album song is deleted again.

## Unsaved-changes handling inside an album

- **New Song** in an album opens an unsaved draft, exactly like New Song in My
  Songs: the yellow badge shows on **Save to Album** from the very first moment
  and leaving the editor (Back button, browser Back, reload/tab close) runs the
  Save & leave / Leave without saving / Cancel dialog.
- The badge's accessible label follows the active scope — `Save to Album`
  (owner), `Save a copy` (member), `Save to Cloud` (My Songs).
- Every other exit path (switching versions, New Song, opening another song,
  sign-out) goes through the same unsaved-changes gate.

## Member read-only canvas (editor)

A member opening an album arrangement gets a **read-only canvas**. Exactly four
controls stay usable:

| Allowed for a member | Locked for a member |
| --- | --- |
| **Key** (`#keySelect` / inline `#previewKey`), **Time signature** (`#timeSignature` / `#previewMeter`), **BPM** (`#bpmInput`), **Transpose −/+**, play/stop, Export `.pdf`, theme, zoom | chords & Nashville numbers (click / drag / palette / rhythm menu / remove subdivision), lyrics + chord-above typing & paste, auto-syllable, **+ Add 1 bar**, **delete bar**, **delete section**, **+ Add section**, **Copy bar / Copy bars (range selection)**, **copy/paste section**, rename section, **Reset Sheet**, Title/Artist edits, palette pickers / custom chord / slash builder, Load `.file` |

How it is enforced (three layers, so a single missed handler can't leak):

1. `cloudUI.js → syncAlbumContextUI()` sets `document.body.dataset.memberReadonly`
   (`"1"` for a member, `"0"` otherwise).
2. `events.js` — `blockedForMember()` is called at the top of **every** mutating
   handler (39 call sites), and `applyMemberReadOnlyAffordances()` (called at the
   end of `bindPreview()`, i.e. after each render) disables the in-preview buttons
   and sets `readOnly` on the lyric / chord-above fields.
3. `styles/ui.css` — `body[data-member-readonly="1"] …` dims and deactivates the
   controls that live outside the preview (ribbon panels/tabs, section menu,
   footer buttons, lyrics / chords-above toggles).

Undo/Redo intentionally stays available: `applyProject()` clears the history
stack when a document is loaded, so undo can only move between the album
document as loaded and the edits a member is allowed to make — it can never
introduce bars, sections or chords.

The read-only banner itself is **app-shell chrome, not score content**: it is
hidden for printing (`@media print` in `styles/ui.css` hides `.album-banner`
next to `.scroll-affordance` / `.site-footer` / `.toast`), so the member notice
never appears on an exported PDF. The legacy print rule in `styles/styles.css`
only covers `.topbar` / `.intro` / `.editor-card` / `.preview-footer` — add any
new app-shell overlay to the ui.css print block as well.

## Manual test recipe

1. Publish the new rules in Firestore (see `docs/FIREBASE-SETUP.md`).
2. User A (owner): sign in → **Albums → New Album** → open it → **Invite** → copy code.
3. User B (member): sign in (own account) → **Albums → Join with code** → paste code → album appears.
4. Owner: **New Song** (created directly in the album) or **Add from My Songs** → save.
5. Member: open the song → read-only banner + "Save a copy" visible; no edit/delete.
6. Owner: **Members** → promote B to co-owner → B can now add songs too.
7. Owner: **Invite → Create new code** → old code stops working immediately.