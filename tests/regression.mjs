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
   "(async()=>{const editor=document.querySelector('.editor-card'),card=document.querySelector('#previewCard'),minimum=card.style.minHeight,smooth=document.documentElement.style.scrollBehavior;card.style.minHeight='1800px';document.documentElement.style.scrollBehavior='auto';window.scrollTo({top:editor.offsetTop+160,behavior:'instant'});await new Promise(resolve=>setTimeout(resolve,80));const header=document.querySelector('.topbar').getBoundingClientRect(),ribbon=editor.getBoundingClientRect();const result={headerBottom:header.bottom,ribbonTop:ribbon.top,scrollY,scrollHeight:document.documentElement.scrollHeight};window.scrollTo(0,0);card.style.minHeight=minimum;document.documentElement.style.scrollBehavior=smooth;return result})()",
);
record("Desktop header scrolls away", desktopSticky.headerBottom <= 0, JSON.stringify(desktopSticky));
record(
   "Desktop Arrangement Tools remains pinned to the top",
   Math.abs(desktopSticky.ribbonTop) <= 1,
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

// Export and import project file without triggering a real download.
await evaluate(
   "(()=>{window.prompt=()=> 'regression-score';window.__downloadName='';window.__exportBlob=null;URL.createObjectURL=blob=>(window.__exportBlob=blob,'blob:regression');URL.revokeObjectURL=()=>{};HTMLAnchorElement.prototype.click=function(){window.__downloadName=this.download};document.querySelector('#saveBtn').click();return true})()",
);
const exported = await evaluate(
   "(async()=>({name:window.__downloadName,data:JSON.parse(await window.__exportBlob.text())}))()",
);
record("Export .file uses the expected extension", exported.name === "regression-score.chordsheet.json", exported.name);
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
   `(async()=>{const project=${JSON.stringify({ format: "chord-sheet", version: 2, title: "Imported Song", artist: "Regression Artist", key: "F", chordRoot: "F", customChord: "F6/9", meter: "4/4", lyricsEnabled: true, sections: [{ id: "imported", name: "Verse", lyricsEnabled: true, lyricBeats: { "0-0": "Sing", "0-1:1": "grace", "0-2:0": "through", "0-2:3": "night", "0-3:0": "for", "0-3:1": "me", "1-0:0.0": "nested", "1-0:0.1": "half", "1-1": "slash" }, bars: 4, beats: { "0-0": { chord: "F", duration: null }, "0-1": { chord: null, duration: "half" }, "0-1:1": { chord: "2̇m", duration: null }, "0-2": { chord: null, duration: "quarter" }, "0-2:0": { chord: "1̇", duration: null }, "0-2:3": { chord: "3̣", duration: null }, "0-3": { chord: null, duration: "half" }, "0-3:0": { chord: "4̇", duration: null }, "0-3:1": { chord: "1̇", duration: null }, "1-0": { chord: null, duration: "half" }, "1-0:0": { chord: null, duration: "half" }, "1-0:0.0": { chord: "4", duration: null }, "1-0:0.1": { chord: "Gmaj7", duration: null }, "1-0:1": { chord: "7", duration: null }, "1-1": { chord: "C/F", duration: null } } }], slashChords: ["F/A"], nashvilleNumber: "2̇", nashvilleAccidental: "" })};const input=document.querySelector('#projectFileInput'),file=new File([JSON.stringify(project)],'import.chordsheet.json',{type:'application/json'}),transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,50));return true})()`,
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
   "document.documentElement.style.scrollBehavior='auto';window.scrollTo(0,0);document.querySelector('#previewViewport').scrollTo(0,0);true",
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
await evaluate("document.querySelector('#pdfOptionsBtn').click();true");
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

// Mobile interaction and layout suite.
for (const [width, height, deviceScaleFactor = 1] of [
   [390, 844],
   [320, 800],
   [393, 870, 2.75],
]) {
   await viewport(width, height, true, deviceScaleFactor);
   await navigate();
   const layout = await evaluate(
      "(()=>{const inside=el=>{const r=el.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.width>0&&r.height>0};return {pageOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,actions:[...document.querySelectorAll('.topbar-actions .button,.topbar-actions .upload-project')].every(inside),tabs:[...document.querySelectorAll('.ribbon-tab')].every(inside),editorOverflow:document.querySelector('.editor-card').scrollWidth>document.querySelector('.editor-card').clientWidth+1,toolbar:[...document.querySelectorAll('.zoom-controls button')].every(inside)}})()",
   );
   record(`${width}px no page-level horizontal overflow`, !layout.pageOverflow, JSON.stringify(layout));
   record(`${width}px header actions remain visible`, layout.actions, JSON.stringify(layout));
   record(`${width}px all arrangement tabs remain visible`, layout.tabs, JSON.stringify(layout));
   record(`${width}px arrangement panel does not collide`, !layout.editorOverflow, JSON.stringify(layout));
   record(`${width}px canvas controls remain visible`, layout.toolbar, JSON.stringify(layout));
   const mobileSticky = await evaluate(
      "(async()=>{const editor=document.querySelector('.editor-card'),smooth=document.documentElement.style.scrollBehavior;document.documentElement.style.scrollBehavior='auto';window.scrollTo({top:editor.offsetTop+120,behavior:'instant'});await new Promise(resolve=>setTimeout(resolve,80));const header=document.querySelector('.topbar').getBoundingClientRect(),ribbon=editor.getBoundingClientRect();const result={headerBottom:header.bottom,ribbonTop:ribbon.top};window.scrollTo(0,0);document.documentElement.style.scrollBehavior=smooth;return result})()",
   );
   record(`${width}px header scrolls away`, mobileSticky.headerBottom <= 0, JSON.stringify(mobileSticky));
   record(
      `${width}px Arrangement Tools remains pinned to the top`,
      Math.abs(mobileSticky.ribbonTop) <= 1,
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
   await click(".placed-chord", 0);
   // Removal is animated (chord-leaving → transitionend / 200ms fallback), so
   // wait for the element to actually leave the DOM before asserting.
   await waitFor("document.querySelectorAll('.placed-chord').length===0");
   record(
      `${width}px tapping a placed chord removes it`,
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
   await evaluate("document.querySelector('#pdfOptionsBtn').click();true");
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
