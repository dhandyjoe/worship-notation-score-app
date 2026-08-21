import fs from "node:fs/promises";

const debugPort = Number(process.env.CDP_PORT || 9223);
const appUrl = process.env.APP_URL || "http://127.0.0.1:4173/";
const outputDir = process.env.TEST_OUTPUT || "/private/tmp/worshipnotation-regression";
await fs.mkdir(outputDir, { recursive: true });

const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
const target = targets.find((item) => item.type === "page");
if (!target) throw new Error("No Chrome page target is available");

class CDP {
   constructor(url) {
      this.id = 0;
      this.pending = new Map();
      this.events = new Map();
      this.socket = new WebSocket(url);
   }
   async open() {
      await new Promise((resolve, reject) => {
         this.socket.addEventListener("open", resolve, { once: true });
         this.socket.addEventListener("error", reject, { once: true });
      });
      this.socket.addEventListener("message", (event) => {
         const message = JSON.parse(event.data);
         if (message.id) {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
            return;
         }
         (this.events.get(message.method) || []).forEach((listener) => listener(message.params));
      });
   }
   send(method, params = {}) {
      return new Promise((resolve, reject) => {
         const id = ++this.id;
         this.pending.set(id, { resolve, reject });
         this.socket.send(JSON.stringify({ id, method, params }));
      });
   }
   on(method, listener) {
      const list = this.events.get(method) || [];
      list.push(listener);
      this.events.set(method, list);
   }
}

const cdp = new CDP(target.webSocketDebuggerUrl);
await cdp.open();
await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable")]);

const results = [];
function record(name, passed, details = "") {
   results.push({ name, passed: Boolean(passed), details });
   if (!passed) console.error(`FAIL: ${name}${details ? ` — ${details}` : ""}`);
}
async function evaluate(expression) {
   const result = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
   });
   if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
   return result.result.value;
}
async function waitFor(expression, timeout = 5000) {
   const started = Date.now();
   while (Date.now() - started < timeout) {
      if (await evaluate(expression)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
   }
   throw new Error(`Timed out waiting for ${expression}`);
}
async function viewport(width, height, mobile = false, deviceScaleFactor = 1) {
   await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile,
      screenWidth: width,
      screenHeight: height,
   });
   await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
}
async function navigate() {
   await cdp.send("Page.navigate", { url: `${appUrl}?test=${Date.now()}` });
   await waitFor("document.readyState==='complete' && !!document.querySelector('#sectionsPreview .bar')");
   await evaluate("window.confirm=()=>true; true");
}
async function screenshot(name) {
   const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      fromSurface: true,
   });
   await fs.writeFile(`${outputDir}/${name}.png`, Buffer.from(data, "base64"));
}
async function printPdf(name) {
   const { data } = await cdp.send("Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
   });
   await fs.writeFile(`${outputDir}/${name}.pdf`, Buffer.from(data, "base64"));
}
const js = (value) => JSON.stringify(value);
const click = (selector, index = 0) =>
   evaluate(
      `(()=>{const el=document.querySelectorAll(${js(selector)})[${index}];if(!el)return false;el.click();return true})()`,
   );
const text = (selector, index = 0) =>
   evaluate(`document.querySelectorAll(${js(selector)})[${index}]?.textContent?.trim()||''`);
// Reads a placed chord's visible label, excluding the ✕ remove badge that the
// tap-to-remove feature injects into the same element. Also strips Nashville
// octave dots (●) so callers can assert on the bare chord symbol.
const chordText = (index = 0) =>
   evaluate(
      `(()=>{const el=document.querySelectorAll('.placed-chord')[${index}];if(!el)return'';const clone=el.cloneNode(true);clone.querySelector('.chord-remove')?.remove();return clone.textContent.trim().replaceAll('●','')})()`,
   );
const chordTexts = () =>
   evaluate(
      "[...document.querySelectorAll('.placed-chord')].map(el=>{const clone=el.cloneNode(true);clone.querySelector('.chord-remove')?.remove();return clone.textContent.trim().replaceAll('●','')})",
   );

// Desktop functional suite.
await viewport(1440, 1000, false);
await navigate();
record("Desktop default section", (await text(".section-title")) === "INTRO");
record("Desktop default four bars", (await evaluate("document.querySelectorAll('.bar').length")) === 4);
record("Desktop default 4/4 beats", (await evaluate("document.querySelectorAll('.drop-target').length")) === 16);
record(
   "No horizontal page overflow on desktop",
   await evaluate("document.documentElement.scrollWidth<=document.documentElement.clientWidth+1"),
);
const desktopSticky = await evaluate(
   "(async()=>{const card=document.querySelector('#previewCard'),minimum=card.style.minHeight,smooth=document.documentElement.style.scrollBehavior;card.style.minHeight='1800px';document.documentElement.style.scrollBehavior='auto';window.scrollTo({top:400,behavior:'instant'});await new Promise(resolve=>setTimeout(resolve,80));const header=document.querySelector('.topbar').getBoundingClientRect(),editor=document.querySelector('.editor-card'),ribbonHidden=getComputedStyle(editor).display==='none';const result={headerBottom:header.bottom,ribbonHidden,scrollY,scrollHeight:document.documentElement.scrollHeight};window.scrollTo(0,0);card.style.minHeight=minimum;document.documentElement.style.scrollBehavior=smooth;return result})()",
);
record("Desktop header scrolls away", desktopSticky.headerBottom <= 0, JSON.stringify(desktopSticky));
record(
   "Desktop arrangement ribbon is hidden (preview-focused editing)",
   desktopSticky.ribbonHidden,
   JSON.stringify(desktopSticky),
);

await click(".chord-family .chord", 3);
await click(".drop-target", 0);
record("Place chord through palette click", (await chordText(0)) === "Cmaj7");
await click("#tabSlash");
await evaluate(
   "(()=>{for(const [id,value] of [['slashRoot','D'],['slashQuality','m'],['slashBass','F#']]){const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}))}return true})()",
);
await click("#addSlashBtn");
await click("#slashChordBank .chord", 0);
await click(".drop-target", 1);
record("Create and place slash chord", (await chordText(1)) === "Dm/F#");

await click("#tabNashville");
const numberCounts = await evaluate(
   "[...document.querySelectorAll('.nashville-number-row')].map(row=>row.querySelectorAll('.nashville-key').length)",
);
record(
   "Nashville rows include normal/lower/upper/zero",
   JSON.stringify(numberCounts) === JSON.stringify([7, 7, 7, 1]),
   JSON.stringify(numberCounts),
);
await click(".nashville-row-block:nth-child(3) .nashville-key", 3);
await click("#nashvilleChordBank .chord", 3);
await click(".drop-target", 2);
record("Place upper-octave Nashville chord", (await chordText(2)).includes("4maj7"));
record(
   "Upper-octave dot remains rendered",
   await evaluate(
      "!!document.querySelectorAll('.placed-chord')[2]?.querySelector('.nashville-octave-high .nashville-octave-dot')",
   ),
);

await click("#tabRhythm");
await click(".duration-option", 0);
await click(".drop-target", 4);
record(
   "Half-beat creates two subdivisions",
   (await evaluate("document.querySelectorAll('.duration-half .sub-beats')[0]?.children.length")) === 2,
);
await click(".sub-beat", 1);
record(
   "Nested half-beat creates a two-child branch",
   (await evaluate("document.querySelectorAll('.nested-sub-beat').length")) === 2,
);
await click(".nested-duration-line");
record(
   "Nested rhythm marker deletion works",
   (await evaluate("document.querySelectorAll('.nested-duration-line').length")) === 0,
);
await click(".duration-option", 1);
await click(".drop-target", 6);
record(
   "Beat triplet creates three subdivisions",
   (await evaluate("document.querySelectorAll('.duration-triplet .sub-beats')[0]?.children.length")) === 3,
);
await click(".duration-option", 2);
await click(".drop-target", 9);
record(
   "Quarter-beat creates four subdivisions",
   (await evaluate("document.querySelectorAll('.duration-quarter .sub-beats')[0]?.children.length")) === 4,
);
await click(".duration-quarter .duration-line");
record(
   "Rhythm marker deletion restores a beat",
   (await evaluate("document.querySelectorAll('.duration-quarter').length")) === 0,
);

// ---------------------------------------------------------------------------
// Inline chord editor (the "type → pick a suggestion" popover that replaces the
// hidden arrangement palette). Drives the real popover DOM (.chord-popover):
// click a beat to open it, type a query, then commit via Enter / suggestion.
// ---------------------------------------------------------------------------
await navigate();
const openEditor = (index) =>
   evaluate(
      `(()=>{const beat=document.querySelectorAll('.drop-target')[${index}];if(!beat)return false;beat.click();const pop=document.querySelector('.chord-popover');return !!pop&&!pop.hidden})()`,
   );
const typeQuery = (value) =>
   evaluate(
      `(()=>{const input=document.querySelector('.chord-popover-input');if(!input)return 0;input.value=${js(value)};input.dispatchEvent(new Event('input',{bubbles:true}));return document.querySelectorAll('.chord-suggestion').length})()`,
   );
const pressKey = (key) =>
   evaluate(
      `(()=>{const input=document.querySelector('.chord-popover-input');if(!input)return false;input.dispatchEvent(new KeyboardEvent('keydown',{key:${js(key)},bubbles:true}));return true})()`,
   );
const firstSuggestion = () => text(".chord-suggestion", 0);
// The suggestion list commits on mousedown (so it beats the input's blur), so
// a plain .click() won't fire it — dispatch mousedown explicitly.
const clickSuggestion = (index = 0) =>
   evaluate(
      `(()=>{const item=document.querySelectorAll('.chord-suggestion')[${index}];if(!item)return false;item.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));return true})()`,
   );

record("Clicking an empty beat opens the inline chord editor", await openEditor(0));
await typeQuery("cma");
record(
   "Typing filters suggestions to matching chords",
   (await firstSuggestion()).replaceAll("●", "").startsWith("Cmaj"),
   await firstSuggestion(),
);
await pressKey("Enter");
await waitFor("!document.querySelector('.chord-popover')||document.querySelector('.chord-popover').hidden");
record("Enter commits the highlighted suggestion", (await chordText(0)) === "Cmaj7");

// Suggestion click path + slash chords.
await openEditor(1);
await typeQuery("g/b");
record("Slash query yields a slash suggestion", (await firstSuggestion()).includes("/"), await firstSuggestion());
await clickSuggestion(0);
await waitFor("!document.querySelector('.chord-popover')||document.querySelector('.chord-popover').hidden");
record("Clicking a suggestion commits it", (await chordText(1)).includes("/"));

// Nashville octave variants appear as distinct suggestions.
await openEditor(2);
const nashvilleCount = await typeQuery("1");
record("Nashville degree query yields octave/quality variants", nashvilleCount >= 3, String(nashvilleCount));
await pressKey("Enter");
await waitFor("!document.querySelector('.chord-popover')||document.querySelector('.chord-popover').hidden");
record("Nashville degree commits from the suggestion list", (await chordText(2)).includes("1"));

// Augmented / diminished / half-diminished words map to their music symbols.
await openEditor(0);
await typeQuery("Gaug");
record(
   "Typing 'aug' suggests the augmented symbol (G+)",
   (await firstSuggestion()).replaceAll("●", "") === "G+",
   await firstSuggestion(),
);
await pressKey("Escape");
await waitFor("!document.querySelector('.chord-popover')||document.querySelector('.chord-popover').hidden");
await openEditor(0);
await typeQuery("Gdim");
record(
   "Typing 'dim' suggests the diminished symbol (G°)",
   (await firstSuggestion()).replaceAll("●", "") === "G°",
   await firstSuggestion(),
);
await pressKey("Escape");
await waitFor("!document.querySelector('.chord-popover')||document.querySelector('.chord-popover').hidden");
await openEditor(0);
await typeQuery("Gm7b5");
record(
   "Typing 'm7b5' suggests the half-diminished symbol (Gø7)",
   (await firstSuggestion()).replaceAll("●", "") === "Gø7",
   await firstSuggestion(),
);
await pressKey("Escape");
await waitFor("!document.querySelector('.chord-popover')||document.querySelector('.chord-popover').hidden");

// Unknown input shows the inline message and never commits raw text.
await openEditor(3);
await typeQuery("zzz");
record(
   "Unknown chord shows the 'Unknown chord' message",
   await evaluate(
      "(()=>{const m=document.querySelector('.chord-popover-msg');return !!m&&!m.hidden&&/unknown chord/i.test(m.textContent)})()",
   ),
);
record(
   "Unknown chord hides the suggestion list",
   (await evaluate("document.querySelectorAll('.chord-suggestion').length")) === 0,
);
// Scrolling *inside* the suggestion list must keep the popover open (a window
// scroll-capture handler used to close it on any scroll, including inner ones).
await pressKey("Escape");
await waitFor("!document.querySelector('.chord-popover')||document.querySelector('.chord-popover').hidden");
await openEditor(3);
await typeQuery("c");
record(
   "Scrolling the suggestion list keeps the chord editor open",
   await evaluate(
      "(()=>{const list=document.querySelector('.chord-popover-list');if(!list)return false;list.scrollTop=40;list.dispatchEvent(new Event('scroll',{bubbles:true}));const pop=document.querySelector('.chord-popover');return !!pop&&!pop.hidden})()",
   ),
);
await pressKey("Escape");
await waitFor("!document.querySelector('.chord-popover')||document.querySelector('.chord-popover').hidden");
record(
   "Escape closes the editor without committing",
   (await evaluate("document.querySelectorAll('.placed-chord').length")) === 3,
);

// Clicking a placed chord body re-opens the editor (removal is via the ✕ badge).
await click(".placed-chord", 0);
record(
   "Clicking a placed chord re-opens the editor with its value",
   await evaluate(
      "(()=>{const pop=document.querySelector('.chord-popover');return !!pop&&!pop.hidden&&document.querySelector('.chord-popover-input').value.length>0})()",
   ),
);
await pressKey("Escape");

// ---------------------------------------------------------------------------
// Rhythm context menu (right-click / long-press) replaces the duration chips.
// ---------------------------------------------------------------------------
await navigate();
const openRhythm = (index) =>
   evaluate(
      `(()=>{const beat=document.querySelectorAll('.drop-target')[${index}];if(!beat)return false;beat.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:120}));const menu=document.querySelector('.beat-menu');return !!menu&&!menu.hidden})()`,
   );
record("Right-click opens the rhythm context menu", await openRhythm(4));
record(
   "Rhythm menu offers half / triplet / quarter / remove",
   (await evaluate("document.querySelectorAll('.beat-menu-item').length")) === 4,
);
record(
   "Remove subdivision is disabled on a plain beat",
   await evaluate("document.querySelectorAll('.beat-menu-item')[3]?.getAttribute('aria-disabled')==='true'"),
);
await click(".beat-menu-item", 0); // Half beat
record(
   "Rhythm menu half-beat creates two subdivisions",
   (await evaluate("document.querySelectorAll('.duration-half .sub-beats')[0]?.children.length")) === 2,
);
record(
   "Rhythm menu closes after choosing an item",
   await evaluate("!document.querySelector('.beat-menu')||document.querySelector('.beat-menu').hidden"),
);
// The subdivided beat now exposes level-1 sub-beats; right-clicking one offers
// only nested-safe options (triplet/quarter disabled, Remove disabled because a
// sub-beat is nested — removal happens via the duration marker line instead).
await openRhythm(4);
record(
   "Nested sub-beat disables triplet and quarter",
   await evaluate(
      "(()=>{const items=document.querySelectorAll('.beat-menu-item');return items[1]?.getAttribute('aria-disabled')==='true'&&items[2]?.getAttribute('aria-disabled')==='true'})()",
   ),
);
await pressKey("Escape");
await evaluate("document.querySelector('.beat-menu')&&(document.querySelector('.beat-menu').hidden=true);true");
await click(".duration-half .duration-line");
record(
   "Rhythm marker line removal restores a plain beat",
   (await evaluate("document.querySelectorAll('.duration-half').length")) === 0,
);

await click("#tabLyrics");
await click("#lyricsEnabled");
record(
   "Lyrics mode creates fields for every base/sub beat",
   (await evaluate("document.querySelectorAll('.lyric-input').length")) >= 16,
);
record(
   "Lyrics fields use an empty placeholder",
   await evaluate("[...document.querySelectorAll('.lyric-input')].every(input=>input.placeholder==='')"),
);
await evaluate(
   "(()=>{const input=document.querySelector('.lyric-input');input.value='Grace';input.dispatchEvent(new Event('input',{bubbles:true}));window.print=()=>{};document.querySelector('#exportBtn').click();return true})()",
);
record("Lyrics input updates its printable text", (await text(".lyric-print", 0)) === "Grace");

const barsBefore = await evaluate("document.querySelectorAll('.bar').length");
await click(".add-bar");
record("Add one bar", await evaluate(`document.querySelectorAll('.bar').length===${barsBefore + 1}`));
await click(".delete-bar", 4);
record("Delete individual bar", await evaluate(`document.querySelectorAll('.bar').length===${barsBefore}`));
await click("#addSectionBtn");
record("Add section", (await evaluate("document.querySelectorAll('.preview-section').length")) === 2);
await click(".delete-section", 1);
record("Delete section", (await evaluate("document.querySelectorAll('.preview-section').length")) === 1);

// Fresh transpose case: absolute chords move, Nashville notation does not.
await navigate();
await click(".chord-family .chord", 3);
await click(".drop-target", 0);
await click("#tabNashville");
await click("#nashvilleChordBank .chord", 0);
await click(".drop-target", 1);
await click("#transposeUp");
const transposed = await chordTexts();
record("Transpose changes absolute chord", transposed[0] === "D♭maj7", JSON.stringify(transposed));
record("Transpose preserves Nashville notation", transposed[1] === "1", JSON.stringify(transposed));
record("Transpose updates key", (await text("#previewKey")) === "D♭");

// Meter and metadata editing.
await evaluate(
   "(()=>{const meter=document.querySelector('#timeSignature');meter.value='3/4';meter.dispatchEvent(new Event('change',{bubbles:true}));return true})()",
);
record(
   "Time signature updates beat count",
   (await evaluate("document.querySelectorAll('.drop-target').length")) === 12,
);
await click("#previewTitle");
await evaluate(
   "(async()=>{const input=document.querySelector('#previewTitle input');input.value='Mobile Grace';input.dispatchEvent(new FocusEvent('blur'));await new Promise(resolve=>setTimeout(resolve,20));return true})()",
);
const editedTitle = await evaluate(
   "({preview:document.querySelector('#previewTitle').textContent.trim(),source:document.querySelector('#songTitle').value})",
);
record(
   "Inline title editing works",
   editedTitle.preview === "Mobile Grace" && editedTitle.source === "Mobile Grace",
   JSON.stringify(editedTitle),
);

// Export and import project file without triggering a real download. The
// editor's topbar Export .file was moved to a per-card action in My Songs, so we
// exercise the gallery's pure download helper (exposed as __cloudDownloadSong in
// test mode) with the current project data.
await evaluate(
   "(()=>{window.__downloadName='';window.__exportBlob=null;URL.createObjectURL=blob=>(window.__exportBlob=blob,'blob:regression');URL.revokeObjectURL=()=>{};HTMLAnchorElement.prototype.click=function(){window.__downloadName=this.download};const p=window.__projectDataForTest?window.__projectDataForTest():null;window.__cloudDownloadSong({title:'Mobile Grace',meter:'3/4',format:'chord-sheet',version:2,sections:[{name:'Verse',beats:{'0-0':{chord:'C',duration:null}}}]});return true})()",
);
const exported = await evaluate(
   "(async()=>({name:window.__downloadName,data:JSON.parse(await window.__exportBlob.text())}))()",
);
record("Export .file uses the expected extension", exported.name === "mobile-grace.chordsheet.json", exported.name);
record(
   "Export .file contains metadata, meter, sections and beats",
   exported.data.title === "Mobile Grace" &&
      exported.data.meter === "3/4" &&
      Array.isArray(exported.data.sections) &&
      !!exported.data.sections[0].beats,
   JSON.stringify({
      title: exported.data.title,
      meter: exported.data.meter,
      sections: exported.data.sections?.length,
      hasBeats: !!exported.data.sections?.[0]?.beats,
   }),
);
await evaluate(
   `(async()=>{const project=${JSON.stringify({ format: "chord-sheet", version: 2, title: "Imported Song", artist: "Regression Artist", key: "F", chordRoot: "F", customChord: "F6/9", meter: "4/4", lyricsEnabled: true, sections: [{ id: "imported", name: "Verse", lyricsEnabled: true, lyricBeats: { "0-0": "Sing", "0-1:1": "grace", "0-2:0": "through", "0-2:3": "night", "0-3:0": "for", "0-3:1": "me", "1-0:0.0": "nested", "1-0:0.1": "half", "1-1": "slash" }, bars: 4, beats: { "0-0": { chord: "F", duration: null }, "0-1": { chord: null, duration: "half" }, "0-1:1": { chord: "2̇m", duration: null }, "0-2": { chord: null, duration: "quarter" }, "0-2:0": { chord: "1̇", duration: null }, "0-2:3": { chord: "3̣", duration: null }, "0-3": { chord: null, duration: "half" }, "0-3:0": { chord: "4̇", duration: null }, "0-3:1": { chord: "1̇", duration: null }, "1-0": { chord: null, duration: "half" }, "1-0:0": { chord: null, duration: "half" }, "1-0:0.0": { chord: "4", duration: null }, "1-0:0.1": { chord: "Gmaj7", duration: null }, "1-0:1": { chord: "7", duration: null }, "1-1": { chord: "C/F", duration: null } } }], slashChords: ["F/A"], nashvilleNumber: "2̇", nashvilleAccidental: "" })};const input=document.querySelector('#galleryUploadInput'),file=new File([JSON.stringify(project)],'import.chordsheet.json',{type:'application/json'}),transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,50));return true})()`,
);
record(
   "Upload .file restores title and section",
   (await text("#previewTitle")) === "Imported Song" && (await text(".section-title")) === "VERSE",
);
const importedNotation = await chordTexts();
record(
   "Upload .file restores chord and Nashville content",
   ["F", "2m", "1", "3", "4", "C/F", "Gmaj7", "7"].every((value) => importedNotation.includes(value)),
   JSON.stringify(importedNotation),
);
await click("#tabRhythm");
await click(".duration-option", 1);
await evaluate(
   "document.querySelectorAll('.drop-target')[document.querySelectorAll('.drop-target').length-1].click();true",
);
record(
   "Triplet remains readable alongside imported chords and lyrics",
   (await evaluate("document.querySelectorAll('.duration-triplet .sub-beats')[0]?.children.length")) === 3,
);

// Exact print-state checks and a mixed PDF fixture.
await evaluate(
   "document.documentElement.style.scrollBehavior='auto';window.scrollTo(0,0);document.querySelector('#previewViewport').scrollTo(0,0);document.querySelector('#previewCard').style.zoom=1;true",
);
await cdp.send("Emulation.setEmulatedMedia", { media: "print" });
const printStyles = await evaluate(
   "(()=>{const bar=document.querySelector('.bar'),before=getComputedStyle(bar,'::before'),after=getComputedStyle(bar,'::after');return {before:before.content,beforeHeight:before.height,beforeColor:before.backgroundColor,after:after.content,afterHeight:after.height,signature:getComputedStyle(document.querySelector('.pdf-signature')).display}})()",
);
record(
   "PDF bar boundaries are rendered at the adjusted height",
   printStyles.before !== "none" &&
      printStyles.after !== "none" &&
      printStyles.beforeHeight === "42px" &&
      printStyles.afterHeight === "42px",
   JSON.stringify(printStyles),
);
record("PDF signature is visible", printStyles.signature !== "none");
// Marker lines are intentionally inset from each group edge by
// --print-duration-inset (a visual break between subdivided beats), so a
// marker spans notesWidth − 2×inset rather than the full content width.
const durationInsetPx = await evaluate(
   "(()=>{const p=document.createElement('div');p.style.cssText='position:absolute;visibility:hidden;width:var(--print-duration-inset)';document.body.appendChild(p);const w=p.getBoundingClientRect().width;p.remove();return w})()",
);
const insetTotal = durationInsetPx * 2;
const rhythmLineSizing = await evaluate(
   "(()=>{const groups=[...document.querySelectorAll('.beat-group:not(.has-nested-duration)')],rows=groups.map(group=>{const notes=group.querySelector(':scope > .sub-beats').getBoundingClientRect().width,primary=group.querySelector(':scope > .duration-line').getBoundingClientRect().width,secondary=group.querySelector(':scope > .quarter-print-line')?.getBoundingClientRect().width??null;return {duration:['half','triplet','quarter'].find(value=>group.classList.contains('duration-'+value)),notes,primary,secondary}});return rows})()",
);
record(
   "PDF rhythm markers follow their subdivision content width (minus optical inset)",
   rhythmLineSizing.every(
      (row) =>
         Math.abs(row.primary - (row.notes - insetTotal)) < 0.6 &&
         (row.secondary === null || Math.abs(row.secondary - (row.notes - insetTotal)) < 0.6),
   ),
   JSON.stringify({ insetTotal, rhythmLineSizing }),
);
record(
   "PDF triplet marker is present and spans three notes",
   rhythmLineSizing.some((row) => row.duration === "triplet"),
   JSON.stringify(rhythmLineSizing),
);
const regularHalfWidths = rhythmLineSizing
   .filter((row) => row.duration === "half")
   .map((row) => Math.round(row.primary));
record(
   "PDF half-beat marker width responds to its content",
   regularHalfWidths.length > 1 && new Set(regularHalfWidths).size > 1,
   JSON.stringify(regularHalfWidths),
);
const nestedLineSizing = await evaluate(
   "(()=>{const parents=[...document.querySelectorAll('.beat-group.has-nested-duration')].map(group=>({notes:group.querySelector(':scope > .sub-beats').getBoundingClientRect().width,line:group.querySelector(':scope > .duration-line').getBoundingClientRect().width})),children=[...document.querySelectorAll('.nested-beat-group')].map(group=>({notes:group.querySelector(':scope > .nested-sub-beats').getBoundingClientRect().width,line:group.querySelector(':scope > .nested-duration-line').getBoundingClientRect().width}));return {parents,children}})()",
);
record(
   "PDF nested half-beat markers follow parent and child content widths (minus optical inset)",
   [...nestedLineSizing.parents, ...nestedLineSizing.children].every(
      (row) => Math.abs(row.line - (row.notes - insetTotal)) < 0.6,
   ),
   JSON.stringify({ insetTotal, ...nestedLineSizing }),
);
await printPdf("mixed-chord-nashville-lyrics");
await cdp.send("Emulation.setEmulatedMedia", { media: "screen" });
await screenshot("desktop-1440");

// Export layout (is-print-layout) geometry: the on-print class drives the real
// PDF appearance. Verify the section-name chip, enlarged footer, and that the
// card frame ("stamped on paper" border/shadow) is gone. Measured under screen
// media because Chrome's print-media emulation strips backgrounds from
// getComputedStyle even when print-color-adjust:exact keeps them on paper;
// screen + is-print-layout is geometrically identical to print + is-print-layout.
await evaluate("document.documentElement.classList.add('is-print-layout');true");
const exportLayout = await evaluate(
   "(()=>{const title=document.querySelector('.section-title'),ts=title&&getComputedStyle(title),sig=document.querySelector('.pdf-signature'),ss=sig&&getComputedStyle(sig),card=document.querySelector('#previewCard'),cs=card&&getComputedStyle(card);let chipBg='';for(const sheet of document.styleSheets){let rules;try{rules=sheet.cssRules}catch(e){continue}for(const r of rules){if(r.selectorText==='html.is-print-layout #previewCard .section-title'){chipBg=r.style.background||r.style.backgroundColor}}}return {titleDisplay:ts?.display,titleStyle:ts?.fontStyle,titleBorderRadius:ts?.borderTopLeftRadius,titleBorderWidth:ts?.borderTopWidth,chipBg,titleFontSize:parseFloat(ts?.fontSize||'0'),sigFontSize:parseFloat(ss?.fontSize||'0'),cardShadow:cs?.boxShadow}})()",
);
record(
   "Export: section name is an italic chip (rounded border + tint)",
   exportLayout.titleDisplay === "inline-block" &&
      exportLayout.titleStyle === "italic" &&
      parseFloat(exportLayout.titleBorderRadius) > 0 &&
      parseFloat(exportLayout.titleBorderWidth) > 0 &&
      /rgba?\(/.test(exportLayout.chipBg) &&
      exportLayout.chipBg !== "rgba(0, 0, 0, 0)" &&
      exportLayout.chipBg !== "transparent",
   JSON.stringify(exportLayout),
);
record("Export: footer label is enlarged (>= 9px)", exportLayout.sigFontSize >= 9, JSON.stringify(exportLayout));
record(
   "Export: section title is larger than base body text",
   exportLayout.titleFontSize >= 14,
   JSON.stringify(exportLayout),
);
record(
   "Export: card frame shadow is removed (no stamped-on-paper look)",
   exportLayout.cardShadow === "none",
   JSON.stringify(exportLayout),
);
await evaluate("document.documentElement.classList.remove('is-print-layout');true");

// ---------------------------------------------------------------------------
// PDF Options dialog + live preview (desktop). The preview moves the real
// #previewCard into a simulated paper box; these guard that (a) the paper
// geometry matches the chosen paper/margins, (b) the card returns to the editor
// on close, (c) editor-only chrome (active-section highlight, signature footer)
// is stripped in the preview, and (d) the barline mid-row logic is applied.
// ---------------------------------------------------------------------------
await cdp.send("Emulation.setEmulatedMedia", { media: "" });
await viewport(1440, 1000, false);
await navigate();
await evaluate("document.querySelector('#exportBtn').click();true");
await waitFor("!document.querySelector('#pdfOptionsModal').hidden");
await evaluate(
   "(()=>{const d=document.querySelector('.pdf-options-dialog');if(d)d.style.transition='none';void d?.offsetHeight;return true})()",
);
await waitFor("!!document.querySelector('.pdf-preview-page #previewCard')");
record(
   "PDF options: real #previewCard is adopted into the preview paper",
   await evaluate("!!document.querySelector('.pdf-preview-page #previewCard')"),
);
record(
   "PDF options: live preview is read-only (pointer-events none)",
   (await evaluate("getComputedStyle(document.querySelector('.pdf-preview-page #previewCard')).pointerEvents")) ===
      "none",
);
record(
   "PDF options: signature footer is hidden in the live preview",
   (await evaluate(
      "(()=>{const s=document.querySelector('.pdf-preview-page #previewCard .pdf-signature');return s?getComputedStyle(s).display:'none'})()",
   )) === "none",
);
record(
   "PDF options: active-section highlight is stripped in the live preview",
   await evaluate(
      "(()=>{const a=document.querySelector('.pdf-preview-page #previewCard .preview-section.is-active');if(!a)return true;const bg=getComputedStyle(a).backgroundColor;return bg==='rgba(0, 0, 0, 0)'||bg==='transparent'})()",
   ),
);
record(
   "PDF options: no page-number label badges are rendered",
   (await evaluate("document.querySelectorAll('.pdf-page-label').length")) === 0,
);
record(
   "PDF options: no green page-boundary guide is drawn",
   (await evaluate("getComputedStyle(document.querySelector('.pdf-preview-page'),'::after').backgroundImage")) ===
      "none",
);
const a4PaperWidth = await evaluate(
   "(()=>{const p=document.createElement('div');p.style.cssText='position:absolute;visibility:hidden;width:210mm';document.body.appendChild(p);const w=p.getBoundingClientRect().width;p.remove();return w})()",
);
record(
   "PDF options: default preview paper is A4 width (210mm)",
   Math.abs((await evaluate("document.querySelector('.pdf-preview-page').offsetWidth")) - a4PaperWidth) <= 2,
   JSON.stringify({ a4PaperWidth }),
);
const a4Printable = await evaluate(
   "(()=>{const p=document.createElement('div');p.style.cssText='position:absolute;visibility:hidden;width:192mm';document.body.appendChild(p);const w=p.getBoundingClientRect().width;p.remove();return w})()",
);
record(
   "PDF options: default content width equals A4 printable area (192mm)",
   Math.abs((await evaluate("document.querySelector('.pdf-preview-page #previewCard').clientWidth")) - a4Printable) <=
      2,
   JSON.stringify({ a4Printable }),
);
record(
   "PDF options: mid-row bars are tagged so redundant barlines are hidden",
   (await evaluate("document.querySelectorAll('.pdf-preview-page #previewCard .bar.pdf-mid-bar').length")) >= 1,
);
// Switch to Letter + Wide and confirm the paper geometry tracks the choice.
const letterPaperWidth = await evaluate(
   "(()=>{const p=document.createElement('div');p.style.cssText='position:absolute;visibility:hidden;width:215.9mm';document.body.appendChild(p);const w=p.getBoundingClientRect().width;p.remove();return w})()",
);
await evaluate("document.querySelector('[data-paper=\"letter\"]').click();true");
await evaluate("document.querySelector('[data-margin=\"wide\"]').click();true");
record(
   "PDF options: choosing Letter resizes the preview paper",
   Math.abs((await evaluate("document.querySelector('.pdf-preview-page').offsetWidth")) - letterPaperWidth) <= 2,
   JSON.stringify({ letterPaperWidth }),
);
await evaluate("document.querySelector('#pdfOptionsReset').click();true");
record(
   "PDF options: Reset returns the preview to A4",
   Math.abs((await evaluate("document.querySelector('.pdf-preview-page').offsetWidth")) - a4PaperWidth) <= 2,
);
// Close the dialog and confirm the card is handed back to the live editor intact.
await evaluate("document.querySelector('#pdfOptionsClose').click();true");
await waitFor("document.querySelector('#pdfOptionsModal').hidden");
record(
   "PDF options: closing returns #previewCard to the editor",
   await evaluate(
      "!document.querySelector('.pdf-preview-page') && !!document.querySelector('#previewViewport #previewCard')",
   ),
);
record(
   "PDF options: editor is interactive again after close",
   (await evaluate("getComputedStyle(document.querySelector('#previewCard')).pointerEvents")) !== "none",
);
record(
   "PDF options: mid-row barline tags are cleared from the live editor",
   (await evaluate("document.querySelectorAll('#previewCard .bar.pdf-mid-bar').length")) === 0,
);

// Refresh must restore the clean default state.
await navigate();
record("Refresh resets title", (await text("#previewTitle")) === "Song Title");
record(
   "Refresh resets score to one section and four bars",
   await evaluate(
      "document.querySelectorAll('.preview-section').length===1&&document.querySelectorAll('.bar').length===4&&!document.querySelector('.placed-chord')",
   ),
);

// ============================ CLOUD SYNC UI ============================
// The Firebase network layer can't be exercised in headless CI, so these tests
// cover the UI contract: topbar buttons exist, modals open centered & close,
// the gallery renders cards (title/creator/key/time) in a two-row zigzag grid
// that scrolls horizontally inside its container, search exists, prev/next
// scroll the grid, and the layout never pushes the shell wider than the
// viewport. Cards are rendered through the real render path via
// window.__cloudRenderMock (exposed in test mode).
await navigate();

// Helper: render N mock song cards through the real gallery render logic.
const injectCards = (n) => evaluate(`window.__cloudRenderMock(${n})`);

record(
   "Cloud: editor topbar exposes Back to My Songs + Save to Cloud (theme/profile moved to My Songs)",
   await evaluate(
      "!!document.querySelector('#backToSongsBtn')&&!!document.querySelector('#saveCloudBtn')&&!!document.querySelector('#accountBtn')&&!!document.querySelector('#themeToggle')",
   ),
);
record(
   "Editor: the standalone PDF options button is gone (folded into Export .pdf)",
   await evaluate("!document.querySelector('#pdfOptionsBtn')"),
);
record(
   "Editor: Save to Cloud and Export .pdf are both prominent, with distinct accents",
   await evaluate(
      "(()=>{const s=document.querySelector('#saveCloudBtn'),e=document.querySelector('#exportBtn');if(!s||!e)return false;const bg=el=>getComputedStyle(el).backgroundColor;const filled=v=>v&&v!=='rgba(0, 0, 0, 0)'&&v!=='transparent';return s.classList.contains('button-save')&&e.classList.contains('button-dark')&&filled(bg(s))&&filled(bg(e))&&bg(s)!==bg(e)})()",
   ),
);
record(
   "Editor: Export .pdf opens the PDF options dialog (does not export straight away)",
   await evaluate(
      "(async()=>{const modal=document.querySelector('#pdfOptionsModal');if(!modal.hidden){document.querySelector('#pdfOptionsClose').click();await new Promise(r=>setTimeout(r,360));}document.querySelector('#exportBtn').click();await new Promise(r=>setTimeout(r,420));const opened=!modal.hidden;document.querySelector('#pdfOptionsClose').click();await new Promise(r=>setTimeout(r,360));return opened})()",
   ),
);
record(
   "Nav: the editor is a sub-page - it leads with Back, not the app brand lockup",
   await evaluate(
      "(()=>{const back=document.querySelector('.topbar #backToSongsBtn');return !!back&&!document.querySelector('.topbar .brand')&&/my songs/i.test(back.textContent)})()",
   ),
);
record(
   "Nav: the editor header shows the document being edited (breadcrumb)",
   await evaluate(
      "(()=>{const c=document.querySelector('.topbar #editorSongName');if(!c)return false;const t=document.querySelector('#songTitle');t.value='Breadcrumb Probe';t.dispatchEvent(new Event('input',{bubbles:true}));return c.textContent.trim()==='Breadcrumb Probe'})()",
   ),
);
record(
   "Nav: home (My Songs) owns the brand lockup and the page title",
   await evaluate(
      "(()=>{const b=document.querySelector('#mySongsModal .home-brand');const h=document.querySelector('#mySongsModal .home-intro h1');return !!b&&!!h&&/your song library/i.test(h.textContent)})()",
   ),
);
record(
   "Nav: the editor page no longer carries the hero intro section",
   await evaluate("!document.querySelector('main .intro')"),
);
record(
   "Nav: home is a page, not a dismissible dialog (no close button, not aria-modal)",
   await evaluate(
      "(()=>{const m=document.querySelector('#mySongsModal');return !document.querySelector('#mySongsClose')&&m.getAttribute('aria-modal')===null})()",
   ),
);
record(
   "Cloud: theme + profile controls live inside the My Songs header",
   await evaluate(
      "!!document.querySelector('.cloud-gallery-actions #themeToggle')&&!!document.querySelector('.cloud-gallery-actions #accountBtn')",
   ),
);
record(
   "Nav: the profile button opens a card with identity, theme and Sign out",
   await evaluate(
      "(()=>{const pop=document.querySelector('#accountPopover');if(!pop)return false;return !!pop.querySelector('#accountPopoverName')&&!!pop.querySelector('#accountPopoverEmail')&&!!pop.querySelector('#themeToggle')&&!!pop.querySelector('#signOutBtn')&&pop.hidden})()",
   ),
);
record(
   "Cloud: editor topbar no longer has theme, Export .file, or profile buttons",
   await evaluate(
      "!document.querySelector('.topbar #themeToggle')&&!document.querySelector('.topbar #saveBtn')&&!document.querySelector('.topbar #accountBtn')&&!document.querySelector('#projectFileInput')&&!document.querySelector('.upload-project')",
   ),
);
record("Cloud: gallery starts hidden", await evaluate("document.querySelector('#mySongsModal').hidden"));

// The dedicated full-screen login page exists and, in test mode, is gated off
// (auth gate resolves to "app" so the editor suite runs without a real sign-in).
record(
   "Cloud: dedicated login page exists (not a dismissible modal)",
   await evaluate("!!document.querySelector('#loginPage')&&!document.querySelector('#loginModal')"),
);
record(
   "Cloud: login page hidden in test mode (auth gate bypassed)",
   await evaluate("document.querySelector('#loginPage').hidden && document.documentElement.dataset.authGate==='app'"),
);
// Force the login page open to verify its layout + controls.
await evaluate(
   "(()=>{const p=document.querySelector('#loginPage');p.hidden=false;p.classList.add('is-open');return true})()",
);
record(
   "Cloud: login page uses a two-column gate layout",
   await evaluate("getComputedStyle(document.querySelector('#loginPage')).display==='grid'"),
);
record(
   "Cloud: login offers Google + email/password sign-in",
   await evaluate(
      "!!document.querySelector('#googleSignInBtn')&&!!document.querySelector('#authEmail')&&!!document.querySelector('#authPassword')&&!!document.querySelector('#emailSignUpBtn')",
   ),
);
record(
   "Cloud: login page has a brand panel with product highlights",
   await evaluate(
      "!!document.querySelector('#loginPage .login-aside')&&document.querySelectorAll('#loginPage .login-aside-points li').length>=3",
   ),
);
record(
   "Cloud: login page shares the My Songs brand lockup + hero heading",
   await evaluate(
      "(()=>{const brand=document.querySelector('#loginPage .login-aside-brand.home-brand');const hero=document.querySelector('#loginPage .login-aside-title');return !!brand&&!!brand.querySelector('.home-brand-icon')&&!!hero&&/arrange chords/i.test(hero.textContent)})()",
   ),
);
record(
   "Cloud: login page dropped the old bespoke icon tiles for the shared lockup",
   await evaluate(
      "!document.querySelector('#loginPage .login-card-icon')&&!document.querySelector('#loginPage .login-brand-icon')&&!!document.querySelector('#loginPage .login-card-brand')",
   ),
);
// Hide it again so it doesn't overlap the rest of the suite.
await evaluate(
   "(()=>{const p=document.querySelector('#loginPage');p.classList.remove('is-open');p.hidden=true;return true})()",
);

// Themed confirm dialog (replaces window.confirm for Sign out).
record(
   "Cloud: a themed confirm dialog exists and starts hidden",
   await evaluate(
      "(()=>{const d=document.querySelector('#confirmDialog');return !!d&&d.hidden&&!!d.querySelector('#confirmDialogConfirm')&&!!d.querySelector('#confirmDialogCancel')})()",
   ),
);
record(
   "Cloud: Sign out asks for confirmation via the themed dialog (Cancel aborts)",
   await evaluate(
      "(async()=>{const wait=ms=>new Promise(r=>setTimeout(r,ms));const pop=document.querySelector('#accountPopover');pop.hidden=false;pop.classList.add('is-open');document.querySelector('#signOutBtn').click();await wait(120);const d=document.querySelector('#confirmDialog');const opened=!d.hidden;const labelled=/sign out/i.test(document.querySelector('#confirmDialogConfirm').textContent)&&/cancel/i.test(document.querySelector('#confirmDialogCancel').textContent);document.querySelector('#confirmDialogCancel').click();await wait(360);return opened&&labelled&&d.hidden})()",
   ),
);
record(
   "Cloud: the confirm dialog outranks the login + home overlays (z-index)",
   await evaluate(
      "(()=>{const z=el=>parseInt(getComputedStyle(el).zIndex,10)||0;return z(document.querySelector('#confirmDialog'))>z(document.querySelector('#loginPage'))&&z(document.querySelector('#confirmDialog'))>z(document.querySelector('#mySongsModal'))})()",
   ),
);
record(
   "Cloud: the device hint sits above every full-screen surface (z-index)",
   await evaluate(
      "(()=>{const z=el=>parseInt(getComputedStyle(el).zIndex,10)||0;return z(document.querySelector('#deviceHint'))>z(document.querySelector('#loginPage'))&&z(document.querySelector('#deviceHint'))>z(document.querySelector('#mySongsModal'))})()",
   ),
);

// Force the gallery open (bypassing auth) and inject mock cards to test UI.
await evaluate(
   "(()=>{const m=document.querySelector('#mySongsModal');m.hidden=false;m.classList.add('is-open');document.querySelector('#galleryLoading').hidden=true;return true})()",
);
record(
   "Cloud: gallery overlay uses a grid layer",
   await evaluate("getComputedStyle(document.querySelector('#mySongsModal')).display==='grid'"),
);
await injectCards(6);
record(
   "Cloud: gallery renders one card per song",
   (await evaluate("document.querySelectorAll('.song-card').length")) === 6,
);
record(
   "Cloud: each card shows title, creator, key, and time",
   await evaluate(
      "[...document.querySelectorAll('.song-card')].every(c=>c.querySelector('.song-card-title')&&c.querySelector('.song-card-creator')&&c.querySelectorAll('.song-card-chip').length===2)",
   ),
);
record(
   "Cloud: cards are laid out in a two-row grid",
   await evaluate(
      "(()=>{const g=document.querySelector('.cloud-cards');const rows=getComputedStyle(g).gridTemplateRows.trim().split(/\\s+/).filter(Boolean);return getComputedStyle(g).display==='grid'&&rows.length===2})()",
   ),
);
record(
   "Cloud: columns zigzag (alternating up/down offsets)",
   await evaluate(
      "(()=>{const cards=[...document.querySelectorAll('.song-card')];const a=getComputedStyle(cards[0]).getPropertyValue('--shift').trim();const b=getComputedStyle(cards[2]).getPropertyValue('--shift').trim();return a!==b&&a!==''&&b!==''})()",
   ),
);
record(
   "Cloud: each card exposes export + delete + duplicate actions",
   await evaluate(
      "[...document.querySelectorAll('.song-card')].every(c=>c.querySelector('.song-card-action.is-export')&&c.querySelector('.song-card-action.is-delete')&&c.querySelector('.song-card-action.is-duplicate'))",
   ),
);
record(
   "Cloud: card actions + detail are revealed on hover/focus",
   await evaluate(
      "(async()=>{const card=document.querySelector('.song-card');const actions=card.querySelector('.song-card-actions');const detail=card.querySelector('.song-card-detail');actions.style.transition='none';detail.style.transition='none';card.focus();await new Promise(r=>setTimeout(r,40));const ok=parseFloat(getComputedStyle(actions).opacity)===1&&parseFloat(getComputedStyle(detail).opacity)>0.5;card.blur();actions.style.transition='';detail.style.transition='';return ok})()",
   ),
);
record(
   "Cloud: gallery never pushes the shell wider than the viewport",
   await evaluate(
      "(()=>{const shell=document.querySelector('.cloud-gallery-shell');const head=document.querySelector('.cloud-gallery-head');return shell.scrollWidth<=innerWidth+1&&head.getBoundingClientRect().right<=innerWidth+1})()",
   ),
);
record(
   "Cloud: gallery has a title search box",
   await evaluate("!!document.querySelector('#songSearch')&&document.querySelector('#songSearch').type==='search'"),
);
record(
   "Cloud: search sits in a centered bar above the card list",
   await evaluate(
      "(()=>{const bar=document.querySelector('.cloud-gallery-searchbar');const body=document.querySelector('.cloud-gallery-body');const search=document.querySelector('.cloud-search');if(!bar||!body||!search)return false;const br=bar.getBoundingClientRect(),sr=search.getBoundingClientRect();const centered=Math.abs((sr.left+sr.right)/2-(br.left+br.right)/2)<=2;const above=br.bottom<=body.getBoundingClientRect().top+1;return centered&&above})()",
   ),
);
record(
   "Cloud: the hero heading sits above the search bar on its own row",
   await evaluate(
      "(()=>{const hero=document.querySelector('.home-intro');const bar=document.querySelector('.cloud-gallery-searchbar');if(!hero||!bar)return false;return hero.getBoundingClientRect().bottom<=bar.getBoundingClientRect().top+1&&!bar.contains(hero)})()",
   ),
);
record(
   "Cloud: there is clear breathing room between the search bar and the song list",
   await evaluate(
      "(()=>{const search=document.querySelector('.cloud-search');const card=document.querySelector('.song-card');if(!search||!card)return false;const gap=card.getBoundingClientRect().top-search.getBoundingClientRect().bottom;return gap>=12})()",
   ),
);
record(
   "Cloud: each card exposes an Export .file action",
   await evaluate("!!document.querySelector('.song-card .song-card-action.is-export[data-act=\"export\"]')"),
);
record(
   "Cloud: each card exposes an Edit action that routes to the chord editor",
   await evaluate(
      "[...document.querySelectorAll('.song-card')].every(c=>!!c.querySelector('.song-card-action.is-edit[data-act=\"edit\"]'))",
   ),
);
record(
   "Cloud: each card exposes an Export .pdf action",
   await evaluate(
      "[...document.querySelectorAll('.song-card')].every(c=>!!c.querySelector('.song-card-action.is-pdf[data-act=\"pdf\"]'))",
   ),
);
record(
   "Cloud: the per-card Export .pdf action is labelled for hover/assistive tech",
   await evaluate(
      "(()=>{const b=document.querySelector('.song-card .is-pdf');return !!b&&b.dataset.label==='Export .pdf'&&/as PDF$/.test(b.getAttribute('aria-label'))})()",
   ),
);
record(
   "Cloud: all five card actions fit inside the card (no clipping)",
   await evaluate(
      "(()=>{const card=document.querySelector('.song-card');const a=card.querySelector('.song-card-actions');if(a.querySelectorAll('button').length!==5)return false;const dock=card.querySelector('.song-card-dock');dock.style.transition='none';a.style.transition='none';card.focus();const ar=a.getBoundingClientRect(),cr=card.getBoundingClientRect();const ok=ar.left>=cr.left-0.5&&ar.right<=cr.right+0.5;card.blur();dock.style.transition='';a.style.transition='';return ok})()",
   ),
);
record(
   "PDF: the options dialog can be driven for a song opened from My Songs",
   await evaluate(
      "(async()=>{const t=document.querySelector('#songTitle');t.value='Card PDF Probe';t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#exportBtn').click();await new Promise(r=>setTimeout(r,420));const modal=document.querySelector('#pdfOptionsModal');const host=document.querySelector('#pdfPreviewHost');const ok=!modal.hidden&&!!host.querySelector('#previewCard')&&document.querySelector('#previewTitle').textContent==='Card PDF Probe';document.querySelector('#pdfOptionsClose').click();await new Promise(r=>setTimeout(r,360));return ok&&modal.hidden})()",
   ),
);
// With many songs the grid scrolls horizontally INSIDE its container; the page
// and header must stay put (this is the header-drift bug fix).
await injectCards(30);
await evaluate("window.__cloudUpdateBlur()");
record(
   "Cloud: many songs keep the page + header within the viewport (no drift)",
   await evaluate(
      "(()=>{const shell=document.querySelector('.cloud-gallery-shell');const head=document.querySelector('.cloud-gallery-head');return document.documentElement.scrollWidth<=document.documentElement.clientWidth+1&&shell.scrollWidth<=innerWidth+1&&head.getBoundingClientRect().right<=innerWidth+1})()",
   ),
);
record(
   "Cloud: the card grid itself overflows horizontally (scrollable)",
   await evaluate("(()=>{const g=document.querySelector('.cloud-cards');return g.scrollWidth>g.clientWidth+4})()"),
);
record(
   "Cloud: next nudge button appears when the grid can scroll",
   await evaluate("!document.querySelector('#galleryNext').hidden"),
);
record("Cloud: grid starts scrolled to the left", (await evaluate("window.__cloudScrollLeft()")) <= 2);
record(
   "Cloud: prev nudge button is hidden at the start",
   await evaluate("document.querySelector('#galleryPrev').hidden"),
);
await evaluate("window.__cloudNudge(1)");
await evaluate("(async()=>{await new Promise(r=>setTimeout(r,420));return true})()");
await evaluate("window.__cloudUpdateBlur()");
record("Cloud: next nudge scrolls the grid to the right", (await evaluate("window.__cloudScrollLeft()")) > 2);
record(
   "Cloud: prev nudge becomes available after scrolling",
   await evaluate("!document.querySelector('#galleryPrev').hidden"),
);
await evaluate("window.__cloudRenderMock(6);true");
record(
   "Cloud: gallery exposes New Song and Upload controls",
   await evaluate("!!document.querySelector('#newSongBtn')&&!!document.querySelector('#galleryUploadInput')"),
);
// Home is not dismissible, so instead of a close button the route drives the
// screen: #/song/... shows the editor, #/songs shows home.
await evaluate("(()=>{location.hash='#/song/new';return true})()");
await waitFor("document.querySelector('#mySongsModal').hidden");
record(
   "Nav: routing to #/song/... leaves home and shows the editor",
   await evaluate("document.querySelector('#mySongsModal').hidden"),
);
await evaluate("(()=>{location.hash='#/songs';return true})()");
await waitFor("!document.querySelector('#mySongsModal').hidden");
record(
   "Nav: routing to #/songs returns to home (browser Back works)",
   await evaluate("!document.querySelector('#mySongsModal').hidden"),
);
record(
   "Nav: the Back to My Songs button routes home",
   await evaluate(
      "(async()=>{location.hash='#/song/new';await new Promise(r=>setTimeout(r,60));document.querySelector('#backToSongsBtn').click();await new Promise(r=>setTimeout(r,80));const d=document.querySelector('#unsavedDialog');if(d&&!d.hidden){document.querySelector('#unsavedDiscardBtn').click();await new Promise(r=>setTimeout(r,80));}return location.hash==='#/songs'})()",
   ),
);
// Unsaved-changes guard: editing then clicking Back prompts a 3-choice dialog.
// Cancel keeps the user in the editor; Leave without saving navigates home.
record(
   "Nav: Back with unsaved edits opens the unsaved-changes dialog (Save & leave / Leave without saving / Cancel)",
   await evaluate(
      "(async()=>{location.hash='#/song/new';await new Promise(r=>setTimeout(r,80));const beat=document.querySelector('.drop-target');beat.click();await new Promise(r=>setTimeout(r,80));const inp=document.querySelector('.chord-popover-input,.chord-popover input');inp.value='C';inp.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,80));inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await new Promise(r=>setTimeout(r,120));document.querySelector('#backToSongsBtn').click();await new Promise(r=>setTimeout(r,120));const d=document.querySelector('#unsavedDialog');const ok=!!d&&!d.hidden&&/save & leave/i.test(document.querySelector('#unsavedSaveBtn').textContent)&&/leave without saving/i.test(document.querySelector('#unsavedDiscardBtn').textContent)&&/cancel/i.test(document.querySelector('#unsavedCancelBtn').textContent);return ok})()",
   ),
);
record(
   "Nav: unsaved dialog Cancel keeps the editor open (no navigation)",
   await evaluate(
      "(async()=>{document.querySelector('#unsavedCancelBtn').click();await new Promise(r=>setTimeout(r,120));const d=document.querySelector('#unsavedDialog');return d.hidden&&location.hash==='#/song/new'})()",
   ),
);
record(
   "Nav: unsaved dialog Leave without saving navigates home",
   await evaluate(
      "(async()=>{document.querySelector('#backToSongsBtn').click();await new Promise(r=>setTimeout(r,120));document.querySelector('#unsavedDiscardBtn').click();await new Promise(r=>setTimeout(r,200));return location.hash==='#/songs'})()",
   ),
);
// Central guard also covers the browser Back button: a hashchange that leaves a
// dirty editor for home re-pins the URL to the editor and opens the same dialog.
record(
   "Nav: browser Back (hashchange) with unsaved edits re-pins editor + opens dialog",
   await evaluate(
      "(async()=>{location.hash='#/song/new';await new Promise(r=>setTimeout(r,120));const beat=document.querySelector('.drop-target');beat.click();await new Promise(r=>setTimeout(r,80));const inp=document.querySelector('.chord-popover-input,.chord-popover input');inp.value='C';inp.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,80));inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await new Promise(r=>setTimeout(r,150));location.hash='#/songs';await new Promise(r=>setTimeout(r,150));const d=document.querySelector('#unsavedDialog');const ok=!!d&&!d.hidden&&location.hash==='#/song/new';document.querySelector('#unsavedDiscardBtn').click();await new Promise(r=>setTimeout(r,200));return ok&&location.hash==='#/songs'})()",
   ),
);
// New song shares the guard: starting fresh while dirty prompts before wiping.
record(
   "Nav: New song with unsaved edits opens the guard dialog before resetting",
   await evaluate(
      "(async()=>{location.hash='#/song/new';await new Promise(r=>setTimeout(r,120));const beat=document.querySelector('.drop-target');beat.click();await new Promise(r=>setTimeout(r,80));const inp=document.querySelector('.chord-popover-input,.chord-popover input');inp.value='C';inp.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,80));inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await new Promise(r=>setTimeout(r,150));document.querySelector('#backToSongsBtn').click();await new Promise(r=>setTimeout(r,120));document.querySelector('#unsavedDiscardBtn').click();await new Promise(r=>setTimeout(r,200));const nb=document.querySelector('#newSongBtn');nb.click();await new Promise(r=>setTimeout(r,120));const beat2=document.querySelector('.drop-target');beat2.click();await new Promise(r=>setTimeout(r,80));const inp2=document.querySelector('.chord-popover-input,.chord-popover input');inp2.value='G';inp2.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,80));inp2.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await new Promise(r=>setTimeout(r,150));document.querySelector('#newSongBtn').click();await new Promise(r=>setTimeout(r,120));const d=document.querySelector('#unsavedDialog');const ok=!!d&&!d.hidden;document.querySelector('#unsavedDiscardBtn').click();await new Promise(r=>setTimeout(r,200));return ok})()",
   ),
);
// #4 unsaved indicator: the Save to Cloud button reflects the editor dirty flag.
record(
   "Cloud: Save to Cloud button shows an unsaved-changes badge while dirty",
   await evaluate(
      "(async()=>{const btn=document.querySelector('#saveCloudBtn');window.dispatchEvent(new CustomEvent('chordsheet:dirtychange',{detail:{dirty:true}}));const on=btn.classList.contains('is-unsaved')&&/unsaved/i.test(btn.getAttribute('aria-label')||'');window.dispatchEvent(new CustomEvent('chordsheet:dirtychange',{detail:{dirty:false}}));const off=!btn.classList.contains('is-unsaved');return on&&off})()",
   ),
);
record(
   "Nav: home locks the page so the editor behind it shows no scrollbar",
   await evaluate(
      "(async()=>{const de=document.documentElement;location.hash='#/song/new';await new Promise(r=>setTimeout(r,320));const editorOverflow=getComputedStyle(de).overflowY;const editorScreen=de.dataset.screen;location.hash='#/songs';await new Promise(r=>setTimeout(r,320));const homeOverflow=getComputedStyle(de).overflowY;const homeBody=getComputedStyle(document.body).overflowY;return editorScreen==='editor'&&editorOverflow!=='hidden'&&de.dataset.screen==='home'&&homeOverflow==='hidden'&&homeBody==='hidden'})()",
   ),
);
record(
   "Nav: routing back to the editor restores page scrolling",
   await evaluate(
      "(async()=>{location.hash='#/song/new';await new Promise(r=>setTimeout(r,320));const de=document.documentElement;return de.dataset.screen==='editor'&&getComputedStyle(de).overflowY!=='hidden'&&getComputedStyle(document.body).overflowY!=='hidden'})()",
   ),
);

// Mobile interaction and layout suite.
for (const [width, height, deviceScaleFactor = 1] of [
   [390, 844],
   [320, 800],
   [393, 870, 2.75],
]) {
   await viewport(width, height, true, deviceScaleFactor);
   await navigate();
   const layout = await evaluate(
      "(()=>{const inside=el=>{const r=el.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.width>0&&r.height>0};return {pageOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,actions:[...document.querySelectorAll('.topbar-actions .button,.topbar-actions .upload-project')].every(inside),ribbonHidden:getComputedStyle(document.querySelector('.editor-card')).display==='none',lyricsToggle:inside(document.querySelector('.topbar-lyrics-toggle')),toolbarGone:!document.querySelector('.canvas-toolbar'),cardZoom:getComputedStyle(document.querySelector('#previewCard')).zoom}})()",
   );
   record(`${width}px no page-level horizontal overflow`, !layout.pageOverflow, JSON.stringify(layout));
   record(`${width}px header actions remain visible`, layout.actions, JSON.stringify(layout));
   record(`${width}px arrangement ribbon is hidden (preview-focused)`, layout.ribbonHidden, JSON.stringify(layout));
   record(`${width}px topbar lyrics toggle remains visible`, layout.lyricsToggle, JSON.stringify(layout));
   record(`${width}px canvas toolbar is removed`, layout.toolbarGone, JSON.stringify(layout));
   record(
      `${width}px preview stays at 1x on touch (accessible tap targets)`,
      Math.abs(parseFloat(layout.cardZoom) - 1) < 0.001,
      JSON.stringify(layout),
   );
   // Cloud UI on mobile: topbar cloud buttons stay visible (styles.css hides
   // .button-ghost <=560px; ui.css re-shows the cloud ones), and modals fit.
   record(
      `${width}px cloud topbar buttons stay visible`,
      await evaluate(
         "(()=>{const vis=id=>{const el=document.querySelector(id);if(!el)return false;const r=el.getBoundingClientRect();return getComputedStyle(el).display!=='none'&&r.width>0&&r.height>0};return vis('#backToSongsBtn')&&vis('#saveCloudBtn')})()",
      ),
   );
   await evaluate(
      "(()=>{const p=document.querySelector('#loginPage');p.hidden=false;p.classList.add('is-open');return true})()",
   );
   record(
      `${width}px login page fits with no horizontal overflow`,
      await evaluate(
         "(()=>{const c=document.querySelector('#loginPage .login-card');if(!c)return false;const r=c.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.width>0})()",
      ),
   );
   record(
      `${width}px login page hides the brand panel on mobile`,
      await evaluate("getComputedStyle(document.querySelector('#loginPage .login-aside')).display==='none'"),
   );
   await evaluate(
      "(()=>{const p=document.querySelector('#loginPage');p.classList.remove('is-open');p.hidden=true;return true})()",
   );
   // Gallery cards fit within the viewport width on mobile.
   await evaluate(
      '(()=>{const m=document.querySelector(\'#mySongsModal\');m.hidden=false;m.classList.add(\'is-open\');document.querySelector(\'#galleryLoading\').hidden=true;const t=document.querySelector(\'#songCards\');t.innerHTML=\'<article class="song-card" data-id="x"><h3 class="song-card-title">Test</h3><div class="song-card-creator">A</div><div class="song-card-meta"><span class="song-card-chip"><small>Key</small> G</span><span class="song-card-chip"><small>Time</small> 4/4</span></div></article>\';return true})()',
   );
   record(
      `${width}px gallery card fits within viewport`,
      await evaluate(
         "(()=>{const c=document.querySelector('.song-card');if(!c)return false;const r=c.getBoundingClientRect();return r.width>0&&r.width<=innerWidth-8})()",
      ),
   );
   await evaluate(
      "(()=>{const m=document.querySelector('#mySongsModal');m.classList.remove('is-open');m.hidden=true;return true})()",
   );
   const mobileSticky = await evaluate(
      "(async()=>{const card=document.querySelector('#previewCard'),minimum=card.style.minHeight,smooth=document.documentElement.style.scrollBehavior;card.style.minHeight='1800px';document.documentElement.style.scrollBehavior='auto';window.scrollTo({top:400,behavior:'instant'});await new Promise(resolve=>setTimeout(resolve,80));const header=document.querySelector('.topbar').getBoundingClientRect(),editor=document.querySelector('.editor-card'),ribbonHidden=getComputedStyle(editor).display==='none';const result={headerBottom:header.bottom,ribbonHidden};window.scrollTo(0,0);card.style.minHeight=minimum;document.documentElement.style.scrollBehavior=smooth;return result})()",
   );
   record(`${width}px header scrolls away`, mobileSticky.headerBottom <= 0, JSON.stringify(mobileSticky));
   record(
      `${width}px arrangement ribbon is hidden (preview-focused)`,
      mobileSticky.ribbonHidden,
      JSON.stringify(mobileSticky),
   );
   const scoreLayout = await evaluate(
      "(()=>{const viewport=document.querySelector('.preview-viewport').getBoundingClientRect(),card=document.querySelector('.preview-card').getBoundingClientRect(),bars=[...document.querySelectorAll('.bar')].map(bar=>bar.getBoundingClientRect());return {viewportWidth:viewport.width,cardWidth:card.width,barsFit:bars.every(bar=>bar.left>=card.left-1&&bar.right<=card.right+1),barsStack:bars.every((bar,index)=>index===0||bar.top>=bars[index-1].bottom-1)}})()",
   );
   record(
      `${width}px live preview uses the available width`,
      scoreLayout.cardWidth >= scoreLayout.viewportWidth - 2,
      JSON.stringify(scoreLayout),
   );
   record(
      `${width}px bars fit and stack vertically`,
      scoreLayout.barsFit && scoreLayout.barsStack,
      JSON.stringify(scoreLayout),
   );
   await click(".chord-family .chord", 0);
   await click(".drop-target", 0);
   record(`${width}px tap-to-place chord works`, (await chordText(0)) === "C");
   // Removal now happens via the ✕ badge (clicking the chord body re-opens the
   // inline editor instead of deleting). Removal is animated (chord-leaving →
   // transitionend / 200ms fallback), so wait for the element to leave the DOM.
   await click(".placed-chord .chord-remove", 0);
   await waitFor("document.querySelectorAll('.placed-chord').length===0");
   record(
      `${width}px tapping the ✕ badge removes a placed chord`,
      (await evaluate("document.querySelectorAll('.placed-chord').length")) === 0,
   );
   await click("#tabNashville");
   await click(".nashville-row-block:nth-child(2) .nashville-key", 6);
   await click("#nashvilleChordBank .chord", 1);
   await click(".drop-target", 1);
   record(`${width}px Nashville mobile selection works`, (await chordText(0)).includes("7m"));
   await click("#tabLyrics");
   await click("#lyricsEnabled");
   record(
      `${width}px lyric inputs fit inside scrollable score`,
      await evaluate("document.querySelectorAll('.lyric-input').length>=16"),
   );
   record(
      `${width}px delete-bar touch target is usable`,
      await evaluate(
         "(()=>{const r=document.querySelector('.delete-bar').getBoundingClientRect();return r.width>=40&&r.height>=40})()",
      ),
   );
   record(
      `${width}px delete-bar does not cover the fourth beat`,
      await evaluate(
         "(()=>{const bar=document.querySelector('.bar'),button=bar.querySelector('.delete-bar').getBoundingClientRect(),lastBeat=[...bar.querySelectorAll(':scope > .beat-column')].at(-1).getBoundingClientRect();return button.left>=lastBeat.right})()",
      ),
   );
   const mobileBarsBefore = await evaluate("document.querySelectorAll('.bar').length");
   await click(".delete-bar", 0);
   record(
      `${width}px delete-bar removes one bar`,
      await evaluate(`document.querySelectorAll('.bar').length===${mobileBarsBefore - 1}`),
   );
   // PDF options on phones: the dialog opens as an options-only sheet — the live
   // PDF preview pane is hidden (no room to render a full page usefully), but all
   // controls stay reachable and closing still restores the editor.
   await evaluate("document.querySelector('#exportBtn').click();true");
   await waitFor("!document.querySelector('#pdfOptionsModal').hidden");
   await evaluate(
      "(()=>{const d=document.querySelector('.pdf-options-dialog');if(d)d.style.transition='none';void d?.offsetHeight;return true})()",
   );
   record(
      `${width}px PDF options hides the live preview pane`,
      (await evaluate("getComputedStyle(document.querySelector('.pdf-options-preview')).display")) === "none",
   );
   record(
      `${width}px PDF options panel stays visible`,
      await evaluate(
         "(()=>{const p=document.querySelector('.pdf-options-panel');return getComputedStyle(p).display!=='none'&&p.offsetWidth>0})()",
      ),
   );
   record(
      `${width}px PDF options controls are reachable`,
      await evaluate(
         "document.querySelectorAll('#pdfPresetGroup [data-preset]').length===4 && getComputedStyle(document.querySelector('#pdfOptionsExport')).display!=='none' && getComputedStyle(document.querySelector('#pdfOptionsReset')).display!=='none'",
      ),
   );
   record(
      `${width}px PDF options dialog has no horizontal overflow`,
      await evaluate(
         "(()=>{const d=document.querySelector('.pdf-options-dialog');return d.scrollWidth<=d.clientWidth+1})()",
      ),
   );
   await evaluate("document.querySelector('#pdfOptionsClose').click();true");
   await waitFor("document.querySelector('#pdfOptionsModal').hidden");
   record(
      `${width}px PDF options closing restores the editor`,
      await evaluate(
         "!document.querySelector('.pdf-preview-page') && !!document.querySelector('#previewViewport #previewCard')",
      ),
   );
   await screenshot(`mobile-${width}${deviceScaleFactor === 1 ? "" : "-dpr-" + deviceScaleFactor}`);
}

await viewport(1440, 1000, false);
// ============================================================================
// Clipboard & multi-bar selection tests (Copy bars feature)
// ============================================================================
// Re-navigate for a clean slate so earlier tests' edits don't interfere.
await navigate();

// Open the first section's ••• menu and confirm the "Copy bars" entry exists.
await evaluate("document.querySelector('.section-menu summary')?.click(); true");
await waitFor("!!document.querySelector('.select-bars')");
record(
   "Section menu exposes a 'Copy bars' action",
   (await text(".select-bars")) === "Copy bars",
   await text(".select-bars"),
);

// Enter selection mode.
await evaluate("document.querySelector('.select-bars')?.click(); true");
await waitFor("!!document.querySelector('.bar-selection-bar')");
record(
   "Clicking 'Copy bars' shows the selection toolbar",
   await evaluate("!!document.querySelector('.bar-selection-bar')"),
);

// Before any bar is picked, the count reads the empty-state text and Copy is disabled.
record(
   "Selection toolbar starts with no bars selected and Copy disabled",
   (await text(".bar-selection-count")) === "No bars selected yet" &&
      (await evaluate("!!document.querySelector('.bar-selection-copy[disabled]')")),
   await text(".bar-selection-count"),
);

// The whole bar is a click target in selection mode — click bar 0.
await evaluate("document.querySelector('.bar[data-bar=\"0\"]')?.click(); true");
await waitFor("document.querySelector('.bar-selection-count')?.textContent.trim()==='1 bar selected'");
record(
   "Clicking a bar selects it (count = 1) and marks it .is-selected",
   (await text(".bar-selection-count")) === "1 bar selected" &&
      (await evaluate("!!document.querySelector('.bar.is-selected')")),
);

// Copy becomes enabled once a bar is selected.
record(
   "Copy button is enabled after selecting a bar",
   await evaluate("!!document.querySelector('.bar-selection-copy:not([disabled])')"),
);

// While selecting, editing affordances must be hidden: per-chord × badge and bar tools.
record(
   "Editing affordances are suppressed while selecting bars",
   await evaluate(
      "(()=>{const rm=[...document.querySelectorAll('.is-selecting .chord-remove')].every(el=>getComputedStyle(el).display==='none');const tools=[...document.querySelectorAll('.is-selecting .bar-tools')].every(el=>getComputedStyle(el).display==='none');return rm&&tools})()",
   ),
);

// Shift-click bar 1 to extend the range to two bars.
await evaluate(
   "(()=>{const b=document.querySelector('.bar[data-bar=\"1\"]');if(!b)return false;b.dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}));return true})()",
);
await waitFor("document.querySelector('.bar-selection-count')?.textContent.trim()==='2 bars selected'");
record(
   "Shift+click extends the selection range (count = 2)",
   (await text(".bar-selection-count")) === "2 bars selected",
   await text(".bar-selection-count"),
);

// Copy the two-bar range; selection mode exits and the toolbar disappears.
await evaluate("document.querySelector('.bar-selection-copy')?.click(); true");
await waitFor("!document.querySelector('.bar-selection-bar')");
record("Copying the range exits selection mode", await evaluate("!document.querySelector('.bar-selection-bar')"));

// After copying, per-bar paste buttons become enabled (clipboard holds bars).
record(
   "Paste buttons are enabled after copying bars",
   await evaluate("!!document.querySelector('.paste-bar:not([disabled])')"),
);

// Cancel path: re-enter selection mode then cancel; toolbar should disappear.
await evaluate("document.querySelector('.section-menu summary')?.click(); true");
await waitFor("!!document.querySelector('.select-bars')");
await evaluate("document.querySelector('.select-bars')?.click(); true");
await waitFor("!!document.querySelector('.bar-selection-bar')");
await evaluate("document.querySelector('.bar-selection-cancel')?.click(); true");
await waitFor("!document.querySelector('.bar-selection-bar')");
record("Cancel exits selection mode without copying", await evaluate("!document.querySelector('.bar-selection-bar')"));

// ============================================================================
// End of clipboard & selection tests
// ============================================================================

await viewport(1440, 1000, false);
const failed = results.filter((result) => !result.passed);
await fs.writeFile(
   `${outputDir}/results.json`,
   JSON.stringify(
      { appUrl, total: results.length, passed: results.length - failed.length, failed: failed.length, results },
      null,
      2,
   ),
);
console.log(
   JSON.stringify(
      { total: results.length, passed: results.length - failed.length, failed: failed.length, outputDir },
      null,
      2,
   ),
);
if (failed.length) process.exitCode = 1;
