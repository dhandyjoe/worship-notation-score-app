// chordEditor.js — floating "type → pick a suggestion" chord input popover.
// UI-only module: it owns a single popover element and the keyboard/mouse
// interaction, but delegates *what to do* with a chosen value to the caller via
// callbacks (onCommit / advanceTo). This keeps the module free of app state and
// preserves the acyclic dependency graph (events.js drives state + rendering).
//
// Behaviour (agreed 2026-08-07):
//  - The typed text is only a search query; the user MUST pick a suggestion.
//  - Enter commits the highlighted suggestion; ↑/↓ move the highlight.
//  - Tab commits then advances to the next beat (Shift+Tab → previous).
//  - Esc / outside-click / scroll closes without committing.
//  - No match → inline "Unknown chord" message (Option B). No raw commit.
import { suggestChords } from "./chordBank.js?v=20260904-marginnarrow0";
import { chordLabel } from "./render.js?v=20260904-marginnarrow0";

let popover = null; // the root .chord-popover element (created lazily)
let inputEl = null;
let listEl = null;
let msgEl = null;
let activeIndex = -1;
let suggestions = [];
let ctx = null; // { anchor, onCommit, advanceTo }
let outsideHandlersBound = false;
let openedAt = 0; // timestamp of the last open (mobile keyboard grace window)

const MAX_SUGGESTIONS = 10;

export function isChordEditorOpen() {
   return !!popover && !popover.hidden;
}

function ensurePopover() {
   if (popover) return;
   popover = document.createElement("div");
   popover.className = "chord-popover";
   popover.hidden = true;
   popover.setAttribute("role", "dialog");
   popover.setAttribute("aria-label", "Enter chord");
   popover.innerHTML = `
      <div class="chord-popover-field">
         <input class="chord-popover-input" type="text" autocomplete="off" autocapitalize="off"
                spellcheck="false" aria-label="Chord" aria-autocomplete="list"
                placeholder="Type a chord…" />
      </div>
      <ul class="chord-popover-list" role="listbox"></ul>
      <p class="chord-popover-msg" hidden></p>`;
   document.body.appendChild(popover);
   inputEl = popover.querySelector(".chord-popover-input");
   listEl = popover.querySelector(".chord-popover-list");
   msgEl = popover.querySelector(".chord-popover-msg");

   inputEl.addEventListener("input", () => refreshSuggestions());
   inputEl.addEventListener("keydown", onKeydown);
   // Clicking a suggestion commits it (mousedown so it beats input blur).
   listEl.addEventListener("mousedown", (event) => {
      const item = event.target.closest(".chord-suggestion");
      if (!item) return;
      event.preventDefault();
      commit(item.dataset.value);
   });
   listEl.addEventListener("mousemove", (event) => {
      const item = event.target.closest(".chord-suggestion");
      if (!item) return;
      setActive(Number(item.dataset.index));
   });
}

function bindOutsideHandlers() {
   if (outsideHandlersBound) return;
   outsideHandlersBound = true;
   document.addEventListener("pointerdown", onOutsidePointer, true);
   // On touch devices, focusing the input opens the virtual keyboard, which
   // fires resize (and often scroll) events. Closing on those would dismiss the
   // editor before the user can type. So: reposition on resize (keeps the
   // popover anchored as the viewport shrinks) rather than close, and ignore the
   // scroll/resize burst that happens right after opening (see openedAt grace).
   window.addEventListener("resize", onOutsideResize, true);
   // Any scroll of the page/preview detaches the anchor → close. But scrolling
   // *inside* the popover's own suggestion list must NOT close it (capture=true
   // means this fires for inner scrolls too), so ignore those.
   window.addEventListener("scroll", onOutsideScroll, true);
}
function unbindOutsideHandlers() {
   if (!outsideHandlersBound) return;
   outsideHandlersBound = false;
   document.removeEventListener("pointerdown", onOutsidePointer, true);
   window.removeEventListener("resize", onOutsideResize, true);
   window.removeEventListener("scroll", onOutsideScroll, true);
}
// Grace window (ms) after opening during which keyboard-induced scroll/resize
// events are ignored, so the mobile virtual keyboard can't dismiss the editor.
const OPEN_GRACE_MS = 600;
function onOutsideResize() {
   if (!isChordEditorOpen()) return;
   // Never close on resize — the mobile keyboard triggers it. Just re-anchor.
   position();
}
function onOutsideScroll(event) {
   if (!isChordEditorOpen()) return;
   // Scrolling within the popover (the suggestion list) is expected — keep open.
   if (popover.contains(event.target)) return;
   // Ignore the scroll burst the virtual keyboard causes right after opening.
   if (Date.now() - openedAt < OPEN_GRACE_MS) {
      position();
      return;
   }
   closeChordEditor();
}
function onOutsidePointer(event) {
   if (!isChordEditorOpen()) return;
   if (popover.contains(event.target) || event.target === ctx?.anchor || ctx?.anchor?.contains(event.target)) return;
   closeChordEditor();
}

function refreshSuggestions() {
   const query = inputEl.value;
   const opts = { limit: MAX_SUGGESTIONS };
   // ctx.mode ("chords" | "numbers") locks the suggestion type to the song's
   // editing mode; when absent we fall back to auto-detect (legacy behavior).
   if (ctx?.mode === "chords" || ctx?.mode === "numbers") opts.mode = ctx.mode;
   suggestions = suggestChords(query, opts);
   renderList();
}

function renderList() {
   const query = inputEl.value.trim();
   listEl.innerHTML = suggestions
      .map(
         (value, index) =>
            `<li class="chord-suggestion" role="option" data-value="${encodeURIComponent(value)}" data-index="${index}">` +
            `<span class="chord-suggestion-label">${chordLabel(value)}</span></li>`,
      )
      .join("");
   // decode the value attribute back (we encoded to survive quotes/unicode)
   listEl.querySelectorAll(".chord-suggestion").forEach((li) => {
      li.dataset.value = decodeURIComponent(li.dataset.value);
   });
   const empty = suggestions.length === 0;
   const showNoMatch = empty && query.length > 0;
   listEl.hidden = empty;
   msgEl.hidden = !showNoMatch;
   if (showNoMatch) msgEl.textContent = "Unknown chord";
   setActive(empty ? -1 : 0);
}

function setActive(index) {
   activeIndex = index;
   const items = listEl.querySelectorAll(".chord-suggestion");
   items.forEach((li, i) => {
      const on = i === index;
      li.classList.toggle("is-active", on);
      li.setAttribute("aria-selected", on ? "true" : "false");
      if (on) li.scrollIntoView({ block: "nearest" });
   });
}

function onKeydown(event) {
   switch (event.key) {
      case "ArrowDown":
         event.preventDefault();
         if (suggestions.length) setActive((activeIndex + 1) % suggestions.length);
         break;
      case "ArrowUp":
         event.preventDefault();
         if (suggestions.length) setActive((activeIndex - 1 + suggestions.length) % suggestions.length);
         break;
      case "Enter":
         event.preventDefault();
         if (activeIndex >= 0 && suggestions[activeIndex]) commit(suggestions[activeIndex]);
         break;
      case "Tab":
         event.preventDefault();
         if (activeIndex >= 0 && suggestions[activeIndex])
            commit(suggestions[activeIndex], { advance: event.shiftKey ? -1 : 1 });
         else advance(event.shiftKey ? -1 : 1);
         break;
      case "Escape":
         event.preventDefault();
         closeChordEditor();
         break;
   }
}

function commit(value, { advance: dir = 0 } = {}) {
   if (value == null) return;
   ctx?.onCommit?.(value);
   if (dir !== 0) advance(dir);
   else closeChordEditor();
}

function advance(dir) {
   const nextAnchor = ctx?.advanceTo?.(ctx.anchor, dir);
   if (nextAnchor) {
      // Reopen on the next beat; reuse its stored chord as the initial query.
      const reopen = ctx.reopen;
      closeChordEditor();
      reopen?.(nextAnchor, dir);
   } else {
      closeChordEditor();
   }
}

function position() {
   const rect = ctx.anchor.getBoundingClientRect();
   // Measure after making it visible.
   popover.style.visibility = "hidden";
   popover.hidden = false;
   const pw = popover.offsetWidth;
   const ph = popover.offsetHeight;
   const gap = 8;
   const vw = window.innerWidth;
   const vh = window.innerHeight;
   // Horizontally center on the beat, clamped to the viewport with 8px inset.
   let left = rect.left + rect.width / 2 - pw / 2;
   left = Math.max(8, Math.min(left, vw - pw - 8));
   // Prefer above the beat; fall back to below if not enough room.
   let top = rect.top - ph - gap;
   popover.classList.remove("is-below");
   if (top < 8) {
      top = rect.bottom + gap;
      popover.classList.add("is-below");
      if (top + ph > vh - 8) top = Math.max(8, vh - ph - 8);
   }
   popover.style.left = `${Math.round(left)}px`;
   popover.style.top = `${Math.round(top)}px`;
   // Arrow points at the beat center, clamped within the popover width.
   const arrowX = Math.max(14, Math.min(rect.left + rect.width / 2 - left, pw - 14));
   popover.style.setProperty("--arrow-x", `${Math.round(arrowX)}px`);
   popover.style.visibility = "";
}

/**
 * Open the chord editor anchored to a beat element.
 * @param {object} opts
 * @param {HTMLElement} opts.anchor - the beat/sub-beat element to anchor to.
 * @param {string} [opts.initialValue] - existing chord to prefill as the query.
 * @param {(value:string)=>void} opts.onCommit - called with the chosen value.
 * @param {(anchor:HTMLElement, dir:number)=>HTMLElement|null} [opts.advanceTo]
 *        - resolves the next/previous beat element for Tab navigation.
 * @param {(anchor:HTMLElement, dir:number)=>void} [opts.reopen]
 *        - reopens the editor on a new anchor (used by Tab navigation).
 */
export function openChordEditor(opts) {
   ensurePopover();
   ctx = opts;
   openedAt = Date.now();
   ctx.anchor.classList.add("chord-editing");
   inputEl.value = opts.initialValue || "";
   refreshSuggestions();
   position();
   bindOutsideHandlers();
   inputEl.focus();
   inputEl.select();
}

export function closeChordEditor() {
   if (!popover || popover.hidden) return;
   popover.hidden = true;
   unbindOutsideHandlers();
   ctx?.anchor?.classList.remove("chord-editing");
   ctx = null;
   activeIndex = -1;
   suggestions = [];
}
