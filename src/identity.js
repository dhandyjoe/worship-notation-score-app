// identity.js — pure display-identity helpers. No DOM, no Firebase: safe to unit
// test in Node (see tests/unit.test.mjs).
//
// Why this exists: Google sign-in fills Auth.displayName, but email/password
// sign-up does NOT — so an account created that way has no name at all and the
// member list used to show a generic "Musician". Deriving a readable name from
// the email's local part fixes the list without touching Auth, Firestore or the
// security rules.

const MAX_NAME_LENGTH = 28;
const MAX_NAME_WORDS = 3;

/**
 * Friendly display name for an account that doesn't have one.
 *
 * Order: explicit `displayName` / `name` → derived from the email local part
 * ("dhandy.joe@gmail.com" → "Dhandy Joe") → "" so the caller keeps its own
 * fallback ("Musician" in the member list, the email in the account menu).
 *
 * Returns "" when the local part is not name-like (few letters, or mostly
 * digits such as "x7k2p9") — an id is not a name.
 *
 * @param {{displayName?:string, name?:string, email?:string}} source
 *        Auth user (`{ displayName, email }`) or a member row (`{ name, email }`).
 * @returns {string}
 */
export function friendlyName(source = {}) {
   const explicit = String(source.displayName || source.name || "").trim();
   if (explicit) return explicit;
   const local = String(source.email || "")
      .split("@")[0]
      .trim();
   if (!local) return "";
   const letters = local.replace(/[^a-z]/gi, "");
   // Too few letters, or mostly digits → an id, not a name.
   if (letters.length < 3 || letters.length / local.length < 0.6) return "";
   return local
      .split(/[._+\-]+/)
      .map((part) => part.replace(/[0-9]+/g, ""))
      .filter(Boolean)
      .slice(0, MAX_NAME_WORDS)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ")
      .slice(0, MAX_NAME_LENGTH);
}
