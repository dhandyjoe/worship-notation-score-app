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
const lyricsFeatureAvailable=false; // Temporary: preserve lyric data while hiding the unfinished UI.
const $=selector=>document.querySelector(selector);
const escapeHTML=value=>String(value??'').replace(/[&<>"]/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[character]));
const newSection=(name='Intro')=>({id:crypto.randomUUID(),name,lyricsEnabled:true,lyricBeats:{},bars:4,beats:{}});
let state={key:'C',chordRoot:'C',customChord:'',meter:'4/4',lyricsEnabled:false,sections:[newSection('Intro')],slashChords:[],nashvilleNumber:'1',nashvilleAccidental:'',activeId:null,editingId:null};
state.activeId=state.sections[0].id;
let selectedPaletteItem=null;
let previewZoom=Math.min(1.35,Math.max(.65,Number(localStorage.getItem('chordSheetZoom'))||1));
const toast=message=>{const el=$('#toast');el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2000)};
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
  toast(changed?`${changed} chord ditranspose ${semitones>0?'naik':'turun'} ½ nada`:'Tidak ada chord absolut untuk ditranspose');
}
function selectPaletteItem(element,item){
  selectedPaletteItem=item;
  document.querySelectorAll('.palette-selected').forEach(target=>target.classList.remove('palette-selected'));
  element.classList.add('palette-selected');
  if(item.type==='chord'&&isNashvilleChord(item.value)&&$('#nashvilleSelectedPreview'))$('#nashvilleSelectedPreview').innerHTML=chordLabel(item.value);
  toast(`${item.type==='chord'?item.value:item.value==='half'?'½ ketuk':'¼ ketuk'} dipilih · klik atau tarik ke titik ketukan`);
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
function renderCustomChord(){const value=state.customChord.trim();$('#customChordPreview').innerHTML=value?`<span class="chord custom-chord" draggable="true" data-chord="${value}">${value}</span>`:'<span class="custom-chord-hint">Preview chord custom</span>';bindDraggableChords();}
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
    nashvilleRow(nashvilleNumbers,'Normal','Notasi normal'),
    nashvilleRow(nashvilleLowerNumbers,'Oktaf bawah','Satu oktaf di bawah'),
    nashvilleRow(nashvilleUpperNumbers,'Oktaf atas','Satu oktaf di atas'),
    nashvilleRow(nashvilleZeroNumbers,'Angka 0','Nashville Number 0','nashville-zero-row'),
  ].join('');
  $('#nashvilleAccidentalPicker').innerHTML=[['','♮'],['♭','♭'],['#','#']].map(([value,label])=>`<button class="nashville-accidental ${value===state.nashvilleAccidental?'active':''}" data-accidental="${value}">${label}</button>`).join('');
  $('#nashvilleChordBank').innerHTML=chordQualities.map(({value})=>`<span class="chord nashville-chord" draggable="true" data-chord="${nashvilleName(value)}">${chordLabel(nashvilleName(value))}</span>`).join('');
  $('#nashvilleSelectedPreview').innerHTML=chordLabel(nashvilleName(''));
  $('#beatBank').innerHTML='<span class="duration-option" draggable="true" data-duration="half"><b>½</b> Setengah ketuk</span><span class="duration-option" draggable="true" data-duration="quarter"><b>¼</b> Seperempat ketuk</span>';
  $('#lyricsEnabled').checked=state.lyricsEnabled;
  $('#lyricsEnabledLabel').textContent=state.lyricsEnabled?'Lirik aktif':'Tanpa lirik';
  bindDraggableChords();renderCustomChord();
  document.querySelectorAll('.duration-option').forEach(option=>bindPaletteItem(option,{type:'duration',value:option.dataset.duration}));
}
function syncEditor(){}
function beatValue(section,slot){const value=section.beats[slot];return typeof value==='string'?{chord:value,duration:null}:value||{chord:null,duration:null}}
function chordOrDot(section,slot){const value=beatValue(section,slot);return value.chord?`<span class="placed-chord" title="Klik untuk hapus">${chordLabel(value.chord)}</span>`:'<span class="beat-dot">·</span>'}
function lyricValue(section,slot){return typeof section.lyricBeats?.[slot]==='string'?section.lyricBeats[slot]:''}
function lyricInputHTML(section,slot){
  const text=lyricValue(section,slot),label=`Lirik pada ketukan ${slot.replace(':',' bagian ')}`;
  return `<span class="lyric-editor"><input class="lyric-input" type="text" value="${escapeHTML(text)}" placeholder="Lirik" data-section="${section.id}" data-slot="${slot}" aria-label="${label}" autocomplete="off" spellcheck="false"><span class="lyric-print">${escapeHTML(text)}</span></span>`;
}
function beatHTML(section,bar,beat){
  const slot=`${bar}-${beat}`,value=beatValue(section,slot),showLyrics=lyricsFeatureAvailable&&state.lyricsEnabled&&section.lyricsEnabled!==false;
  if(!value.duration){
    const notation=`<span class="beat drop-target ${value.chord?'has-chord':''}" data-section="${section.id}" data-slot="${slot}" data-base-slot="${slot}">${chordOrDot(section,slot)}</span>`;
    return `<span class="beat-column ${showLyrics?'with-lyrics':''}"><span class="notation-cell">${notation}</span>${showLyrics?lyricInputHTML(section,slot):''}</span>`;
  }
  if(value.chord&&!section.beats[`${slot}:0`]){section.beats[`${slot}:0`]={chord:value.chord,duration:null};value.chord=null;section.beats[slot]=value}
  const count=value.duration==='half'?2:4;
  const subBeats=Array.from({length:count},(_,index)=>{const subSlot=`${slot}:${index}`,subValue=beatValue(section,subSlot);return `<span class="sub-beat drop-target ${subValue.chord?'has-chord':''}" data-section="${section.id}" data-slot="${subSlot}" data-base-slot="${slot}">${chordOrDot(section,subSlot)}</span>`}).join('');
  const subLyrics=showLyrics?`<span class="sub-lyrics">${Array.from({length:count},(_,index)=>lyricInputHTML(section,`${slot}:${index}`)).join('')}</span>`:'';
  return `<span class="beat-column duration-column duration-${value.duration} ${showLyrics?'with-lyrics':''}"><span class="notation-cell"><span class="beat-group duration-${value.duration}" data-section="${section.id}" data-base-slot="${slot}"><span class="duration-line" title="Klik untuk hapus penanda ketukan"></span><span class="sub-beats">${subBeats}</span></span></span>${subLyrics}</span>`;
}
function sectionHTML(section){
  const {beats}=meterInfo();
  const showLyrics=lyricsFeatureAvailable&&state.lyricsEnabled&&section.lyricsEnabled!==false,hasLyricContent=Object.values(section.lyricBeats||{}).some(text=>String(text).trim());
  const bars=Array.from({length:section.bars},(_,bar)=>`<div class="bar ${showLyrics?'has-lyrics':''}" style="--beats:${beats}" data-bar="${bar}"><button class="delete-bar" type="button" data-section="${section.id}" data-bar="${bar}" title="Hapus bar ${bar+1}" aria-label="Hapus bar ${bar+1}">×</button>${Array.from({length:beats},(_,beat)=>beatHTML(section,bar,beat)).join('')}</div>`);
  const batches=Array.from({length:Math.ceil(bars.length/4)},(_,index)=>`<div class="bar-batch ${showLyrics?'has-lyrics':''}">${bars.slice(index*4,index*4+4).join('')}</div>`).join('');
  const title=section.id===state.editingId?`<input class="section-title-input" data-section="${section.id}" value="${section.name}" aria-label="Nama section">`:`<button class="section-title" data-section="${section.id}" title="Klik untuk mengganti nama section">${section.name.toUpperCase()}</button>`;
  const lyricsToggle=lyricsFeatureAvailable&&state.lyricsEnabled?`<button class="section-lyrics-toggle ${section.lyricsEnabled!==false?'active':''}" data-section="${section.id}" aria-pressed="${section.lyricsEnabled!==false}"><span aria-hidden="true">${section.lyricsEnabled!==false?'✓':'–'}</span> Lirik ${section.lyricsEnabled!==false?'On':'Off'}</button>`:'';
  const deleteDisabled=state.sections.length===1;
  const sectionMenu=`<details class="section-menu"><summary title="Opsi section" aria-label="Opsi untuk ${escapeHTML(section.name)}">•••</summary><div class="section-menu-popover"><button class="delete-section" type="button" data-section="${section.id}" ${deleteDisabled?'disabled':''}>Hapus section</button></div></details>`;
  return `<section class="preview-section ${section.id===state.activeId?'is-active':''} ${hasLyricContent?'has-lyric-content':''}" data-section="${section.id}"><div class="section-preview-heading"><div>${title}</div><div class="section-tools">${lyricsToggle}<span class="bar-caption">${section.bars} bar · ${beats} ketuk per bar</span><button class="text-button add-bar" data-section="${section.id}">+ Add 4 bar</button>${sectionMenu}</div></div><div class="bar-grid">${batches}</div></section>`;
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
    beat.addEventListener('click',event=>{if(!selectedPaletteItem||event.target.closest('.placed-chord,.duration-line,.lyric-input'))return;event.stopPropagation();const section=state.sections.find(item=>item.id===beat.dataset.section),slot=beat.dataset.slot;if(!placePaletteItem(section,beat,selectedPaletteItem))return;syncEditor();renderPreview();save();flashDropTarget(section.id,slot)});
  });
  document.querySelectorAll('.placed-chord').forEach(chord=>chord.addEventListener('click',()=>{const beat=chord.closest('.drop-target'),section=state.sections.find(item=>item.id===beat.dataset.section);delete section.beats[beat.dataset.slot];renderPreview();save()}));
  document.querySelectorAll('.duration-line').forEach(line=>line.addEventListener('click',event=>{
    event.stopPropagation();
    const group=line.closest('.beat-group'),section=state.sections.find(item=>item.id===group.dataset.section),baseSlot=group.dataset.baseSlot;
    if(!section)return;
    const duration=beatValue(section,baseSlot).duration;
    const firstChord=duration?beatValue(section,`${baseSlot}:0`).chord:null;
    const mergedLyrics=duration?Array.from({length:duration==='half'?2:4},(_,index)=>lyricValue(section,`${baseSlot}:${index}`)).filter(Boolean).join(' '):'';
    Object.keys(section.beats).filter(slot=>slot.startsWith(`${baseSlot}:`)).forEach(slot=>delete section.beats[slot]);
    Object.keys(section.lyricBeats||{}).filter(slot=>slot.startsWith(`${baseSlot}:`)).forEach(slot=>delete section.lyricBeats[slot]);
    if(firstChord)section.beats[baseSlot]={chord:firstChord,duration:null};
    else delete section.beats[baseSlot];
    setLyric(section,baseSlot,mergedLyrics);
    state.activeId=section.id;renderPreview();save();toast('Penanda ketukan dihapus');
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
      const next=available[Math.min(words.length,available.length)-1];next?.focus();next?.select();toast(`${words.length} kata dibagikan ke ketukan`);
    });
  });
  document.querySelectorAll('.section-lyrics-toggle').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();const section=state.sections.find(item=>item.id===button.dataset.section);if(!section)return;section.lyricsEnabled=section.lyricsEnabled===false;state.activeId=section.id;renderPreview();save();toast(`Lirik ${section.lyricsEnabled?'diaktifkan':'disembunyikan'} untuk ${section.name}`)}));
  document.querySelectorAll('.add-bar').forEach(button=>button.addEventListener('click',()=>{const section=state.sections.find(item=>item.id===button.dataset.section);section.bars+=4;state.activeId=section.id;syncEditor();renderPreview();save()}));
  document.querySelectorAll('.delete-bar').forEach(button=>button.addEventListener('click',event=>{
    event.stopPropagation();const section=state.sections.find(item=>item.id===button.dataset.section),bar=Number(button.dataset.bar);if(!section)return;
    if(section.bars<=1){toast('Minimal satu bar harus tetap tersedia');return}
    if(barHasContent(section,bar)&&!window.confirm(`Bar ${bar+1} berisi chord atau lirik. Hapus bar ini?`))return;
    removeBar(section,bar);state.activeId=section.id;renderPreview();save();toast(`Bar ${bar+1} dihapus`);
  }));
  document.querySelectorAll('.delete-section').forEach(button=>button.addEventListener('click',event=>{
    event.stopPropagation();if(state.sections.length<=1){toast('Minimal satu section harus tetap tersedia');return}
    const index=state.sections.findIndex(item=>item.id===button.dataset.section),section=state.sections[index];if(!section)return;
    const hasContent=Object.keys(section.beats||{}).length||Object.values(section.lyricBeats||{}).some(text=>String(text).trim());
    if(hasContent&&!window.confirm(`Section “${section.name}” berisi chord atau lirik. Hapus section ini?`))return;
    state.sections.splice(index,1);state.activeId=state.sections[Math.min(index,state.sections.length-1)].id;state.editingId=null;syncEditor();renderPreview();save();toast(`Section ${section.name} dihapus`);
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
  previewZoom=Math.min(1.35,Math.max(.65,Math.round(value*20)/20));
  $('#previewCard').style.zoom=previewZoom;$('#zoomValue').textContent=`${Math.round(previewZoom*100)}%`;
  if(persist)localStorage.setItem('chordSheetZoom',String(previewZoom));
  requestAnimationFrame(updateViewportOverflow);
}
function fitPreview(){
  const viewport=$('#previewViewport'),card=$('#previewCard');if(!viewport||!card)return;
  card.style.zoom=1;const available=Math.max(320,viewport.clientWidth-48),ratio=Math.min(1,available/card.offsetWidth);setPreviewZoom(ratio);viewport.scrollLeft=0;
}
function renderPreview(){
  const artist=$('#artist').value||'Artis / Komposer';
  $('#previewTitle').textContent=$('#songTitle').value||'Judul Lagu';$('#previewArtist').innerHTML=`<span class="artist-label">Created by:</span> <em class="artist-value">${escapeHTML(artist)}</em>`;$('#previewKey').textContent=state.key;$('#previewMeter').textContent=state.meter;
  $('#previewHint').textContent=lyricsFeatureAvailable&&state.lyricsEnabled?'Tarik chord ke titik ketukan, lalu isi lirik pada baris di bawahnya.':'Tarik chord dari toolbar atas ke titik ketukan.';
  $('#sectionsPreview').innerHTML=state.sections.map(sectionHTML).join('');bindPreview();requestAnimationFrame(updateViewportOverflow);
}
function projectData(){return {format:'chord-sheet',version:2,title:$('#songTitle').value,artist:$('#artist').value,key:state.key,chordRoot:state.chordRoot,customChord:state.customChord,meter:state.meter,lyricsEnabled:state.lyricsEnabled,sections:state.sections,slashChords:state.slashChords,nashvilleNumber:state.nashvilleNumber,nashvilleAccidental:state.nashvilleAccidental}}
function save(){localStorage.setItem('chordSheetPreview',JSON.stringify({...projectData(),activeId:state.activeId}))}
function safeFileName(value){return (value||'chord-sheet').trim().replace(/[^a-z0-9-_]+/gi,'-').replace(/^-|-$/g,'')||'chord-sheet'}
function downloadProject(){const defaultName=safeFileName($('#songTitle').value),requestedName=window.prompt('Nama file yang ingin dibuat:',defaultName);if(requestedName===null)return;const content=JSON.stringify(projectData(),null,2),file=new Blob([content],{type:'application/json'}),url=URL.createObjectURL(file),link=document.createElement('a');link.href=url;link.download=`${safeFileName(requestedName||defaultName)}.chordsheet.json`;document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);toast('File chord sheet berhasil diekspor')}
function applyProject(project){
  if(!project||project.format!=='chord-sheet'||!Array.isArray(project.sections))throw new Error('Format file tidak dikenali');
  const meter=['2/4','3/4','4/4','6/8'].includes(project.meter)?project.meter:'4/4';
  const sections=project.sections.filter(section=>section&&typeof section==='object').map(section=>normalizeSection(section,meter));
  if(!sections.length)throw new Error('File tidak memiliki section');
  const lyricsEnabled=typeof project.lyricsEnabled==='boolean'?project.lyricsEnabled:sections.some(section=>Object.keys(section.lyricBeats).length>0);
  state={key:keys.includes(project.key)?project.key:'C',chordRoot:keys.includes(project.chordRoot)?project.chordRoot:'C',customChord:typeof project.customChord==='string'?project.customChord:'',meter,lyricsEnabled,sections,slashChords:Array.isArray(project.slashChords)?project.slashChords.filter(chord=>typeof chord==='string'):[],nashvilleNumber:nashvilleChoices.includes(project.nashvilleNumber)?project.nashvilleNumber:'1',nashvilleAccidental:['','♭','#'].includes(project.nashvilleAccidental)?project.nashvilleAccidental:'',activeId:sections[0].id,editingId:null};
  clearPaletteSelection();
  $('#songTitle').value=String(project.title||'Judul Lagu');$('#artist').value=String(project.artist||'Artis / Komposer');$('#timeSignature').value=state.meter;syncEditor();renderControls();renderPreview();save();
}
function load(){try{const saved=JSON.parse(localStorage.getItem('chordSheetPreview'));if(!saved)return;state.key=saved.key||'C';state.chordRoot=saved.chordRoot||'C';state.customChord=typeof saved.customChord==='string'?saved.customChord:'';state.meter=saved.meter||'4/4';state.slashChords=Array.isArray(saved.slashChords)?saved.slashChords.filter(chord=>typeof chord==='string'):[];state.nashvilleNumber=nashvilleChoices.includes(saved.nashvilleNumber)?saved.nashvilleNumber:'1';state.nashvilleAccidental=['','♭','#'].includes(saved.nashvilleAccidental)?saved.nashvilleAccidental:'';state.sections=saved.sections?.length?saved.sections.map(section=>normalizeSection(section,state.meter)):[newSection('Intro')];state.lyricsEnabled=typeof saved.lyricsEnabled==='boolean'?saved.lyricsEnabled:state.sections.some(section=>Object.keys(section.lyricBeats).length>0);state.activeId=saved.activeId||state.sections[0].id;$('#songTitle').value=saved.title||'Judul Lagu';$('#artist').value=saved.artist||'Artis / Komposer';$('#timeSignature').value=state.meter}catch{}}
function updateActive(field,value){activeSection()[field]=value;renderPreview();save()}
function beginMetaEdit(kind){
  const config={title:{target:'#previewTitle',source:'#songTitle',type:'text'},artist:{target:'#previewArtist',source:'#artist',type:'text'},key:{target:'#previewKey',source:'#keySelect',type:'select',options:keys},meter:{target:'#previewMeter',source:'#timeSignature',type:'select',options:['2/4','3/4','4/4','6/8']}}[kind];
  const target=$(config.target),source=$(config.source);if(target.querySelector('input,select'))return;
  const editor=document.createElement(config.type==='select'?'select':'input');editor.className='preview-inline-input';
  if(config.type==='select'){editor.innerHTML=config.options.map(option=>`<option value="${option}">${option}</option>`).join('');editor.value=source.value}
  else {editor.type='text';editor.value=source.value}
  const commit=()=>{source.value=editor.value;target.classList.remove('is-editing');if(kind==='key')state.key=editor.value;if(kind==='meter')state.meter=editor.value;renderControls();renderPreview();save()};
  target.textContent='';target.classList.add('is-editing');target.append(editor);editor.focus();editor.select?.();editor.addEventListener('blur',commit,{once:true});editor.addEventListener('change',()=>editor.blur());editor.addEventListener('keydown',event=>{if(event.key==='Enter')editor.blur();if(event.key==='Escape'){target.classList.remove('is-editing');renderPreview()}});
}
const ribbonLabels={chord:'Chord palette',slash:'Slash chord builder',nashville:'Nashville Number System',rhythm:'Nilai ketukan',lyrics:'Pengaturan lirik'};
function activateRibbon(tab,{focus=false}={}){
  const selected=tab.dataset.ribbonTab;
  document.querySelectorAll('.ribbon-tab').forEach(item=>{const active=item===tab;item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));item.tabIndex=active?0:-1});
  document.querySelectorAll('.ribbon-panel').forEach(panel=>{const active=panel.dataset.ribbonPanel===selected;panel.classList.toggle('active',active);panel.hidden=!active});
  $('#activeToolLabel').textContent=ribbonLabels[selected]||'Arrangement tools';
  if($('#ribbonToggle').getAttribute('aria-expanded')==='false')toggleRibbon(true);
  if(focus)tab.focus();
}
function toggleRibbon(forceExpanded){
  const editor=document.querySelector('.editor-card'),currentlyExpanded=!editor.classList.contains('is-collapsed'),expanded=typeof forceExpanded==='boolean'?forceExpanded:!currentlyExpanded;
  editor.classList.toggle('is-collapsed',!expanded);$('#ribbonToggle').setAttribute('aria-expanded',String(expanded));$('#ribbonToggle').title=expanded?'Ciutkan toolbar':'Buka toolbar';
  $('#ribbonToggle').querySelector('.sr-only').textContent=expanded?'Ciutkan toolbar':'Buka toolbar';
  requestAnimationFrame(updateViewportOverflow);
}
$('#keySelect').addEventListener('change',event=>{state.key=event.target.value;renderPreview();save()});
$('#chordRootPicker').addEventListener('click',event=>{if(!event.target.dataset.root)return;clearPaletteSelection();state.chordRoot=event.target.dataset.root;renderControls();save()});
$('#customChordInput').addEventListener('input',event=>{clearPaletteSelection();state.customChord=event.target.value;renderCustomChord();save()});
$('#addSlashBtn').addEventListener('click',()=>{const chord=`${$('#slashRoot').value}${$('#slashQuality').value}/${$('#slashBass').value}`;if(!state.slashChords.includes(chord))state.slashChords.push(chord);renderControls();save();toast(`${chord} siap untuk di-drag`)});
$('#nashvilleRootPicker').addEventListener('click',event=>{const button=event.target.closest('.nashville-key');if(!button)return;clearPaletteSelection();state.nashvilleNumber=button.dataset.number;renderControls();save()});
$('#nashvilleAccidentalPicker').addEventListener('click',event=>{if(event.target.dataset.accidental===undefined)return;clearPaletteSelection();state.nashvilleAccidental=event.target.dataset.accidental;renderControls();save()});
$('#transposeDown').addEventListener('click',()=>transposeSheet(-1));
$('#transposeUp').addEventListener('click',()=>transposeSheet(1));
$('#lyricsEnabled').addEventListener('change',event=>{state.lyricsEnabled=event.target.checked;renderControls();renderPreview();save();toast(state.lyricsEnabled?'Mode lirik diaktifkan':'Lirik disembunyikan dari sheet')});
document.querySelectorAll('.ribbon-tab').forEach(tab=>{
  tab.addEventListener('click',()=>activateRibbon(tab));
  tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=[...document.querySelectorAll('.ribbon-tab:not([hidden])')],index=tabs.indexOf(tab);const next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];activateRibbon(next,{focus:true})});
});
$('#ribbonToggle').addEventListener('click',()=>toggleRibbon());
$('#zoomOut').addEventListener('click',()=>setPreviewZoom(previewZoom-.1));
$('#zoomIn').addEventListener('click',()=>setPreviewZoom(previewZoom+.1));
$('#fitPreview').addEventListener('click',fitPreview);
$('#previewViewport').addEventListener('scroll',updateViewportOverflow,{passive:true});
$('#previewTitle').addEventListener('click',event=>{if(!event.target.matches('input'))beginMetaEdit('title')});$('#previewArtist').addEventListener('click',event=>{if(!event.target.matches('input'))beginMetaEdit('artist')});$('#previewKey').addEventListener('click',event=>{if(!event.target.matches('select'))beginMetaEdit('key')});$('#previewMeter').addEventListener('click',event=>{if(!event.target.matches('select'))beginMetaEdit('meter')});
$('#timeSignature').addEventListener('change',event=>{state.meter=event.target.value;renderPreview();save();toast(`Preview disesuaikan ke ${state.meter}`)});
$('#songTitle').addEventListener('input',()=>{renderPreview();save()});$('#artist').addEventListener('input',()=>{renderPreview();save()});
$('#addSectionBtn').addEventListener('click',()=>{const section=newSection(`Section ${state.sections.length+1}`);state.sections.push(section);state.activeId=section.id;syncEditor();renderPreview();save();toast('Section baru ditambahkan')});
$('#resetSheetBtn').addEventListener('click',()=>{if(!window.confirm('Reset seluruh chord sheet dan kembali ke kondisi awal?'))return;const firstSection=newSection('Intro');state={key:'C',chordRoot:'C',customChord:'',meter:'4/4',lyricsEnabled:false,sections:[firstSection],slashChords:[],nashvilleNumber:'1',nashvilleAccidental:'',activeId:firstSection.id,editingId:null};selectedPaletteItem=null;$('#songTitle').value='Judul Lagu';$('#artist').value='Artis / Komposer';$('#timeSignature').value='4/4';syncEditor();renderControls();renderPreview();save();toast('Sheet dikembalikan ke tampilan awal')});
$('#saveBtn').addEventListener('click',downloadProject);
$('#projectFileInput').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;try{applyProject(JSON.parse(await file.text()));toast('Chord sheet berhasil dimuat dan siap diedit')}catch(error){toast('File tidak valid atau bukan file WorshipNadaSheet')}finally{event.target.value=''}});
$('#exportBtn').addEventListener('click',()=>{renderPreview();window.print()});
window.addEventListener('scroll',()=>{const editor=document.querySelector('.editor-card');editor.classList.toggle('is-scrolled',editor.getBoundingClientRect().top<=80)},{passive:true});
window.addEventListener('resize',updateViewportOverflow,{passive:true});
document.addEventListener('keydown',event=>{
  const editing=event.target.matches('input,textarea,select,[contenteditable="true"]');
  if((event.ctrlKey||event.metaKey)&&['+','=','-','0'].includes(event.key)){event.preventDefault();if(event.key==='-')setPreviewZoom(previewZoom-.1);else if(event.key==='0')fitPreview();else setPreviewZoom(previewZoom+.1);return}
  if(event.altKey&&!editing&&/^[1-4]$/.test(event.key)){event.preventDefault();const tab=document.querySelectorAll('.ribbon-tab:not([hidden])')[Number(event.key)-1];if(tab)activateRibbon(tab,{focus:true});return}
  if(event.key==='Escape'&&!editing&&$('#ribbonToggle').getAttribute('aria-expanded')==='true')toggleRibbon(false);
});
load();syncEditor();renderControls();renderPreview();activateRibbon(document.querySelector('.ribbon-tab.active'));setPreviewZoom(previewZoom,{persist:false});
if('ResizeObserver'in window)new ResizeObserver(updateViewportOverflow).observe($('#previewViewport'));
