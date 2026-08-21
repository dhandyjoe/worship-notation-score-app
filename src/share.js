// share.js — encode/decode a song project into a compact, URL-safe string so it
// can be shared between users as a link. No DOM, no network: this module only
// transforms data, which keeps it unit-testable and independent of the app.
//
// Design (Phase 2, Option A — data-in-URL, no server/Firestore changes):
//   - The song JSON is compressed with the native gzip CompressionStream when
//     available, then base64url-encoded so it survives inside a URL fragment.
//   - A short magic + scheme header lets the decoder know how to reverse it and
//     rejects strings that aren't ours.
//   - If CompressionStream is unavailable (older browsers), we fall back to a
//     plain (uncompressed) base64url payload. Links are longer but still work.
//   - The payload is meant to live in the URL *fragment* (after `#`) so it is
//     never sent to any server.

// One-character magic marker + scheme code prefixed to every payload.
//   "w" = our marker (WorshipNotationScore)
//   scheme: "g" = gzip-compressed, "p" = plain (uncompressed)
const MAGIC = "w";
const SCHEME_GZIP = "g";
const SCHEME_PLAIN = "p";

// Route used for import links, e.g. https://host/app/#/import?d=<payload>
export const IMPORT_ROUTE = "#/import";

// ---------------------------------------------------------------------------
// base64url helpers (cross-platform: browser + Node both expose btoa/atob).
// ---------------------------------------------------------------------------

function bytesToBase64url(bytes) {
   let binary = "";
   const chunk = 0x8000; // avoid stack overflow on String.fromCharCode(...spread)
   for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
   }
   return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(str) {
   const normalized = str.replace(/-/g, "+").replace(/_/g, "/");
   const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
   const binary = atob(padded);
   const bytes = new Uint8Array(binary.length);
   for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
   return bytes;
}

// ---------------------------------------------------------------------------
// gzip helpers (native CompressionStream / DecompressionStream + Response).
// ---------------------------------------------------------------------------

export function canCompress() {
   return typeof CompressionStream !== "undefined" && typeof Response !== "undefined";
}

async function gzip(bytes) {
   const cs = new CompressionStream("gzip");
   const writer = cs.writable.getWriter();
   writer.write(bytes);
   writer.close();
   const buffer = await new Response(cs.readable).arrayBuffer();
   return new Uint8Array(buffer);
}

async function gunzip(bytes) {
   const ds = new DecompressionStream("gzip");
   const writer = ds.writable.getWriter();
   writer.write(bytes);
   writer.close();
   const buffer = await new Response(ds.readable).arrayBuffer();
   return new Uint8Array(buffer);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Encode a project object into a URL-safe payload string (magic + scheme + data).
// Uses gzip when available, otherwise falls back to plain base64url.
export async function encodeShare(project) {
   const json = JSON.stringify(project);
   const bytes = new TextEncoder().encode(json);
   if (canCompress()) {
      try {
         const compressed = await gzip(bytes);
         return MAGIC + SCHEME_GZIP + bytesToBase64url(compressed);
      } catch {
         // Fall through to plain encoding if compression fails for any reason.
      }
   }
   return MAGIC + SCHEME_PLAIN + bytesToBase64url(bytes);
}

// Decode a payload string back into the project object. Throws on invalid input.
export async function decodeShare(payload) {
   if (typeof payload !== "string" || payload.length < 3 || payload[0] !== MAGIC) {
      throw new Error("Not a valid share payload");
   }
   const scheme = payload[1];
   const data = payload.slice(2);
   let bytes = base64urlToBytes(data);
   if (scheme === SCHEME_GZIP) {
      bytes = await gunzip(bytes);
   } else if (scheme !== SCHEME_PLAIN) {
      throw new Error("Unknown share scheme");
   }
   const json = new TextDecoder().decode(bytes);
   return JSON.parse(json);
}

// Build a full share link for a project, given the app's base URL (typically
// location.origin + location.pathname). The payload lives in the fragment.
export async function buildShareLink(project, baseUrl) {
   const payload = await encodeShare(project);
   const base = String(baseUrl || "").replace(/#.*$/, "");
   return `${base}${IMPORT_ROUTE}?d=${payload}`;
}

// Extract the `d=` payload from arbitrary pasted text: a full link, just the
// fragment, or the raw payload itself. Returns null if nothing plausible found.
// Robust to chat apps that may wrap or partially mangle the URL.
export function extractPayloadFromLink(text) {
   if (typeof text !== "string") return null;
   const trimmed = text.trim();
   if (!trimmed) return null;
   // 1) Look for an explicit d= parameter anywhere in the string.
   const match = trimmed.match(/[?&]d=([A-Za-z0-9\-_]+)/);
   if (match) return match[1];
   // 2) Maybe the whole thing IS the payload (starts with our magic+scheme).
   const bare = trimmed.replace(/\s+/g, "");
   if (bare[0] === MAGIC && (bare[1] === SCHEME_GZIP || bare[1] === SCHEME_PLAIN)) {
      const clean = bare.match(/^[A-Za-z0-9\-_]+/);
      if (clean) return clean[0];
   }
   return null;
}
