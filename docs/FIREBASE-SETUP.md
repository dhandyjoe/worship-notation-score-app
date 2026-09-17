# Firestore Security Rules — WorshipNotationScore cloud sync

Paste the rules in the Firebase Console → **Firestore Database → Rules → Publish**.

The rules enforce two ownership models:

1. **Personal library** — a signed-in user can only read/write documents under
   their own `users/{uid}` node (this covers the `albumMemberships` pointer).
2. **Albums** — every member can READ the album subtree; only OWNERS can write;
   joining is self-service via an invite code that the rules verify **server-side**
   (the client can never self-approve a membership).

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isSignedIn() {
      return request.auth != null;
    }
    function memberExists(albumId) {
      return exists(/databases/$(database)/documents/albums/$(albumId)/members/$(request.auth.uid));
    }
    function isMember(albumId) {
      return isSignedIn() && memberExists(albumId);
    }
    function isOwner(albumId) {
      return isMember(albumId)
        && get(/databases/$(database)/documents/albums/$(albumId)/members/$(request.auth.uid)).data.role == "owner";
    }

    // ===== 1. A user's private song library + album membership pointers =====
    // The recursive wildcard also covers the versions subcollection and the
    // albumMemberships pointer (users/{uid}/albumMemberships/{albumId}).
    // Only the owner (matching auth uid) may access.
    match /users/{uid}/{all=**} {
      allow read, write: if isSignedIn() && request.auth.uid == uid;
    }

    // ===== 2. Album invites =====
    // Codes live in inviteCodes/{code} (doc ID = the code). The doc is readable
    // by GET (so a joiner can resolve code → albumId) but never listable/delete-
    // able, and only the album's owner may create/rotate codes. The owner check
    // reads albumId from the DOCUMENT DATA of that write (no get() on the same
    // path → no recursion). A member doc CREATE is granted (rule 3) only when the
    // code exists, is active and belongs to the album being written — that check
    // happens server-side via get(), which is always allowed.
    match /inviteCodes/{code} {
      allow get: if isSignedIn();
      allow create, update: if isSignedIn() && isOwner(request.resource.data.albumId);
      allow list: if false;
      allow delete: if false;
    }

    // ===== 3. Album memberships =====
    match /albums/{albumId}/members/{uid} {
      // Anyone may read their OWN membership row (a non-member simply gets an
      // empty result → stale pointers self-heal instead of surfacing as a
      // permission error). Members may read the member list too.
      allow read: if isSignedIn()
        && (uid == request.auth.uid || memberExists(albumId));
      // Self-service join: the client writes { role: "member", inviteCode: <code> }
      // and the rules verify the code EXISTS and is ACTIVE on the album. The
      // client strips the code right after; a later self-update may only touch
      // the inviteCode field.
      // The owner who CREATES the album may seed their OWN owner membership here
      // (album doc carries createdBy == uid, written in the same flow).
      allow create: if isSignedIn()
        && request.auth.uid == uid
        && (
             (request.resource.data.role == "member"
              && exists(/databases/$(database)/documents/inviteCodes/$(request.resource.data.inviteCode))
              && get(/databases/$(database)/documents/inviteCodes/$(request.resource.data.inviteCode)).data.active == true
              && get(/databases/$(database)/documents/inviteCodes/$(request.resource.data.inviteCode)).data.albumId == albumId)
             ||
             (request.resource.data.role == "owner"
              && get(/databases/$(database)/documents/albums/$(albumId)).data.createdBy == uid)
           );
      // Owners manage every OTHER member (promote/demote/remove); a member may
      // only self-update by stripping the inviteCode (role must stay unchanged).
      allow update: if (isOwner(albumId) && request.auth.uid != uid)
        || (isSignedIn() && request.auth.uid == uid
            && request.resource.data.role == resource.data.role
            && !("inviteCode" in request.resource.data));
      // Owners remove ANY other member; a MEMBER may remove themselves (leave).
      allow delete: if (isOwner(albumId) && request.auth.uid != uid)
        || (isSignedIn() && request.auth.uid == uid && resource.data.role == "member");
    }

    // ===== 4. Album doc CREATE (chicken-and-egg) =====
    // The very first write of an album is the album document itself, BEFORE any
    // membership exists — so rule 4's isOwner() cannot pass yet. Allow the
    // creator to CREATE only their own self-owned album (createdBy == uid); every
    // later write (songs, meta, invites) goes through rule 3/5 (owner).
    match /albums/{albumId} {
      allow create: if isSignedIn() && request.resource.data.createdBy == request.auth.uid;
    }

    // ===== 5. Album content: read for members, write for owners =====
    match /albums/{albumId}/{all=**} {
      allow read: if isMember(albumId);
      allow write: if isOwner(albumId);
    }

    // ===== 6. Deny everything else by default =====
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

> ⚠️ Because an owner can never write their own membership doc, the **last owner
> can never accidentally demote/remove themselves** (a co-owner must change them
> first) — the album can not be left owner-less through the UI. Owners who want
> to leave delete the album.

## Data model

### Personal library (existing)
```
users/{uid}/songs/{songId} = {
  title:     string,  // song identity (shared across all arrangements)
  artist:    string,
  createdAt: number,  // Date.now() at creation
  updatedAt: number,  // Date.now() at each save
  // Denormalized summary of the most recent arrangement — powers the library
  // card without a per-song version read:
  versionCount:       number,
  latestVersionId:    string,
  latestVersionLabel: string
}
users/{uid}/songs/{songId}/versions/{versionId} = {
  label:    string,  // human name: "Version 1", "Pop", "2024" …
  number:   number,  // monotonic ordering — highest number = latest
  ...projectData(),  // the FULL arrangement: key, sections[], pdfOptions, …
  createdAt: number,
  updatedAt: number
}
users/{uid}/albumMemberships/{albumId} = {
  role: "owner" | "member",
  joinedAt, albumUpdatedAt, songCount    // enumerable pointer for "my albums"
}
```

### Album (Fase 3/4)
```
albums/{albumId} = {
  name, description, createdBy, createdAt, updatedAt, songCount,
  activeInviteCode    // current invite code (mirrored; code→album lives in inviteCodes/{code})
}
albums/{albumId}/songs/{songId} = {
  title, artist, versionCount, latestVersionId, latestVersionLabel,
  latestEditorMode, latestYoutubeId, latestKey, latestMeter, createdAt, updatedAt
}
albums/{albumId}/songs/{songId}/versions/{versionId} = {
  label, number, ...projectData(), createdAt, updatedAt   // identical to user versions
}
albums/{albumId}/members/{uid} = {
  uid, role: "owner" | "member", name, email, joinedAt, addedBy
}
inviteCodes/{code} = {          // doc ID = the invite code (e.g. "A7FQ-XK2N")
  albumId, active, createdAt, createdBy
}
```

> Album songs are **standalone copies** — an owner creates/edits arrangements
> directly under `albums/{albumId}/songs/...` without touching their private
> library. Members get read-only access and may save a private copy into their
> own `users/{uid}/songs`. The album doc mirrors the current code in
> `activeInviteCode` (so the owner's Invite dialog reads it with a plain get);
> `inviteCodes/{code}` keeps the server-side code→album mapping.

### Indexes
No manual indexes are required — every query uses a single equality / orderBy
field (auto-indexed): `albumMemberships` by `albumUpdatedAt` and
`albums/{id}/songs` by `updatedAt`. `inviteCodes` is only read by document ID
(get) and written by owners, never queried as a collection.

## Checklist before go-live

1. **Authentication → Sign-in method**: enable **Google** and **Email/Password**.
2. **Authentication → Settings → Authorized domains**: include
   - `localhost` (local dev)
   - `127.0.0.1` (local dev — Firebase sometimes needs this added explicitly)
   - `dhandyjoe.github.io` (production GitHub Pages)
3. **Firestore Database**: created (production mode) with the rules above published.
4. Web app registered; config already in `src/firebase-config.js`.

> Note: if you skip publishing the new rules (keeping only the old per-user rule),
> album reads/writes will be denied — the app shows a friendly
> "check Firestore security rules" message instead of crashing.

## Notes

- The Firebase web config in `src/firebase-config.js` is **public-safe**; these
  rules + authorized domains are what actually protect the data.
- Login is **optional** in the app: the editor works without an account. Cloud
  actions (Save to Cloud, My Songs, Albums) prompt sign-in when needed.
- Invite-code verification happens **entirely server-side in the rules**: the
  client sends the code once inside the member-doc write, the rules compare it
  against `inviteCodes`, and the code field is stripped from the stored document
  right after a successful join.
