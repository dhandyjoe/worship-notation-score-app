// clipboard.js — in-memory clipboard for copy/paste of sections and bars.
// Single-slot clipboard (holds the most recent copy). No DOM, no persistence:
// the clipboard is intentionally cleared when the tab closes, matching the
// app's in-memory document model.

let entry = null; // { kind: "section" | "bar", payload, meta }

// Store a copied item. `kind` is "section" or "bar"; payload is a deep-clonable
// snapshot produced by the caller (already cloned upstream).
export function setClipboard(kind, payload, meta = {}) {
   entry = { kind, payload: JSON.parse(JSON.stringify(payload)), meta };
}

export function getClipboard() {
   return entry;
}

export function hasClipboard(kind) {
   if (!entry) return false;
   return kind ? entry.kind === kind : true;
}

export function clearClipboard() {
   entry = null;
}
