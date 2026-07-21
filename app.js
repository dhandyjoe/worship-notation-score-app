const keys=['C','D♭','D','E♭','E','F','G♭','G','A♭','A','B♭','B'];
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
const $=selector=>document.querySelector(selector);
const newSection=(name='Intro')=>({id:crypto.randomUUID(),name,lyrics:'',bars:4,beats:{}});
let state={key:'C',chordRoot:'C',customChord:'',meter:'4/4',sections:[newSection('Intro')],slashChords:[],nashvilleNumber:'1',nashvilleAccidental:'',activeId:null,editingId:null};
state.activeId=state.sections[0].id;
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
  return match?`${match[1]}${nashvilleNumberLabel(match[2])}${match[3]}`:chord;
}
function bindDraggableChords(){document.querySelectorAll('.chord').forEach(chord=>chord.addEventListener('dragstart',event=>event.dataTransfer.setData('application/chord-sheet',JSON.stringify({type:'chord',value:chord.dataset.chord}))));}
function renderCustomChord(){const value=state.customChord.trim();$('#customChordPreview').innerHTML=value?`<span class="chord custom-chord" draggable="true" data-chord="${value}">${value}</span>`:'<span class="custom-chord-hint">Preview chord custom</span>';bindDraggableChords();}
function meterInfo(){const [top]=state.meter.split('/').map(Number);return {beats:top};}
function renderControls(){
  $('#keySelect').innerHTML=keys.map(key=>`<option ${key===state.key?'selected':''}>${key}</option>`).join('');
  $('#chordRootPicker').innerHTML=keys.map(key=>`<button class="key ${key===state.chordRoot?'active':''}" data-root="${key}">${key}</button>`).join('');
  $('#chordBank').innerHTML=chordQualities.map(({value,label})=>`<span class="chord" draggable="true" data-chord="${chordName(value)}">${chordName(value)}</span>`).join('');
  $('#slashRoot').innerHTML=keys.map(key=>`<option value="${key}">${key}</option>`).join('');
  $('#slashQuality').innerHTML=chordQualities.map(({value,label})=>`<option value="${value}">${label}</option>`).join('');
  $('#slashBass').innerHTML=bassNotes.map(note=>`<option value="${note}">${note}</option>`).join('');
  $('#slashChordBank').innerHTML=state.slashChords.map(chord=>`<span class="chord slash-chord" draggable="true" data-chord="${chord}">${chord}</span>`).join('');
  $('#customChordInput').value=state.customChord;
  const nashvilleRow=(numbers,description,rowClass='')=>`<div class="nashville-number-row ${rowClass}" aria-label="${description}">${numbers.map(number=>`<button class="nashville-key ${number===state.nashvilleNumber?'active':''}" data-number="${number}" title="${description}">${nashvilleNumberLabel(number)}</button>`).join('')}</div>`;
  $('#nashvilleRootPicker').innerHTML=[
    nashvilleRow(nashvilleNumbers,'Nashville Number System'),
    nashvilleRow(nashvilleLowerNumbers,'Satu oktaf di bawah'),
    nashvilleRow(nashvilleUpperNumbers,'Satu oktaf di atas'),
    nashvilleRow(nashvilleZeroNumbers,'Nashville Number 0','nashville-zero-row'),
  ].join('');
  $('#nashvilleAccidentalPicker').innerHTML=[['','♮'],['♭','♭'],['#','#']].map(([value,label])=>`<button class="nashville-accidental ${value===state.nashvilleAccidental?'active':''}" data-accidental="${value}">${label}</button>`).join('');
  $('#nashvilleChordBank').innerHTML=chordQualities.map(({value})=>`<span class="chord nashville-chord" draggable="true" data-chord="${nashvilleName(value)}">${chordLabel(nashvilleName(value))}</span>`).join('');
  $('#beatBank').innerHTML='<span class="duration-option" draggable="true" data-duration="half"><b>½</b> Setengah ketuk</span><span class="duration-option" draggable="true" data-duration="quarter"><b>¼</b> Seperempat ketuk</span>';
  bindDraggableChords();renderCustomChord();
  document.querySelectorAll('.duration-option').forEach(option=>option.addEventListener('dragstart',event=>event.dataTransfer.setData('application/chord-sheet',JSON.stringify({type:'duration',value:option.dataset.duration}))));
}
function syncEditor(){}
function beatValue(section,slot){const value=section.beats[slot];return typeof value==='string'?{chord:value,duration:null}:value||{chord:null,duration:null}}
function chordOrDot(section,slot){const value=beatValue(section,slot);return value.chord?`<span class="placed-chord" title="Klik untuk hapus">${chordLabel(value.chord)}</span>`:'<span class="beat-dot">·</span>'}
function beatHTML(section,bar,beat){
  const slot=`${bar}-${beat}`,value=beatValue(section,slot);
  if(!value.duration)return `<span class="beat drop-target ${value.chord?'has-chord':''}" data-section="${section.id}" data-slot="${slot}" data-base-slot="${slot}">${chordOrDot(section,slot)}</span>`;
  if(value.chord&&!section.beats[`${slot}:0`]){section.beats[`${slot}:0`]={chord:value.chord,duration:null};value.chord=null;section.beats[slot]=value}
  const count=value.duration==='half'?2:4;
  const subBeats=Array.from({length:count},(_,index)=>{const subSlot=`${slot}:${index}`,subValue=beatValue(section,subSlot);return `<span class="sub-beat drop-target ${subValue.chord?'has-chord':''}" data-section="${section.id}" data-slot="${subSlot}" data-base-slot="${slot}">${chordOrDot(section,subSlot)}</span>`}).join('');
  return `<span class="beat-group duration-${value.duration}" data-section="${section.id}" data-base-slot="${slot}"><span class="duration-line" title="Klik untuk hapus penanda ketukan"></span><span class="sub-beats">${subBeats}</span></span>`;
}
function sectionHTML(section){
  const {beats}=meterInfo();
  const bars=Array.from({length:section.bars},(_,bar)=>`<div class="bar">${Array.from({length:beats},(_,beat)=>beatHTML(section,bar,beat)).join('')}</div>`);
  const batches=Array.from({length:Math.ceil(bars.length/4)},(_,index)=>`<div class="bar-batch">${bars.slice(index*4,index*4+4).join('')}</div>`).join('');
  const title=section.id===state.editingId?`<input class="section-title-input" data-section="${section.id}" value="${section.name}" aria-label="Nama section">`:`<button class="section-title" data-section="${section.id}" title="Klik untuk mengganti nama section">${section.name.toUpperCase()}</button>`;
  return `<section class="preview-section ${section.id===state.activeId?'is-active':''}" data-section="${section.id}"><div class="section-preview-heading"><div>${title}</div><div class="section-tools"><span class="bar-caption">${section.bars} bar · ${beats} ketuk per bar</span><button class="text-button add-bar" data-section="${section.id}">+ Add 4 bar</button></div></div><div class="bar-grid">${batches}</div>${section.lyrics?`<div class="lyrics-preview">${section.lyrics}</div>`:''}</section>`;
}
function bindPreview(){
  document.querySelectorAll('.drop-target').forEach(beat=>{
    beat.addEventListener('dragover',event=>{event.preventDefault();beat.classList.add('dragover')});
    beat.addEventListener('dragleave',()=>beat.classList.remove('dragover'));
    beat.addEventListener('drop',event=>{event.preventDefault();let item;try{item=JSON.parse(event.dataTransfer.getData('application/chord-sheet'))}catch{}const section=state.sections.find(item=>item.id===beat.dataset.section);beat.classList.remove('dragover');if(!item||!section)return;if(item.type==='chord'){const value=beatValue(section,beat.dataset.slot);value.chord=item.value;section.beats[beat.dataset.slot]=value}if(item.type==='duration'){const baseSlot=beat.dataset.baseSlot;const value=beatValue(section,baseSlot);if(value.chord){section.beats[`${baseSlot}:0`]={chord:value.chord,duration:null};value.chord=null}value.duration=item.value;section.beats[baseSlot]=value}state.activeId=section.id;syncEditor();renderPreview();save()});
  });
  document.querySelectorAll('.placed-chord').forEach(chord=>chord.addEventListener('click',()=>{const beat=chord.closest('.drop-target'),section=state.sections.find(item=>item.id===beat.dataset.section);delete section.beats[beat.dataset.slot];renderPreview();save()}));
  document.querySelectorAll('.duration-line').forEach(line=>line.addEventListener('click',event=>{
    event.stopPropagation();
    const group=line.closest('.beat-group'),section=state.sections.find(item=>item.id===group.dataset.section),baseSlot=group.dataset.baseSlot;
    if(!section)return;
    const duration=beatValue(section,baseSlot).duration;
    const firstChord=duration?beatValue(section,`${baseSlot}:0`).chord:null;
    Object.keys(section.beats).filter(slot=>slot.startsWith(`${baseSlot}:`)).forEach(slot=>delete section.beats[slot]);
    if(firstChord)section.beats[baseSlot]={chord:firstChord,duration:null};
    else delete section.beats[baseSlot];
    state.activeId=section.id;renderPreview();save();toast('Penanda ketukan dihapus');
  }));
  document.querySelectorAll('.add-bar').forEach(button=>button.addEventListener('click',()=>{const section=state.sections.find(item=>item.id===button.dataset.section);section.bars+=4;state.activeId=section.id;syncEditor();renderPreview();save()}));
  document.querySelectorAll('.section-title').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();state.activeId=button.dataset.section;state.editingId=button.dataset.section;syncEditor();renderPreview();requestAnimationFrame(()=>$('.section-title-input')?.focus())}));
  document.querySelectorAll('.section-title-input').forEach(input=>{
    const commit=()=>{const section=state.sections.find(item=>item.id===input.dataset.section);section.name=input.value.trim()||'Untitled section';state.activeId=section.id;state.editingId=null;syncEditor();renderPreview();save()};
    input.addEventListener('blur',commit);input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();input.blur()}if(event.key==='Escape'){state.editingId=null;renderPreview()}});input.addEventListener('click',event=>event.stopPropagation());
  });
  document.querySelectorAll('.preview-section').forEach(el=>el.addEventListener('click',()=>{state.activeId=el.dataset.section;syncEditor();renderPreview()}));
}
function renderPreview(){
  $('#previewTitle').textContent=$('#songTitle').value||'Judul Lagu';$('#previewArtist').textContent=$('#artist').value||'Artis / Komposer';$('#previewKey').textContent=state.key;$('#previewMeter').textContent=state.meter;
  $('#sectionsPreview').innerHTML=state.sections.map(sectionHTML).join('');bindPreview();
}
function projectData(){return {format:'chord-sheet',version:1,title:$('#songTitle').value,artist:$('#artist').value,key:state.key,chordRoot:state.chordRoot,customChord:state.customChord,meter:state.meter,sections:state.sections,slashChords:state.slashChords,nashvilleNumber:state.nashvilleNumber,nashvilleAccidental:state.nashvilleAccidental}}
function save(){localStorage.setItem('chordSheetPreview',JSON.stringify({...projectData(),activeId:state.activeId}))}
function safeFileName(value){return (value||'chord-sheet').trim().replace(/[^a-z0-9-_]+/gi,'-').replace(/^-|-$/g,'')||'chord-sheet'}
function downloadProject(){const defaultName=safeFileName($('#songTitle').value),requestedName=window.prompt('Nama file yang ingin dibuat:',defaultName);if(requestedName===null)return;const content=JSON.stringify(projectData(),null,2),file=new Blob([content],{type:'application/json'}),url=URL.createObjectURL(file),link=document.createElement('a');link.href=url;link.download=`${safeFileName(requestedName||defaultName)}.chordsheet.json`;document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);toast('File chord sheet berhasil diekspor')}
function applyProject(project){
  if(!project||project.format!=='chord-sheet'||!Array.isArray(project.sections))throw new Error('Format file tidak dikenali');
  const sections=project.sections.filter(section=>section&&typeof section==='object').map(section=>({id:section.id||crypto.randomUUID(),name:String(section.name||'Section'),lyrics:String(section.lyrics||''),bars:Math.max(4,Number(section.bars)||4),beats:section.beats&&typeof section.beats==='object'?section.beats:{}}));
  if(!sections.length)throw new Error('File tidak memiliki section');
  state={key:keys.includes(project.key)?project.key:'C',chordRoot:keys.includes(project.chordRoot)?project.chordRoot:'C',customChord:typeof project.customChord==='string'?project.customChord:'',meter:['2/4','3/4','4/4','6/8'].includes(project.meter)?project.meter:'4/4',sections,slashChords:Array.isArray(project.slashChords)?project.slashChords.filter(chord=>typeof chord==='string'):[],nashvilleNumber:nashvilleChoices.includes(project.nashvilleNumber)?project.nashvilleNumber:'1',nashvilleAccidental:['','♭','#'].includes(project.nashvilleAccidental)?project.nashvilleAccidental:'',activeId:sections[0].id,editingId:null};
  $('#songTitle').value=String(project.title||'Judul Lagu');$('#artist').value=String(project.artist||'Artis / Komposer');$('#timeSignature').value=state.meter;syncEditor();renderControls();renderPreview();save();
}
function load(){try{const saved=JSON.parse(localStorage.getItem('chordSheetPreview'));if(!saved)return;state.key=saved.key||'C';state.chordRoot=saved.chordRoot||'C';state.customChord=typeof saved.customChord==='string'?saved.customChord:'';state.meter=saved.meter||'4/4';state.slashChords=Array.isArray(saved.slashChords)?saved.slashChords.filter(chord=>typeof chord==='string'):[];state.nashvilleNumber=nashvilleChoices.includes(saved.nashvilleNumber)?saved.nashvilleNumber:'1';state.nashvilleAccidental=['','♭','#'].includes(saved.nashvilleAccidental)?saved.nashvilleAccidental:'';state.sections=saved.sections?.length?saved.sections:[newSection('Intro')];state.activeId=saved.activeId||state.sections[0].id;$('#songTitle').value=saved.title||'Judul Lagu';$('#artist').value=saved.artist||'Artis / Komposer';$('#timeSignature').value=state.meter}catch{}}
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
$('#keySelect').addEventListener('change',event=>{state.key=event.target.value;renderPreview();save()});
$('#chordRootPicker').addEventListener('click',event=>{if(!event.target.dataset.root)return;state.chordRoot=event.target.dataset.root;renderControls();save()});
$('#customChordInput').addEventListener('input',event=>{state.customChord=event.target.value;renderCustomChord();save()});
$('#addSlashBtn').addEventListener('click',()=>{const chord=`${$('#slashRoot').value}${$('#slashQuality').value}/${$('#slashBass').value}`;if(!state.slashChords.includes(chord))state.slashChords.push(chord);renderControls();save();toast(`${chord} siap untuk di-drag`)});
$('#nashvilleRootPicker').addEventListener('click',event=>{const button=event.target.closest('.nashville-key');if(!button)return;state.nashvilleNumber=button.dataset.number;renderControls();save()});
$('#nashvilleAccidentalPicker').addEventListener('click',event=>{if(event.target.dataset.accidental===undefined)return;state.nashvilleAccidental=event.target.dataset.accidental;renderControls();save()});
document.querySelectorAll('.ribbon-tab').forEach(tab=>tab.addEventListener('click',()=>{const selected=tab.dataset.ribbonTab;document.querySelectorAll('.ribbon-tab').forEach(item=>item.classList.toggle('active',item===tab));document.querySelectorAll('.ribbon-panel').forEach(panel=>panel.classList.toggle('active',panel.dataset.ribbonPanel===selected))}));
$('#previewTitle').addEventListener('click',event=>{if(!event.target.matches('input'))beginMetaEdit('title')});$('#previewArtist').addEventListener('click',event=>{if(!event.target.matches('input'))beginMetaEdit('artist')});$('#previewKey').addEventListener('click',event=>{if(!event.target.matches('select'))beginMetaEdit('key')});$('#previewMeter').addEventListener('click',event=>{if(!event.target.matches('select'))beginMetaEdit('meter')});
$('#timeSignature').addEventListener('change',event=>{state.meter=event.target.value;renderPreview();save();toast(`Preview disesuaikan ke ${state.meter}`)});
$('#songTitle').addEventListener('input',()=>{renderPreview();save()});$('#artist').addEventListener('input',()=>{renderPreview();save()});
$('#addSectionBtn').addEventListener('click',()=>{const section=newSection(`Section ${state.sections.length+1}`);state.sections.push(section);state.activeId=section.id;syncEditor();renderPreview();save();toast('Section baru ditambahkan')});
$('#resetSheetBtn').addEventListener('click',()=>{const firstSection=newSection('Intro');state={key:'C',chordRoot:'C',customChord:'',meter:'4/4',sections:[firstSection],slashChords:[],nashvilleNumber:'1',nashvilleAccidental:'',activeId:firstSection.id,editingId:null};$('#songTitle').value='Judul Lagu';$('#artist').value='Artis / Komposer';$('#timeSignature').value='4/4';syncEditor();renderControls();renderPreview();save();toast('Sheet dikembalikan ke tampilan awal')});
$('#saveBtn').addEventListener('click',downloadProject);
$('#projectFileInput').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;try{applyProject(JSON.parse(await file.text()));toast('Chord sheet berhasil dimuat dan siap diedit')}catch(error){toast('File tidak valid atau bukan file Chord Sheet')}finally{event.target.value=''}});
$('#exportBtn').addEventListener('click',()=>window.print());
load();syncEditor();renderControls();renderPreview();
