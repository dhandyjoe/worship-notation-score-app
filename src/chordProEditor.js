// chordProEditor.js — UI wiring for the ChordPro workspace (editor left, preview right).
//
// UI-only module: it never imports events.js. Everything it needs from the app is
// injected through initChordProEditor() — the same injected-hooks pattern used by
// render.js and cloudUI.js — which keeps the module graph acyclic:
//   chordProEditor → { chordPro, notation, dom, store }
//
// Interaction model
//  • The LEFT panel owns the raw ChordPro text (one textarea per section) plus the
//    song metadata and transpose. There is deliberately NO chord palette and no
//    drag & drop here: chords are typed inline as `[C]` — that is the whole point
//    of this mode for beginners.
//  • The RIGHT panel is rendered by render.js (renderPreview → #cpSectionsPreview),
//    so the preview is always a pure function of the stored text.
//  • Typing updates the section text immediately (live preview) and commits through a
//    debounced save(), so one typing burst is ONE undo step instead of one per key.
//  • The panel is rebuilt ONLY when the section structure changes (add/remove/rename/
//    reorder or a freshly loaded project); otherwise it just re-syncs values. That is
//    what keeps the caret and focus alive while typing.
import { $ } from "./dom.js?v=20260925-chordpro6";
import { getState } from "./store.js?v=20260925-chordpro6";
import { keys, escapeHTML, newSection, MAX_SECTIONS, normalizeEditorMode } from "./notation.js?v=20260925-chordpro6";

// Injected app hooks (set once at bootstrap by events.js).
const deps = {
   save() {},
   renderPreview() {},
   onTranspose() {},
   onUndo() {},
   onRedo() {},
   canUndo: () => false,
   canRedo: () => false,
   isReadOnly: () => false,
   toast: () => {},
};

export function initChordProEditor(overrides = {}) {
   Object.assign(deps, overrides);
   bindOnce();
   syncChordProWorkspace();
}

let bound = false;
let saveTimer = null;
// What the panel currently shows. It is rebuilt only when this signature changes, so
// re-rendering the preview can never steal focus from a textarea.
let renderedSignature = "";

const textareaFor = (sectionId) => $(`#cpSections .cp-textarea[data-section="${sectionId}"]`);
const rowFor = (sectionId) => $(`#cpSections .cp-section-row[data-section="${sectionId}"]`);
const sectionOf = (element) => {
   const id = element?.dataset?.section;
   return id ? getState().sections.find((section) => section.id === id) : null;
};

// ---- Saving (debounced so a typing burst is ONE undo step) ----
function flushSave() {
   clearTimeout(saveTimer);
   saveTimer = null;
   deps.save();
}
function scheduleSave() {
   clearTimeout(saveTimer);
   saveTimer = setTimeout(() => {
      saveTimer = null;
      deps.save();
   }, 600);
}
/** Structural change: commit immediately so add/delete/move is undoable right away. */
function commitStructure() {
   clearTimeout(saveTimer);
   saveTimer = null;
   deps.renderPreview();
   deps.save();
}

function autoGrow(textarea) {
   textarea.style.height = "auto";
   textarea.style.height = `${Math.max(124, textarea.scrollHeight + 2)}px`;
}

function signatureOf(sections) {
   // IDS ONLY: renaming a section must not rebuild the panel (that would steal
   // focus from the name field mid-typing). Names are re-synced by syncValues().
   return sections.map((section) => section.id).join("\u0000");
}

// ---- Syncing the workspace with the document ----
/**
 * Sync the whole workspace with the current state. Called after every
 * renderPreview() (through the render hook) and once at bootstrap, so the panel
 * always reflects the document — including imports, undo/redo and cloud loads.
 */
export function syncChordProWorkspace() {
   const host = $("#cpSections");
   if (!host) return;
   const state = getState();
   if (normalizeEditorMode(state.editorMode) !== "chordpro") return;
   const readOnly = deps.isReadOnly();
   syncMeta(state, readOnly);
   syncHistoryButtons();
   const signature = signatureOf(state.sections);
   if (signature !== renderedSignature) {
      host.innerHTML = state.sections
         .map((section, index) => sectionRowHTML(section, index, state.sections.length, readOnly))
         .join("");
      renderedSignature = signature;
      host.querySelectorAll(".cp-textarea").forEach(autoGrow);
   } else {
      syncValues(state);
   }
   applyReadOnly(readOnly);
}

function syncValues(state) {
   state.sections.forEach((section) => {
      const textarea = textareaFor(section.id);
      if (textarea && textarea !== document.activeElement && textarea.value !== (section.chordPro || "")) {
         textarea.value = section.chordPro || "";
         autoGrow(textarea);
      }
      const nameInput = rowFor(section.id)?.querySelector(".cp-section-name-input");
      if (nameInput && nameInput !== document.activeElement && nameInput.value !== section.name) {
         nameInput.value = section.name;
      }
   });
}

function applyReadOnly(readOnly) {
   $("#cpSections")
      ?.querySelectorAll(".cp-textarea, .cp-section-name-input")
      .forEach((field) => {
         field.readOnly = readOnly;
      });
   const addBtn = $("#cpAddSection");
   if (addBtn) addBtn.disabled = readOnly;
}

function syncMeta(state, readOnly) {
   const keySelect = $("#cpKeySelect");
   if (keySelect) {
      if (!keySelect.options.length) keySelect.innerHTML = keys.map((key) => `<option value="${key}">${key}</option>`).join("");
      if (keySelect.value !== state.key) keySelect.value = state.key;
   }
   const meterSelect = $("#cpMeterSelect");
   if (meterSelect && meterSelect.value !== state.meter) meterSelect.value = state.meter;
   const title = $("#cpTitleInput");
   if (title && title !== document.activeElement) title.value = $("#songTitle")?.value || "";
   const artist = $("#cpArtistInput");
   if (artist && artist !== document.activeElement) artist.value = $("#artist")?.value || "";
   if (title) title.readOnly = readOnly;
   if (artist) artist.readOnly = readOnly;
   // The preview card mirrors the document metadata (the grid modes get this from
   // renderPreview's header pass, which ChordPro does not use).
   const previewTitle = $("#cpPreviewTitle");
   if (previewTitle) previewTitle.textContent = $("#songTitle")?.value || "Song Title";
   const previewArtist = $("#cpPreviewArtist");
   if (previewArtist) previewArtist.textContent = $("#artist")?.value || "Artist / Composer";
   const previewKey = $("#cpPreviewKey");
   if (previewKey) previewKey.textContent = state.key;
   const previewMeter = $("#cpPreviewMeter");
   if (previewMeter) previewMeter.textContent = state.meter;
}

function syncHistoryButtons() {
   const undoBtn = $("#cpUndoBtn");
   if (undoBtn) undoBtn.disabled = !deps.canUndo();
   const redoBtn = $("#cpRedoBtn");
   if (redoBtn) redoBtn.disabled = !deps.canRedo();
}

// ---- Section rows ----
function sectionRowHTML(section, index, total, readOnly) {
   const name = escapeHTML(section.name || "Section");
   const guard = readOnly ? "readonly" : "";
   return `<div class="cp-section-row" data-section="${section.id}">
   <div class="cp-section-row-head">
      <input class="cp-section-name-input" type="text" value="${name}" data-section="${section.id}" aria-label="Section name" ${guard} />
      <div class="cp-section-row-tools">
         <button class="cp-row-btn" type="button" data-cp-move="-1" data-section="${section.id}" title="Move up" aria-label="Move ${name} up" ${index === 0 || readOnly ? "disabled" : ""}>↑</button>
         <button class="cp-row-btn" type="button" data-cp-move="1" data-section="${section.id}" title="Move down" aria-label="Move ${name} down" ${index === total - 1 || readOnly ? "disabled" : ""}>↓</button>
         <button class="cp-row-btn is-danger" type="button" data-cp-delete="" data-section="${section.id}" title="Delete section" aria-label="Delete ${name}" ${total <= 1 || readOnly ? "disabled" : ""}>✕</button>
      </div>
   </div>
   <textarea class="cp-textarea" data-section="${section.id}" rows="6" spellcheck="false" placeholder="[C]Type a lyric line…" aria-label="ChordPro text for ${name}" ${guard}>${escapeHTML(section.chordPro || "")}</textarea>
</div>`;
}

// ---- Event wiring (once) ----
function bindOnce() {
   if (bound) return;
   bound = true;
   const host = $("#cpSections");
   host?.addEventListener("input", onSectionInput);
   host?.addEventListener("focusout", onSectionFocusOut);
   host?.addEventListener("click", onSectionClick);
   $("#cpAddSection")?.addEventListener("click", addSection);
   // Transpose stays available to album members too (album role rules).
   $("#cpTransposeDown")?.addEventListener("click", () => deps.onTranspose(-1));
   $("#cpTransposeUp")?.addEventListener("click", () => deps.onTranspose(1));
   $("#cpUndoBtn")?.addEventListener("click", () => deps.onUndo());
   $("#cpRedoBtn")?.addEventListener("click", () => deps.onRedo());
   $("#cpTitleInput")?.addEventListener("input", (event) => pushMeta("#songTitle", event.target.value));
   $("#cpArtistInput")?.addEventListener("input", (event) => pushMeta("#artist", event.target.value));
   $("#cpKeySelect")?.addEventListener("change", onKeyChange);
   $("#cpMeterSelect")?.addEventListener("change", onMeterChange);
}

/**
 * Write a metadata value into the hidden metadata store and let the EXISTING
 * handlers do the rest (renderPreview + save + member read-only guard), so the
 * ChordPro panel can never drift from the grid modes' behaviour.
 */
function pushMeta(storeSelector, value) {
   const store = $(storeSelector);
   if (!store) return;
   store.value = value;
   store.dispatchEvent(new Event("input", { bubbles: true }));
}

function onKeyChange(event) {
   const state = getState();
   state.key = event.target.value;
   const store = $("#keySelect");
   if (store) store.value = state.key;
   deps.renderPreview();
   flushSave();
   deps.toast(`Key set to ${state.key}`);
}

function onMeterChange(event) {
   const state = getState();
   state.meter = event.target.value;
   const store = $("#timeSignature");
   if (store) store.value = state.meter;
   deps.renderPreview();
   flushSave();
   deps.toast(`Time signature set to ${state.meter}`);
}

function onSectionInput(event) {
   const field = event.target;
   const section = sectionOf(field);
   if (!section || deps.isReadOnly()) return;
   if (field.classList.contains("cp-textarea")) {
      section.chordPro = field.value;
      autoGrow(field);
   } else if (field.classList.contains("cp-section-name-input")) {
      section.name = field.value;
   } else {
      return;
   }
   deps.renderPreview();
   scheduleSave();
}

function onSectionFocusOut(event) {
   const field = event.target;
   const isText = field.classList?.contains("cp-textarea");
   const isName = field.classList?.contains("cp-section-name-input");
   if (!isText && !isName) return;
   if (isName) {
      field.value = field.value.trim() || "Section";
      const section = sectionOf(field);
      if (section) section.name = field.value;
      deps.renderPreview();
   }
   // One typing burst = one undo step: commit when the field loses focus.
   flushSave();
}

function onSectionClick(event) {
   const button = event.target.closest("[data-cp-move], [data-cp-delete]");
   if (!button || deps.isReadOnly()) return;
   const state = getState();
   const index = state.sections.findIndex((section) => section.id === button.dataset.section);
   if (index === -1) return;
   const section = state.sections[index];
   if (button.dataset.cpDelete !== undefined) {
      if (state.sections.length <= 1) {
         deps.toast("At least one section must remain");
         return;
      }
      if ((section.chordPro || "").trim() && !window.confirm(`Section “${section.name}” contains lyrics. Delete this section?`)) {
         return;
      }
      state.sections.splice(index, 1);
      state.activeId = state.sections[Math.min(index, state.sections.length - 1)].id;
      commitStructure();
      deps.toast(`Section “${section.name}” deleted`);
      return;
   }
   const delta = Number(button.dataset.cpMove);
   const target = index + delta;
   if (!delta || target < 0 || target >= state.sections.length) return;
   const [moved] = state.sections.splice(index, 1);
   state.sections.splice(target, 0, moved);
   commitStructure();
}

function addSection() {
   if (deps.isReadOnly()) return;
   const state = getState();
   if (state.sections.length >= MAX_SECTIONS) {
      deps.toast(`A song can hold at most ${MAX_SECTIONS} sections`);
      return;
   }
   // newSection() also seeds the (unused here) beat fields, keeping the section
   // shape identical to the grid modes so imports/exports stay uniform.
   const section = newSection(`Section ${state.sections.length + 1}`);
   section.chordPro = "";
   state.sections.push(section);
   state.activeId = section.id;
   commitStructure();
   const textarea = textareaFor(section.id);
   textarea?.focus();
   textarea?.scrollIntoView({ block: "nearest" });
   deps.toast(`Section “${section.name}” added`);
}
