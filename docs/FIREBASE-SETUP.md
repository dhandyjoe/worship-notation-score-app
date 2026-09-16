# Firestore Security Rules — WorshipNotationScore cloud sync

Paste these rules in the Firebase Console → **Firestore Database → Rules → Publish**.

They enforce that a signed-in user can only read/write documents under their own
`users/{uid}` node — nobody can see or touch another user's songs.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // A user's private song library. The recursive wildcard also covers the
    // versions subcollection (users/{uid}/songs/{songId}/versions/{versionId}).
    // Only the owner (matching auth uid) may access.
    match /users/{uid}/{all=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    // Deny everything else by default.
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

## Data model

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
```

> One song can hold many arrangements (versions), each with its own partiture
> (`sections[]`, key, PDF options, …). Opening a song loads the arrangement with
> the highest `number`. Legacy flat documents — written before this model, where
> the whole project lived in the song doc — are upgraded lazily on read/write:
> the arrangement moves to `versions/v1` and the song doc is reduced to metadata.

## Checklist before go-live

1. **Authentication → Sign-in method**: enable **Google** and **Email/Password**.
2. **Authentication → Settings → Authorized domains**: include
   - `localhost` (local dev)
   - `127.0.0.1` (local dev — Firebase sometimes needs this added explicitly)
   - `dhandyjoe.github.io` (production GitHub Pages)
3. **Firestore Database**: created (production mode) with the rules above published.
4. Web app registered; config already in `src/firebase-config.js`.

## Notes

- The Firebase web config in `src/firebase-config.js` is **public-safe**; these
  rules + authorized domains are what actually protect the data.
- Login is **optional** in the app: the editor works without an account. Cloud
  actions (Save to Cloud, My Songs) prompt sign-in when needed.
