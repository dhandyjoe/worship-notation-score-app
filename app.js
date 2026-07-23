const keys=['C','D♭','D','E♭','E','F','G♭','G','A♭','A','B♭','B'];
const notePitches={C:0,'B#':0,'D♭':1,Db:1,'C#':1,'C♯':1,D:2,'E♭':3,Eb:3,'D#':3,'D♯':3,E:4,'F♭':4,Fb:4,F:5,'E#':5,'E♯':5,'G♭':6,Gb:6,'F#':6,'F♯':6,G:7,'A♭':8,Ab:8,'G#':8,'G♯':8,A:9,'B♭':10,Bb:10,'A#':10,'A♯':10,B:11,'C♭':11,Cb:11};
const chordQualities=[
  {value:'',label:'major'},
  {value:'m',label:'m'},
  {value:'7',label:'7'},
  {value:'maj7',label:'maj7'},
  {value:'sus2',label:'sus2'},
  {value:'sus4',label:'sus4'},
  {value:'add9',label:'add9'},
  {value:'+',label:'+'},
  {value:'°',label:'°'},
  {value:'ø7',label:'ø7'},
];
const bassNotes=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const nashvilleNumbers=['1','2','3','4','5','6','7'];
const nashvilleZeroNumbers=['0'];
const nashvilleLowerNumbers=['1̣','2̣','3̣','4̣','5̣','6̣','7̣'];
const nashvilleUpperNumbers=['1̇','2̇','3̇','4̇','5̇','6̇','7̇'];
const nashvilleChoices=[...nashvilleNumbers,...nashvilleLowerNumbers,...nashvilleUpperNumbers,...nashvilleZeroNumbers];
const lyricsFeatureAvailable=true;
const durationMeta={half:{count:2,symbol:'½',label:'Half beat'},triplet:{count:3,symbol:'⅓',label:'Beat triplet'},quarter:{count:4,symbol:'¼',label:'Quarter beat'}};
const $=selector=>document.querySelector(selector);
const escapeHTML=value=>String(value??'').replace(/[&<>"]/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[character]));
const newSection=(name='Intro')=>({id:crypto.randomUUID(),name,lyricsEnabled:true,lyricBeats:{},bars:4,beats:{}});
let state={key:'C',chordRoot:'C',customChord:'',meter:'4/4',lyricsEnabled:false,sections:[newSection('Intro')],slashChords:[],nashvilleNumber:'1',nashvilleAccidental:'',activeId:null,editingId:null};
state.activeId=state.sections[0].id;
let selectedPaletteItem=null;
let previewZoom=Math.min(1.35,Math.max(.65,Number(localStorage.getItem('chordSheetZoom'))||1));
const storedTheme=localStorage.getItem('chordSheetTheme');
let activeTheme=storedTheme==='light'||storedTheme==='dark'?storedTheme:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
const toast=message=>{const el=$('#toast');el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2000)};
const prefersTap=()=>window.matchMedia('(max-width: 680px), (pointer: coarse)').matches;
const activeSection=()=>state.sections.find(section=>section.id===state.activeId)||state.sections[0];
function chordName(quality){return `${state.chordRoot}${quality}`}
function nashvilleName(quality){return `${state.nashvilleAccidental}${state.nashvilleNumber}${quality}`}
function nashvilleNumberLabel(number){
  const match=String(number).match(/^([1-7])([̣̇])$/u);
  if(!match)return number;
  const position=match[2]==='̣'?'low':'high';
  return `<span class="nashville-octave nashville-octave-${position}"><span class="nashville-degree">${match[1]}</span><span class="nashville-octave-dot" aria-hidden="true">•</span></span>`;
}
function chordLabel(chord){
  const match=String(chord).match(/^([♭#]?)([1-7][̣̇])(.*)$/u);
  if(match){
    const accidental=match[1]==='♭'?'<span class="chord-accidental chord-flat">♭</span>':escapeHTML(match[1]);
    return `<span class="chord-token">${accidental}${nashvilleNumberLabel(match[2])}${escapeHTML(match[3])}</span>`;
  }
  const label=escapeHTML(chord)
    .replaceAll('♭','<span class="chord-accidental chord-flat">♭</span>')
    .replaceAll('♯','<span class="chord-accidental chord-sharp">♯</span>');
  return `<span class="chord-token">${label}</span>`;
}
function transposeNote(note,semitones){
  const pitch=notePitches[note];
  return pitch===undefined?note:keys[(pitch+semitones+12)%12];
}
function isNashvilleChord(value){return /^[♭#]?[0-7][̣̇]?/u.test(String(value));}
function validChordSuffix(suffix){return /^(?:(?:maj|min|sus|add|dim|aug|omit|no)|[mM0-9#♯b♭/()+\-°ø])*$/i.test(suffix);}
function transposeChordRoot(value,semitones){
  const match=String(value).match(/^([A-G])([#♯b♭]?)(.*)$/);
  if(!match||!validChordSuffix(match[3]))return null;
  return `${transposeNote(`${match[1]}${match[2]}`,semitones)}${match[3]}`;
}
function transposeChord(value,semitones){
  const chord=String(value);
  if(isNashvilleChord(chord))return chord;
  const slash=chord.match(/^(.*)\/([A-G](?:[#♯b♭])?)$/),main=slash?slash[1]:chord,transposedMain=transposeChordRoot(main,semitones);
  if(!transposedMain)return chord;
  return slash?`${transposedMain}/${transposeNote(slash[2],semitones)}`:transposedMain;
}
function transposeSheet(semitones){
  let changed=0;
  state.sections.forEach(section=>Object.entries(section.beats).forEach(([slot,value])=>{
    const current=typeof value==='string'?value:value?.chord;
    if(!current)return;
    const next=transposeChord(current,semitones);
    if(next===current)return;
    if(typeof value==='string')section.beats[slot]=next;
    else value.chord=next;
    changed++;
  }));
  state.key=transposeNote(state.key,semitones);
  $('#keySelect').value=state.key;
  clearPaletteSelection();renderControls();renderPreview();save();
  toast(changed?`${changed} chord${changed===1?'':'s'} transposed ${semitones>0?'up':'down'} one semitone`:'No absolute chords to transpose');
}
function selectPaletteItem(element,item){
  selectedPaletteItem=item;
  document.querySelectorAll('.palette-selected').forEach(target=>target.classList.remove('palette-selected'));
  element.classList.add('palette-selected');
  if(item.type==='chord'&&isNashvilleChord(item.value)&&$('#nashvilleSelectedPreview'))$('#nashvilleSelectedPreview').innerHTML=chordLabel(item.value);
  const itemLabel=item.type==='chord'?item.value:`${durationMeta[item.value]?.label||item.value} (${durationMeta[item.value]?.symbol||''} each)`;
  toast(`${itemLabel} selected · ${prefersTap()?'tap':'click or drag it onto'} a beat`);
  if(prefersTap()){
    toggleRibbon(false);
    requestAnimationFrame(()=>document.querySelector('.preview-stage')?.scrollIntoView({behavior:'smooth',block:'start'}));
  }
}
function clearPaletteSelection(){selectedPaletteItem=null;document.querySelectorAll('.palette-selected').forEach(target=>target.classList.remove('palette-selected'))}
function bindPaletteItem(element,item){
  if(element.dataset.paletteBound)return;
  element.dataset.paletteBound='true';element.tabIndex=0;element.setAttribute('role','button');
  if(selectedPaletteItem?.type===item.type&&selectedPaletteItem?.value===item.value)element.classList.add('palette-selected');
  const select=()=>selectPaletteItem(element,item);
  element.addEventListener('click',select);
  element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select()}});
  element.addEventListener('dragstart',event=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('application/chord-sheet',JSON.stringify(item));element.classList.add('is-dragging');document.body.classList.add('is-dragging')});
  element.addEventListener('dragend',()=>{element.classList.remove('is-dragging');document.body.classList.remove('is-dragging');document.querySelectorAll('.drop-target.dragover').forEach(target=>target.classList.remove('dragover'))});
}
function bindDraggableChords(){document.querySelectorAll('.chord').forEach(chord=>bindPaletteItem(chord,{type:'chord',value:chord.dataset.chord}));}
function renderCustomChord(){const value=state.customChord.trim();$('#customChordPreview').innerHTML=value?`<span class="chord custom-chord" draggable="true" data-chord="${value}">${value}</span>`:'<span class="custom-chord-hint">Custom chord preview</span>';bindDraggableChords();}
function meterInfo(){const [top]=state.meter.split('/').map(Number);return {beats:top};}
function normalizeSection(section,meter='4/4'){
  const bars=Math.max(1,Number(section.bars)||4),beats=section.beats&&typeof section.beats==='object'?section.beats:{},lyricBeats={};
  if(section.lyricBeats&&typeof section.lyricBeats==='object')Object.entries(section.lyricBeats).forEach(([slot,text])=>{if(typeof text==='string'&&text.trim())lyricBeats[slot]=text});
  if(!Object.keys(lyricBeats).length&&typeof section.lyrics==='string'&&section.lyrics.trim()){
    const words=section.lyrics.trim().split(/\s+/),beatCount=Math.max(1,Number(String(meter).split('/')[0])||4);
    words.forEach((word,index)=>{if(index<bars*beatCount)lyricBeats[`${Math.floor(index/beatCount)}-${index%beatCount}`]=word});
  }
  return {id:section.id||crypto.randomUUID(),name:String(section.name||'Section'),lyricsEnabled:section.lyricsEnabled!==false,lyricBeats,bars,beats};
}
function renderControls(){
  $('#keySelect').innerHTML=keys.map(key=>`<option ${key===state.key?'selected':''}>${key}</option>`).join('');
  $('#chordRootPicker').innerHTML=keys.map(key=>`<button class="key ${key===state.chordRoot?'active':''}" data-root="${key}">${key}</button>`).join('');
  $('#chordBank').innerHTML=chordQualities.map(({value,label})=>`<span class="chord" draggable="true" data-chord="${chordName(value)}">${chordName(value)}</span>`).join('');
  $('#slashRoot').innerHTML=keys.map(key=>`<option value="${key}">${key}</option>`).join('');
  $('#slashQuality').innerHTML=chordQualities.map(({value,label})=>`<option value="${value}">${label}</option>`).join('');
  $('#slashBass').innerHTML=bassNotes.map(note=>`<option value="${note}">${note}</option>`).join('');
  $('#slashChordBank').innerHTML=state.slashChords.map(chord=>`<span class="chord slash-chord" draggable="true" data-chord="${chord}">${chord}</span>`).join('');
  $('#customChordInput').value=state.customChord;
  const nashvilleRow=(numbers,label,description,rowClass='')=>`<div class="nashville-row-block"><span class="nashville-row-label">${label}</span><div class="nashville-number-row ${rowClass}" aria-label="${description}">${numbers.map(number=>`<button class="nashville-key ${number===state.nashvilleNumber?'active':''}" data-number="${number}" title="${description}">${nashvilleNumberLabel(number)}</button>`).join('')}</div></div>`;
  $('#nashvilleRootPicker').innerHTML=[
    nashvilleRow(nashvilleNumbers,'Normal','Normal notation'),
    nashvilleRow(nashvilleLowerNumbers,'Lower octave','One octave lower'),
    nashvilleRow(nashvilleUpperNumbers,'Upper octave','One octave higher'),
    nashvilleRow(nashvilleZeroNumbers,'Number 0','Nashville Number 0','nashville-zero-row'),
  ].join('');
  $('#nashvilleAccidentalPicker').innerHTML=[['','♮'],['♭','♭'],['#','#']].map(([value,label])=>`<button class="nashville-accidental ${value===state.nashvilleAccidental?'active':''}" data-accidental="${value}">${label}</button>`).join('');
  $('#nashvilleChordBank').innerHTML=chordQualities.map(({value})=>`<span class="chord nashville-chord" draggable="true" data-chord="${nashvilleName(value)}">${chordLabel(nashvilleName(value))}</span>`).join('');
  $('#nashvilleSelectedPreview').innerHTML=chordLabel(nashvilleName(''));
  $('#beatBank').innerHTML=Object.entries(durationMeta).map(([value,{symbol,label,count}])=>`<span class="duration-option duration-option-${value}" draggable="true" data-duration="${value}" title="Divide one beat into ${count} equal parts"><b>${symbol}</b><span>${label}<small>${count} notes per beat</small></span></span>`).join('');
  $('#lyricsEnabled').checked=state.lyricsEnabled;
  $('#lyricsEnabledLabel').textContent=state.lyricsEnabled?'Lyrics on':'Lyrics off';
  bindDraggableChords();renderCustomChord();
  document.querySelectorAll('.duration-option').forEach(option=>bindPaletteItem(option,{type:'duration',value:option.dataset.duration}));
}
function syncEditor(){}
function beatValue(section,slot){const value=section.beats[slot];return typeof value==='string'?{chord:value,duration:null}:value||{chord:null,duration:null}}
function chordOrDot(section,slot){const value=beatValue(section,slot);return value.chord?`<span class="placed-chord" role="button" tabindex="0" title="Tap to remove" aria-label="Remove ${escapeHTML(value.chord)} chord">${chordLabel(value.chord)}</span>`:'<span class="beat-dot">·</span>'}
function lyricValue(section,slot){return typeof section.lyricBeats?.[slot]==='string'?section.lyricBeats[slot]:''}
function lyricInputHTML(section,slot){
  const text=lyricValue(section,slot),label=`Lyrics for beat ${slot.replace(':',' part ')}`;
  return `<span class="lyric-editor"><input class="lyric-input" type="text" value="${escapeHTML(text)}" placeholder="" data-section="${section.id}" data-slot="${slot}" aria-label="${label}" autocomplete="off" spellcheck="false"><span class="lyric-print">${escapeHTML(text)}</span></span>`;
}
function subdivisionTargetHTML(section,baseSlot,index,parentDuration){
  const subSlot=`${baseSlot}:${index}`,subValue=beatValue(section,subSlot);
  if(parentDuration==='half'&&subValue.duration==='half'){
    if(subValue.chord&&!section.beats[`${subSlot}.0`]){section.beats[`${subSlot}.0`]={chord:subValue.chord,duration:null};subValue.chord=null;section.beats[subSlot]=subValue}
    const children=Array.from({length:2},(_,childIndex)=>{
      const childSlot=`${subSlot}.${childIndex}`,childValue=beatValue(section,childSlot);
      return `<span class="sub-beat nested-sub-beat drop-target ${childValue.chord?'has-chord':''}" data-section="${section.id}" data-slot="${childSlot}" data-base-slot="${baseSlot}" data-parent-slot="${subSlot}" data-parent-duration="half" data-level="2">${chordOrDot(section,childSlot)}</span>`;
    }).join('');
    return `<span class="nested-beat-group" data-section="${section.id}" data-base-slot="${baseSlot}" data-split-slot="${subSlot}"><span class="nested-duration-line" data-section="${section.id}" data-split-slots="${subSlot}" title="Click to remove nested half-beat" aria-label="Remove nested half-beat"></span><span class="nested-sub-beats">${children}</span></span>`;
  }
  return `<span class="sub-beat drop-target ${subValue.chord?'has-chord':''}" data-section="${section.id}" data-slot="${subSlot}" data-base-slot="${baseSlot}" data-parent-duration="${parentDuration}" data-level="1">${chordOrDot(section,subSlot)}</span>`;
}
function beatHTML(section,bar,beat){
  const slot=`${bar}-${beat}`,value=beatValue(section,slot),showLyrics=lyricsFeatureAvailable&&state.lyricsEnabled&&section.lyricsEnabled!==false;
  if(!value.duration){
    const notation=`<span class="beat drop-target ${value.chord?'has-chord':''}" data-section="${section.id}" data-slot="${slot}" data-base-slot="${slot}" data-level="0">${chordOrDot(section,slot)}</span>`;
    return `<span class="beat-column ${showLyrics?'with-lyrics':''}"><span class="notation-cell">${notation}</span>${showLyrics?lyricInputHTML(section,slot):''}</span>`;
  }
  if(value.chord&&!section.beats[`${slot}:0`]){section.beats[`${slot}:0`]={chord:value.chord,duration:null};value.chord=null;section.beats[slot]=value}
  const count=durationMeta[value.duration]?.count||1;
  const subBeats=Array.from({length:count},(_,index)=>subdivisionTargetHTML(section,slot,index,value.duration)).join('');
  const nestedSplitSlots=value.duration==='half'?Array.from({length:count},(_,index)=>`${slot}:${index}`).filter(subSlot=>beatValue(section,subSlot).duration==='half'):[];
  const quarterPrintLine=value.duration==='quarter'?'<span class="quarter-print-line" aria-hidden="true"></span>':'';
  const lyricSlots=Array.from({length:count},(_,index)=>`${slot}:${index}`).flatMap(subSlot=>value.duration==='half'&&beatValue(section,subSlot).duration==='half'?[`${subSlot}.0`,`${subSlot}.1`]:[subSlot]);
  const subLyrics=showLyrics?`<span class="sub-lyrics" style="--lyric-leaves:${lyricSlots.length}">${lyricSlots.map(lyricSlot=>lyricInputHTML(section,lyricSlot)).join('')}</span>`:'';
  return `<span class="beat-column duration-column duration-${value.duration} ${showLyrics?'with-lyrics':''}"><span class="notation-cell"><span class="beat-group duration-${value.duration} ${nestedSplitSlots.length?'has-nested-duration':''}" data-section="${section.id}" data-base-slot="${slot}"><span class="duration-line" title="Click to remove rhythm marker"></span>${quarterPrintLine}<span class="sub-beats">${subBeats}</span></span></span>${subLyrics}</span>`;
}
function sectionHTML(section){
  const {beats}=meterInfo();
  const showLyrics=lyricsFeatureAvailable&&state.lyricsEnabled&&section.lyricsEnabled!==false,hasLyricContent=Object.values(section.lyricBeats||{}).some(text=>String(text).trim());
  const bars=Array.from({length:section.bars},(_,bar)=>`<div class="bar ${showLyrics?'has-lyrics':''}" style="--beats:${beats}" data-bar="${bar}"><button class="delete-bar" type="button" data-section="${section.id}" data-bar="${bar}" title="Delete bar ${bar+1}" aria-label="Delete bar ${bar+1}">×</button>${Array.from({length:beats},(_,beat)=>beatHTML(section,bar,beat)).join('')}</div>`);
  const batches=Array.from({length:Math.ceil(bars.length/4)},(_,index)=>`<div class="bar-batch ${showLyrics?'has-lyrics':''}">${bars.slice(index*4,index*4+4).join('')}</div>`).join('');
  const title=section.id===state.editingId?`<input class="section-title-input" data-section="${section.id}" value="${section.name}" aria-label="Section name">`:`<button class="section-title" data-section="${section.id}" title="Click to edit section name">${section.name.toUpperCase()}</button>`;
  const lyricsToggle=lyricsFeatureAvailable&&state.lyricsEnabled?`<button class="section-lyrics-toggle ${section.lyricsEnabled!==false?'active':''}" data-section="${section.id}" aria-pressed="${section.lyricsEnabled!==false}"><span aria-hidden="true">${section.lyricsEnabled!==false?'✓':'–'}</span> Lyrics ${section.lyricsEnabled!==false?'On':'Off'}</button>`:'';
  const deleteDisabled=state.sections.length===1;
  const sectionMenu=`<details class="section-menu"><summary title="Section options" aria-label="Options for ${escapeHTML(section.name)}">•••</summary><div class="section-menu-popover"><button class="delete-section" type="button" data-section="${section.id}" ${deleteDisabled?'disabled':''}>Delete section</button></div></details>`;
  return `<section class="preview-section ${section.id===state.activeId?'is-active':''} ${hasLyricContent?'has-lyric-content':''}" data-section="${section.id}"><div class="section-preview-heading"><div>${title}</div><div class="section-tools">${lyricsToggle}<span class="bar-caption">${section.bars} ${section.bars===1?'bar':'bars'} · ${beats} beats per bar</span><button class="text-button add-bar" data-section="${section.id}">+ Add 1 bar</button>${sectionMenu}</div></div><div class="bar-grid">${batches}</div></section>`;
}
function slotBarIndex(slot){const match=String(slot).match(/^(\d+)-/);return match?Number(match[1]):-1}
function barHasContent(section,bar){
  return Object.keys(section.beats||{}).some(slot=>slotBarIndex(slot)===bar)||Object.entries(section.lyricBeats||{}).some(([slot,text])=>slotBarIndex(slot)===bar&&String(text).trim());
}
function removeBar(section,bar){
  const shiftSlots=source=>Object.fromEntries(Object.entries(source||{}).flatMap(([slot,value])=>{
    const match=slot.match(/^(\d+)(-.+)$/);if(!match)return [[slot,value]];
    const index=Number(match[1]);if(index===bar)return [];
    return [[`${index>bar?index-1:index}${match[2]}`,value]];
  }));
  section.beats=shiftSlots(section.beats);section.lyricBeats=shiftSlots(section.lyricBeats);section.bars=Math.max(1,section.bars-1);
}
function setLyric(section,slot,text){
  section.lyricBeats??={};
  if(text.trim())section.lyricBeats[slot]=text;
  else delete section.lyricBeats[slot];
}
function prepareLyricsForDuration(section,baseSlot,nextDuration){
  section.lyricBeats??={};
  const currentDuration=beatValue(section,baseSlot).duration,baseText=lyricValue(section,baseSlot);
  if(!currentDuration&&baseText){setLyric(section,`${baseSlot}:0`,baseText);delete section.lyricBeats[baseSlot]}
  if(currentDuration==='quarter'&&nextDuration==='half'){
    const trailing=[1,2,3].map(index=>lyricValue(section,`${baseSlot}:${index}`)).filter(Boolean).join(' ');
    setLyric(section,`${baseSlot}:1`,trailing);
    delete section.lyricBeats[`${baseSlot}:2`];delete section.lyricBeats[`${baseSlot}:3`];
  }
}
function placePaletteItem(section,beat,item){
  if(!item||!section)return false;
  if(item.type==='chord'){
    const value=beatValue(section,beat.dataset.slot);value.chord=item.value;section.beats[beat.dataset.slot]=value;
  }else if(item.type==='duration'){
    const level=Number(beat.dataset.level||0);
    if(level>=2){toast('Rhythm subdivisions are limited to two levels');return false}
    if(level===1&&item.value==='half'&&beat.dataset.parentDuration==='half'){
      const splitSlot=beat.dataset.slot,value=beatValue(section,splitSlot),lyric=lyricValue(section,splitSlot);
      if(value.chord){section.beats[`${splitSlot}.0`]={chord:value.chord,duration:null};value.chord=null}
      value.duration='half';section.beats[splitSlot]=value;
      if(lyric){setLyric(section,`${splitSlot}.0`,lyric);delete section.lyricBeats[splitSlot]}
      state.activeId=section.id;return true;
    }
    const baseSlot=beat.dataset.baseSlot;prepareLyricsForDuration(section,baseSlot,item.value);const value=beatValue(section,baseSlot);
    if(value.chord){section.beats[`${baseSlot}:0`]={chord:value.chord,duration:null};value.chord=null}
    value.duration=item.value;section.beats[baseSlot]=value;
  }else return false;
  state.activeId=section.id;return true;
}
function flashDropTarget(sectionId,slot){requestAnimationFrame(()=>{const target=[...document.querySelectorAll('.drop-target')].find(item=>item.dataset.section===sectionId&&item.dataset.slot===slot);if(!target)return;target.classList.add('drop-success');setTimeout(()=>target.classList.remove('drop-success'),450)})}
function bindPreview(){
  document.querySelectorAll('.drop-target').forEach(beat=>{
    beat.addEventListener('dragover',event=>{event.preventDefault();event.dataTransfer.dropEffect='copy';beat.classList.add('dragover')});
    beat.addEventListener('dragleave',()=>beat.classList.remove('dragover'));
    beat.addEventListener('drop',event=>{event.preventDefault();event.stopPropagation();let item;try{item=JSON.parse(event.dataTransfer.getData('application/chord-sheet'))}catch{}const section=state.sections.find(item=>item.id===beat.dataset.section),slot=beat.dataset.slot;beat.classList.remove('dragover');document.body.classList.remove('is-dragging');if(!placePaletteItem(section,beat,item))return;syncEditor();renderPreview();save();flashDropTarget(section.id,slot)});
    beat.addEventListener('click',event=>{if(!selectedPaletteItem||event.target.closest('.placed-chord,.duration-line,.nested-duration-line,.lyric-input'))return;event.stopPropagation();const section=state.sections.find(item=>item.id===beat.dataset.section),slot=beat.dataset.slot;if(!placePaletteItem(section,beat,selectedPaletteItem))return;if(prefersTap())clearPaletteSelection();syncEditor();renderPreview();save();flashDropTarget(section.id,slot)});
  });
  document.querySelectorAll('.placed-chord').forEach(chord=>{
    const removeOrReplace=event=>{
      event.stopPropagation();
      const beat=chord.closest('.drop-target'),section=state.sections.find(item=>item.id===beat.dataset.section);
      if(selectedPaletteItem){
        if(!placePaletteItem(section,beat,selectedPaletteItem))return;
        if(prefersTap())clearPaletteSelection();syncEditor();renderPreview();save();flashDropTarget(section.id,beat.dataset.slot);return;
      }
      delete section.beats[beat.dataset.slot];renderPreview();save();toast('Chord removed');
    };
    chord.addEventListener('click',removeOrReplace);
    chord.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();removeOrReplace(event)}});
  });
  document.querySelectorAll('.nested-duration-line').forEach(line=>line.addEventListener('click',event=>{
    event.stopPropagation();
    const section=state.sections.find(item=>item.id===line.dataset.section),splitSlots=(line.dataset.splitSlots||'').split('|').filter(Boolean);
    if(!section)return;
    splitSlots.forEach(splitSlot=>{
      const childSlots=Object.keys(section.beats).filter(slot=>slot.startsWith(`${splitSlot}.`)).sort();
      const firstChord=childSlots.map(slot=>beatValue(section,slot).chord).find(Boolean)||null;
      const lyricSlots=Object.keys(section.lyricBeats||{}).filter(slot=>slot.startsWith(`${splitSlot}.`)).sort();
      const mergedLyrics=lyricSlots.map(slot=>lyricValue(section,slot)).filter(Boolean).join(' ');
      childSlots.forEach(slot=>delete section.beats[slot]);lyricSlots.forEach(slot=>delete section.lyricBeats[slot]);
      if(firstChord)section.beats[splitSlot]={chord:firstChord,duration:null};else delete section.beats[splitSlot];
      setLyric(section,splitSlot,mergedLyrics);
    });
    state.activeId=section.id;renderPreview();save();toast('Nested half-beat subdivision removed');
  }));
  document.querySelectorAll('.duration-line').forEach(line=>line.addEventListener('click',event=>{
    event.stopPropagation();
    const group=line.closest('.beat-group'),section=state.sections.find(item=>item.id===group.dataset.section),baseSlot=group.dataset.baseSlot;
    if(!section)return;
    const descendantSlots=Object.keys(section.beats).filter(slot=>slot.startsWith(`${baseSlot}:`)).sort();
    const firstChord=descendantSlots.map(slot=>beatValue(section,slot).chord).find(Boolean)||null;
    const lyricSlots=Object.keys(section.lyricBeats||{}).filter(slot=>slot.startsWith(`${baseSlot}:`)).sort();
    const mergedLyrics=lyricSlots.map(slot=>lyricValue(section,slot)).filter(Boolean).join(' ');
    descendantSlots.forEach(slot=>delete section.beats[slot]);
    lyricSlots.forEach(slot=>delete section.lyricBeats[slot]);
    if(firstChord)section.beats[baseSlot]={chord:firstChord,duration:null};
    else delete section.beats[baseSlot];
    setLyric(section,baseSlot,mergedLyrics);
    state.activeId=section.id;renderPreview();save();toast('Rhythm marker removed');
  }));
  document.querySelectorAll('.lyric-input').forEach(input=>{
    input.addEventListener('click',event=>event.stopPropagation());
    input.addEventListener('input',()=>{const section=state.sections.find(item=>item.id===input.dataset.section);if(!section)return;setLyric(section,input.dataset.slot,input.value);state.activeId=section.id;save()});
    input.addEventListener('blur',()=>{const section=state.sections.find(item=>item.id===input.dataset.section);if(!section)return;input.value=input.value.trim();setLyric(section,input.dataset.slot,input.value);save()});
    input.addEventListener('keydown',event=>{
      if(event.key==='Escape'){input.blur();return}
      if(event.key!=='Enter')return;
      event.preventDefault();
      const inputs=[...document.querySelectorAll('.lyric-input')],index=inputs.indexOf(input),target=inputs[index+(event.shiftKey?-1:1)];
      target?.focus();target?.select();
    });
    input.addEventListener('paste',event=>{
      const pasted=event.clipboardData?.getData('text')||'',words=pasted.trim().split(/\s+/).filter(Boolean);
      if(words.length<2)return;
      event.preventDefault();
      const inputs=[...document.querySelectorAll('.lyric-input')],start=inputs.indexOf(input),available=inputs.slice(start);
      available.forEach((field,index)=>{if(index>=words.length)return;const section=state.sections.find(item=>item.id===field.dataset.section);const value=index===available.length-1&&words.length>available.length?words.slice(index).join(' '):words[index];field.value=value;if(section)setLyric(section,field.dataset.slot,value)});
      save();
      const next=available[Math.min(words.length,available.length)-1];next?.focus();next?.select();toast(`${words.length} words distributed across beats`);
    });
  });
  document.querySelectorAll('.section-lyrics-toggle').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();const section=state.sections.find(item=>item.id===button.dataset.section);if(!section)return;section.lyricsEnabled=section.lyricsEnabled===false;state.activeId=section.id;renderPreview();save();toast(`Lyrics ${section.lyricsEnabled?'enabled':'hidden'} for ${section.name}`)}));
  document.querySelectorAll('.add-bar').forEach(button=>button.addEventListener('click',()=>{const section=state.sections.find(item=>item.id===button.dataset.section);if(!section)return;section.bars+=1;state.activeId=section.id;syncEditor();renderPreview();save();toast(`1 bar added to ${section.name}`)}));
  document.querySelectorAll('.delete-bar').forEach(button=>button.addEventListener('click',event=>{
    event.stopPropagation();const section=state.sections.find(item=>item.id===button.dataset.section),bar=Number(button.dataset.bar);if(!section)return;
    if(section.bars<=1){toast('At least one bar must remain');return}
    if(barHasContent(section,bar)&&!window.confirm(`Bar ${bar+1} contains chords or lyrics. Delete this bar?`))return;
    removeBar(section,bar);state.activeId=section.id;renderPreview();save();toast(`Bar ${bar+1} deleted`);
  }));
  document.querySelectorAll('.delete-section').forEach(button=>button.addEventListener('click',event=>{
    event.stopPropagation();if(state.sections.length<=1){toast('At least one section must remain');return}
    const index=state.sections.findIndex(item=>item.id===button.dataset.section),section=state.sections[index];if(!section)return;
    const hasContent=Object.keys(section.beats||{}).length||Object.values(section.lyricBeats||{}).some(text=>String(text).trim());
    if(hasContent&&!window.confirm(`Section “${section.name}” contains chords or lyrics. Delete this section?`))return;
    state.sections.splice(index,1);state.activeId=state.sections[Math.min(index,state.sections.length-1)].id;state.editingId=null;syncEditor();renderPreview();save();toast(`Section “${section.name}” deleted`);
  }));
  document.querySelectorAll('.section-menu').forEach(menu=>menu.addEventListener('click',event=>event.stopPropagation()));
  document.querySelectorAll('.section-title').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();state.activeId=button.dataset.section;state.editingId=button.dataset.section;syncEditor();renderPreview();requestAnimationFrame(()=>$('.section-title-input')?.focus())}));
  document.querySelectorAll('.section-title-input').forEach(input=>{
    const commit=()=>{const section=state.sections.find(item=>item.id===input.dataset.section);section.name=input.value.trim()||'Untitled section';state.activeId=section.id;state.editingId=null;syncEditor();renderPreview();save()};
    input.addEventListener('blur',commit);input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();input.blur()}if(event.key==='Escape'){state.editingId=null;renderPreview()}});input.addEventListener('click',event=>event.stopPropagation());
  });
  document.querySelectorAll('.preview-section').forEach(el=>el.addEventListener('click',()=>{state.activeId=el.dataset.section;syncEditor();renderPreview()}));
}
function updateViewportOverflow(){
  const viewport=$('#previewViewport'),stage=document.querySelector('.preview-stage');if(!viewport||!stage)return;
  const overflowing=viewport.scrollWidth>viewport.clientWidth+3,atEnd=viewport.scrollLeft+viewport.clientWidth>=viewport.scrollWidth-8;
  stage.classList.toggle('is-overflowing',overflowing);stage.classList.toggle('at-scroll-end',atEnd);
}
function setPreviewZoom(value,{persist=true}={}){
  const minimum=prefersTap()?1:.65;
  previewZoom=Math.min(1.35,Math.max(minimum,Math.round(value*20)/20));
  $('#previewCard').style.zoom=previewZoom;$('#zoomValue').textContent=`${Math.round(previewZoom*100)}%`;
  $('#zoomOut').disabled=previewZoom<=minimum;$('#zoomIn').disabled=previewZoom>=1.35;
  if(persist)localStorage.setItem('chordSheetZoom',String(previewZoom));
  requestAnimationFrame(updateViewportOverflow);
}
function fitPreview(){
  const viewport=$('#previewViewport'),card=$('#previewCard');if(!viewport||!card)return;
  card.style.zoom=1;const available=Math.max(320,viewport.clientWidth-48),ratio=Math.min(1,available/card.offsetWidth);setPreviewZoom(ratio);viewport.scrollLeft=0;
}
function renderPreview(){
  const artist=$('#artist').value||'Artist / Composer';
  $('#previewTitle').textContent=$('#songTitle').value||'Song Title';$('#previewArtist').innerHTML=`<span class="artist-label">Created by:</span> <em class="artist-value">${escapeHTML(artist)}</em>`;$('#previewKey').textContent=state.key;$('#previewMeter').textContent=state.meter;
  $('#previewHint').textContent=lyricsFeatureAvailable&&state.lyricsEnabled
    ?`${prefersTap()?'Select and tap':'Drag'} chords onto beats, then enter lyrics in the row below.`
    :`${prefersTap()?'Select an item above, then tap':'Drag a chord from the toolbar onto'} a beat.`;
  $('#sectionsPreview').innerHTML=state.sections.map(sectionHTML).join('');bindPreview();requestAnimationFrame(updateViewportOverflow);
}
function projectData(){return {format:'chord-sheet',version:2,title:$('#songTitle').value,artist:$('#artist').value,key:state.key,chordRoot:state.chordRoot,customChord:state.customChord,meter:state.meter,lyricsEnabled:state.lyricsEnabled,sections:state.sections,slashChords:state.slashChords,nashvilleNumber:state.nashvilleNumber,nashvilleAccidental:state.nashvilleAccidental}}
// Project content intentionally lives in memory only. Use Export .file for persistence.
function save(){}
function safeFileName(value){return (value||'worship-notation-score').trim().replace(/[^a-z0-9-_]+/gi,'-').replace(/^-|-$/g,'')||'worship-notation-score'}
function downloadProject(){const defaultName=safeFileName($('#songTitle').value),requestedName=window.prompt('File name:',defaultName);if(requestedName===null)return;const content=JSON.stringify(projectData(),null,2),file=new Blob([content],{type:'application/json'}),url=URL.createObjectURL(file),link=document.createElement('a');link.href=url;link.download=`${safeFileName(requestedName||defaultName)}.chordsheet.json`;document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);toast('WorshipNotationScore file exported')}
function applyProject(project){
  if(!project||project.format!=='chord-sheet'||!Array.isArray(project.sections))throw new Error('Unrecognized file format');
  const meter=['2/4','3/4','4/4','6/8'].includes(project.meter)?project.meter:'4/4';
  const sections=project.sections.filter(section=>section&&typeof section==='object').map(section=>normalizeSection(section,meter));
  if(!sections.length)throw new Error('The file does not contain any sections');
  const lyricsEnabled=typeof project.lyricsEnabled==='boolean'?project.lyricsEnabled:sections.some(section=>Object.keys(section.lyricBeats).length>0);
  state={key:keys.includes(project.key)?project.key:'C',chordRoot:keys.includes(project.chordRoot)?project.chordRoot:'C',customChord:typeof project.customChord==='string'?project.customChord:'',meter,lyricsEnabled,sections,slashChords:Array.isArray(project.slashChords)?project.slashChords.filter(chord=>typeof chord==='string'):[],nashvilleNumber:nashvilleChoices.includes(project.nashvilleNumber)?project.nashvilleNumber:'1',nashvilleAccidental:['','♭','#'].includes(project.nashvilleAccidental)?project.nashvilleAccidental:'',activeId:sections[0].id,editingId:null};
  clearPaletteSelection();
  $('#songTitle').value=String(project.title||'Song Title');$('#artist').value=String(project.artist||'Artist / Composer');$('#timeSignature').value=state.meter;syncEditor();renderControls();renderPreview();save();
}
function updateActive(field,value){activeSection()[field]=value;renderPreview();save()}
function beginMetaEdit(kind){
  const config={title:{target:'#previewTitle',source:'#songTitle',type:'text'},artist:{target:'#previewArtist',source:'#artist',type:'text'},key:{target:'#previewKey',source:'#keySelect',type:'select',options:keys},meter:{target:'#previewMeter',source:'#timeSignature',type:'select',options:['2/4','3/4','4/4','6/8']}}[kind];
  const target=$(config.target),source=$(config.source);if(target.querySelector('input,select'))return;
  const editor=document.createElement(config.type==='select'?'select':'input');editor.className='preview-inline-input';
  if(config.type==='select'){editor.innerHTML=config.options.map(option=>`<option value="${option}">${option}</option>`).join('');editor.value=source.value}
  else {editor.type='text';editor.value=source.value}
  let committed=false;
  const commit=()=>{if(committed)return;committed=true;source.value=editor.value;target.classList.remove('is-editing');if(kind==='key')state.key=editor.value;if(kind==='meter')state.meter=editor.value;renderControls();renderPreview();save()};
  target.textContent='';target.classList.add('is-editing');target.append(editor);editor.focus();editor.select?.();editor.addEventListener('blur',commit,{once:true});editor.addEventListener('change',()=>config.type==='select'?commit():editor.blur());editor.addEventListener('keydown',event=>{if(event.key==='Enter')editor.blur();if(event.key==='Escape'){target.classList.remove('is-editing');renderPreview()}});
}
const ribbonLabels={chord:'Chord palette',slash:'Slash chord builder',nashville:'Nashville Number System',rhythm:'Rhythm values',lyrics:'Lyrics settings'};
function activateRibbon(tab,{focus=false}={}){
  const selected=tab.dataset.ribbonTab;
  document.querySelectorAll('.ribbon-tab').forEach(item=>{const active=item===tab;item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));item.tabIndex=active?0:-1});
  document.querySelectorAll('.ribbon-panel').forEach(panel=>{const active=panel.dataset.ribbonPanel===selected;panel.classList.toggle('active',active);panel.hidden=!active});
  $('#activeToolLabel').textContent=ribbonLabels[selected]||'Arrangement tools';
  if(prefersTap())tab.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'});
  if($('#ribbonToggle').getAttribute('aria-expanded')==='false')toggleRibbon(true);
  if(focus)tab.focus();
}
function toggleRibbon(forceExpanded){
  const editor=document.querySelector('.editor-card'),currentlyExpanded=!editor.classList.contains('is-collapsed'),expanded=typeof forceExpanded==='boolean'?forceExpanded:!currentlyExpanded;
  editor.classList.toggle('is-collapsed',!expanded);$('#ribbonToggle').setAttribute('aria-expanded',String(expanded));$('#ribbonToggle').title=expanded?'Collapse toolbar':'Expand toolbar';
  $('#ribbonToggle').querySelector('.sr-only').textContent=expanded?'Collapse toolbar':'Expand toolbar';
  requestAnimationFrame(updateViewportOverflow);
}
function applyTheme(theme,{persist=true,announce=false}={}){
  activeTheme=theme==='dark'?'dark':'light';
  document.documentElement.dataset.theme=activeTheme;
  document.documentElement.style.colorScheme=activeTheme;
  const toggle=$('#themeToggle'),dark=activeTheme==='dark';
  toggle.setAttribute('aria-pressed',String(dark));toggle.title=`Switch to ${dark?'light':'dark'} mode`;
  toggle.querySelector('.theme-toggle-icon').textContent=dark?'☀':'☾';toggle.querySelector('.theme-toggle-label').textContent=dark?'Light':'Dark';
  document.querySelector('meta[name="theme-color"]').content=dark?'#101110':'#1f704a';
  if(persist)localStorage.setItem('chordSheetTheme',activeTheme);
  if(announce)toast(`${dark?'Dark':'Light'} mode enabled`);
}
$('#keySelect').addEventListener('change',event=>{state.key=event.target.value;renderPreview();save()});
$('#chordRootPicker').addEventListener('click',event=>{if(!event.target.dataset.root)return;clearPaletteSelection();state.chordRoot=event.target.dataset.root;renderControls();save()});
$('#customChordInput').addEventListener('input',event=>{clearPaletteSelection();state.customChord=event.target.value;renderCustomChord();save()});
$('#addSlashBtn').addEventListener('click',()=>{const chord=`${$('#slashRoot').value}${$('#slashQuality').value}/${$('#slashBass').value}`;if(!state.slashChords.includes(chord))state.slashChords.push(chord);renderControls();save();toast(`${chord} is ready to drag`)});
$('#nashvilleRootPicker').addEventListener('click',event=>{const button=event.target.closest('.nashville-key');if(!button)return;clearPaletteSelection();state.nashvilleNumber=button.dataset.number;renderControls();save()});
$('#nashvilleAccidentalPicker').addEventListener('click',event=>{if(event.target.dataset.accidental===undefined)return;clearPaletteSelection();state.nashvilleAccidental=event.target.dataset.accidental;renderControls();save()});
$('#transposeDown').addEventListener('click',()=>transposeSheet(-1));
$('#transposeUp').addEventListener('click',()=>transposeSheet(1));
$('#lyricsEnabled').addEventListener('change',event=>{state.lyricsEnabled=event.target.checked;renderControls();renderPreview();save();toast(state.lyricsEnabled?'Lyrics mode enabled':'Lyrics hidden from score')});
document.querySelectorAll('.ribbon-tab').forEach(tab=>{
  tab.addEventListener('click',()=>activateRibbon(tab));
  tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=[...document.querySelectorAll('.ribbon-tab:not([hidden])')],index=tabs.indexOf(tab);const next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];activateRibbon(next,{focus:true})});
});
$('#ribbonToggle').addEventListener('click',()=>toggleRibbon());
$('#themeToggle').addEventListener('click',()=>applyTheme(activeTheme==='dark'?'light':'dark',{announce:true}));
$('#zoomOut').addEventListener('click',()=>setPreviewZoom(previewZoom-.1));
$('#zoomIn').addEventListener('click',()=>setPreviewZoom(previewZoom+.1));
$('#fitPreview').addEventListener('click',fitPreview);
$('#previewViewport').addEventListener('scroll',updateViewportOverflow,{passive:true});
$('#previewTitle').addEventListener('click',event=>{if(!event.target.matches('input'))beginMetaEdit('title')});$('#previewArtist').addEventListener('click',event=>{if(!event.target.matches('input'))beginMetaEdit('artist')});$('#previewKey').addEventListener('click',event=>{if(!event.target.matches('select'))beginMetaEdit('key')});$('#previewMeter').addEventListener('click',event=>{if(!event.target.matches('select'))beginMetaEdit('meter')});
$('#timeSignature').addEventListener('change',event=>{state.meter=event.target.value;renderPreview();save();toast(`Preview updated to ${state.meter}`)});
$('#songTitle').addEventListener('input',()=>{renderPreview();save()});$('#artist').addEventListener('input',()=>{renderPreview();save()});
$('#addSectionBtn').addEventListener('click',()=>{const section=newSection(`Section ${state.sections.length+1}`);state.sections.push(section);state.activeId=section.id;syncEditor();renderPreview();save();toast('New section added')});
$('#resetSheetBtn').addEventListener('click',()=>{if(!window.confirm('Reset the entire score to its default state?'))return;const firstSection=newSection('Intro');state={key:'C',chordRoot:'C',customChord:'',meter:'4/4',lyricsEnabled:false,sections:[firstSection],slashChords:[],nashvilleNumber:'1',nashvilleAccidental:'',activeId:firstSection.id,editingId:null};selectedPaletteItem=null;$('#songTitle').value='Song Title';$('#artist').value='Artist / Composer';$('#timeSignature').value='4/4';syncEditor();renderControls();renderPreview();save();toast('Score reset to default')});
$('#saveBtn').addEventListener('click',downloadProject);
$('#projectFileInput').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;try{applyProject(JSON.parse(await file.text()));toast('Score loaded and ready to edit')}catch(error){toast('Invalid file or not a WorshipNotationScore project')}finally{event.target.value=''}});
$('#exportBtn').addEventListener('click',()=>{
  renderPreview();
  const viewport=$('#previewViewport'),root=document.documentElement,pagePosition={x:window.scrollX,y:window.scrollY},canvasPosition={x:viewport.scrollLeft,y:viewport.scrollTop},scrollBehavior=root.style.scrollBehavior;
  root.style.scrollBehavior='auto';
  window.scrollTo(0,0);viewport.scrollTo(0,0);
  requestAnimationFrame(()=>{
    window.print();
    window.scrollTo(pagePosition.x,pagePosition.y);viewport.scrollTo(canvasPosition.x,canvasPosition.y);
    root.style.scrollBehavior=scrollBehavior;
  });
});
window.addEventListener('scroll',()=>{const editor=document.querySelector('.editor-card');editor.classList.toggle('is-scrolled',editor.getBoundingClientRect().top<=80)},{passive:true});
window.addEventListener('resize',updateViewportOverflow,{passive:true});
document.addEventListener('keydown',event=>{
  const editing=event.target.matches('input,textarea,select,[contenteditable="true"]');
  if((event.ctrlKey||event.metaKey)&&['+','=','-','0'].includes(event.key)){event.preventDefault();if(event.key==='-')setPreviewZoom(previewZoom-.1);else if(event.key==='0')fitPreview();else setPreviewZoom(previewZoom+.1);return}
  if(event.altKey&&!editing&&/^[1-5]$/.test(event.key)){event.preventDefault();const tab=document.querySelectorAll('.ribbon-tab:not([hidden])')[Number(event.key)-1];if(tab)activateRibbon(tab,{focus:true});return}
  if(event.key==='Escape'&&!editing&&$('#ribbonToggle').getAttribute('aria-expanded')==='true')toggleRibbon(false);
});
localStorage.removeItem('chordSheetPreview');
applyTheme(activeTheme,{persist:false});
syncEditor();renderControls();renderPreview();activateRibbon(document.querySelector('.ribbon-tab.active'));setPreviewZoom(previewZoom,{persist:false});
if('ResizeObserver'in window)new ResizeObserver(updateViewportOverflow).observe($('#previewViewport'));
