const $ = id => document.getElementById(id);
const state = {
  queue: [], pdfJs: null, registry: null, selected: -1,
  printing: false, stop: false, previewVersion: 0, fonts: [], textSelectedId: null, activeImageId: "image", cropState: null,
  editor: { pointers: new Map(), mode: null, start: null, crop: null, sizeInfo: null, entry: null },
  viewZoom: 1, showOutsideBounds: false, savedTemplates: [], labelRotateMode: "keep", printView: true
};
// Undo/redo tracks editable label data. Files/Blobs are kept by reference instead
// of being duplicated, so a large image is not copied on every touch operation.
const blobIds=new WeakMap();let nextBlobId=0;
let committedSettings=null;
function readSettings(){return {model:$('model')?.value,size:$('size')?.value,density:$('density')?.value};}
function restoreSettings(v){if(!v)return;const previous=history.restoring;history.restoring=true;try{for(const id of ['model','size','density']){if($(id).value!==v[id]){$(id).value=v[id];$(id).dispatchEvent(new Event('change',{bubbles:true}));}}committedSettings={...v};}finally{history.restoring=previous;}}
const history={undo:[],redo:[],pending:null,hold:false,gesturing:false,restoring:false,limit:55,timer:null};
function snapshotClone(value){
 if(value===null || typeof value!=='object')return value;
 if(value instanceof Blob)return value;
 if(value instanceof ArrayBuffer)return value.slice(0);
 if(ArrayBuffer.isView(value))return value.slice();
 if(Array.isArray(value))return value.map(snapshotClone);
 const out={};
 for(const [key,val] of Object.entries(value)){
   if(['img','imgPromise','objectUrl'].includes(key))continue;
   if(typeof val==='function')continue;
   out[key]=snapshotClone(val);
 }
 return out;
}
function takeSnapshot(){return {queue:snapshotClone(state.queue),selected:state.selected,textSelectedId:state.textSelectedId,activeImageId:state.activeImageId,settings:{...(committedSettings||readSettings())}};}
function snapshotFingerprint(snapshot){
 return JSON.stringify({queue:snapshot.queue,settings:snapshot.settings},(k,v)=>{
  if(!(v instanceof Blob))return v;
  if(!blobIds.has(v))blobIds.set(v,++nextBlobId);
  return '<blob:'+blobIds.get(v)+'>';
 });
}
function updateHistoryControls(){
 const undo=$('dd-undo'),redo=$('dd-redo'),status=$('dd-history-status');
 if(!undo||!redo||!status)return;
 undo.disabled=!history.undo.length||isBusy();redo.disabled=!history.redo.length||isBusy();
 status.textContent=`${history.undo.length} zurück · ${history.redo.length} wiederholen`;
}
function beginHistory(reason='Änderung'){
 if(history.restoring||state.printing||history.pending)return;
 const shot=takeSnapshot();history.pending={snapshot:shot,fingerprint:snapshotFingerprint(shot),reason};
}
function commitHistory(){
 if(history.restoring||history.hold||history.gesturing||!history.pending)return;
 const pending=history.pending;history.pending=null;
 if(snapshotFingerprint(takeSnapshot())===pending.fingerprint){updateHistoryControls();return;}
 history.undo.push(pending.snapshot);
 if(history.undo.length>history.limit)history.undo.shift();
 history.redo.length=0;
 updateHistoryControls();
}
function clearHistoryTimer(){if(history.timer){clearTimeout(history.timer);history.timer=null;}}
function scheduleHistoryCommit(delay=80){
 if(history.restoring||history.hold||history.gesturing)return;
 clearHistoryTimer();history.timer=setTimeout(()=>{history.timer=null;commitHistory();},delay);
}
function restoreHistory(shot){
 history.restoring=true;clearHistoryTimer();history.pending=null;restoreSettings(shot.settings);
 for(const entry of state.queue)revokeEntry(entry);
 state.queue=snapshotClone(shot.queue);
 state.selected=Math.max(-1,Math.min(state.queue.length-1,shot.selected));
 state.textSelectedId=shot.textSelectedId;
 state.activeImageId=shot.activeImageId;
 state.editor.pointers.clear();state.editor.mode=null;state.editor.start=null;
 const entry=state.queue[state.selected];
 if(entry){
   if(!entry.texts?.some(t=>t.id===state.textSelectedId))state.textSelectedId=null;
   if(!imageForId(entry,state.activeImageId))state.activeImageId=allImages(entry)[0]?.id||'image';
 }else{state.textSelectedId=null;state.activeImageId='image';}
 state.previewVersion++;
 showQueue();renderTextControls();setImagePanel(activeImageLayer(entry));requestPreview();
 history.restoring=false;updateHistoryControls();
}
function undoEdit(){
 if(isBusy()||state.cropState)return;
 history.hold=false;history.gesturing=false;clearHistoryTimer();commitHistory();
 if(!history.undo.length)return;
 const now=takeSnapshot(),previous=history.undo.pop();history.redo.push(now);restoreHistory(previous);
 message('Änderung rückgängig gemacht.');
}
function redoEdit(){
 if(isBusy()||state.cropState)return;
 history.hold=false;history.gesturing=false;clearHistoryTimer();commitHistory();
 if(!history.redo.length)return;
 const now=takeSnapshot(),next=history.redo.pop();history.undo.push(now);restoreHistory(next);
 message('Änderung wiederhergestellt.');
}
$('dd-undo').addEventListener('click',undoEdit);
$('dd-redo').addEventListener('click',redoEdit);
document.addEventListener('keydown',e=>{
 if(!(e.ctrlKey||e.metaKey)||e.altKey)return;
 if(e.target.closest('input,textarea,[contenteditable="true"]'))return;
 const key=e.key.toLowerCase();
 if(key==='z' && e.shiftKey){e.preventDefault();redoEdit();}
 else if(key==='z'){e.preventDefault();undoEdit();}
 else if(key==='y'){e.preventDefault();redoEdit();}
});
// Capture before the application's own listeners run. Changes caused by a native
// slider drag or typing are grouped, while a button click is one history step.
const historyRoot=$('dd-addon');
historyRoot.addEventListener('click',e=>{
 const button=e.target.closest('button');if(!button)return;
 if(['dd-undo','dd-redo','dd-print','dd-stop','dd-picker','dd-add-layer','dd-crop-image','dd-clear'].includes(button.id))return;
 if(button.closest('#dd-tabstrip,.dd-toolsizes,#dd-template-list')||button.id.startsWith('dd-template-')||button.id.startsWith('dd-viewzoom')||button.id==='dd-preview-overflow-toggle')return;
 clearHistoryTimer();commitHistory();beginHistory(button.title||button.textContent.trim()||'Bearbeiten');scheduleHistoryCommit(115);
},true);
historyRoot.addEventListener('focusin',e=>{
 if(!e.target.matches('input,textarea,select')||e.target.type==='file')return;
 beginHistory('Wert eingeben');
},true);
historyRoot.addEventListener('focusout',e=>{
 if(!e.target.matches('input,textarea,select')||e.target.type==='file')return;
 scheduleHistoryCommit(40);
},true);
historyRoot.addEventListener('input',e=>{
 if(!e.target.matches('input,textarea,select')||e.target.type==='file')return;
 beginHistory('Wert geändert');scheduleHistoryCommit(520);
},true);
historyRoot.addEventListener('change',e=>{
 if(!e.target.matches('input,textarea,select')||e.target.type==='file')return;
 beginHistory('Einstellung geändert');scheduleHistoryCommit(70);
},true);
historyRoot.addEventListener('pointerdown',e=>{
 if(e.target.matches('input[type="range"]')){beginHistory('Regler');history.gesturing=true;}
},true);
window.addEventListener('pointerup',e=>{
 if(history.gesturing&&!state.editor.pointers.size){
   history.gesturing=false;scheduleHistoryCommit(40);
 }
},true);
window.addEventListener('pointercancel',()=>{history.gesturing=false;scheduleHistoryCommit(40);},true);

function isBusy(){return !!(state.printing||state.importingFiles||state.resizingTemplate||state.templateBusy||state.creatingLabel||state.fontBusy);}
const pausedControls=new Map();
function refreshBusyUi(){
 const busy=isBusy(),workspace=$('dd-workspace');if(workspace){workspace.inert=busy;workspace.setAttribute('aria-busy',String(busy));}for(const id of ['dd-dock-save','dd-dockrolls'])if($(id))$(id).hidden=!!state.printing;
 const ids=['model','size','density','dd-copies','identify','disconnect','readstatus','rollread','rollsave','print','printreal','print3copies','print3','print5','print3dense','print5dense','dd-dock-add','dd-dock-save'];
 if(busy){for(const id of ids){const el=$(id);if(el){if(!pausedControls.has(el))pausedControls.set(el,el.disabled);el.disabled=true;}}}
 else{for(const [el,value] of pausedControls)el.disabled=value;pausedControls.clear();}
 buttonState();updateHistoryControls();
}
for(const type of ['click','input','change','pointerdown','keydown','drop'])document.addEventListener(type,e=>{
 if(!isBusy()||history.restoring||e.target.closest?.('#dd-crop-dialog')||e.target.closest?.('#dd-stop'))return;
 if(e.target.closest?.('#dd-addon,#rollbox')){e.preventDefault();e.stopImmediatePropagation();}
},true);
function copyCount(){const n=Math.floor(Number($('dd-copies').value)||1);return Math.max(1,Math.min(30,n));}
const MAX_PAGES = 100;
const PDF_URL = new URL('pdf.min.js',document.baseURI).href;
const PDF_WORKER = new URL('pdf.worker.min.js',document.baseURI).href;
const FILE_LIMIT = 40 * 1024 * 1024;
const loaded = () => Boolean(window.Niimbot && $('model') && $('model').options.length && $('size') && $('size').options.length);
const TEMPLATE_STORE_KEY="niimbot-v14:saved-templates";
function uid(prefix="id"){return prefix+Math.random().toString(36).slice(2)+Date.now().toString(36);} 
function safeJsonParse(text,fallback){try{return JSON.parse(text);}catch(e){return fallback;}}
function customSizesMap(){const raw=safeJsonParse(localStorage.getItem("niimbot-demo:custom-sizes")||"{}",{});return raw&&typeof raw==="object"&&!Array.isArray(raw)?raw:{};}
function sizeByKey(sizeKey){return state.registry?.sizes?.[sizeKey]||customSizesMap()[sizeKey]||null;}
function orientationSuffix(entry){return entry?.pageRotation===90?"|r90":"";}
function swapSizeFields(size){return {...size,w_px:size.h_px,h_px:size.w_px,w_mm:size.h_mm,h_mm:size.w_mm};}
function effectiveSizeInfo(entry,baseSizeInfo){
 const info={...baseSizeInfo,size:{...baseSizeInfo.size},sizeKey:baseSizeInfo.sizeKey+orientationSuffix(entry)};
 if(entry?.pageRotation===90)info.size=swapSizeFields(info.size);
 return info;
}
function blobToDataURL(blob){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error||Error("Blob konnte nicht gelesen werden"));r.readAsDataURL(blob);});}
function dataURLToBlob(dataUrl){const [meta,data]=String(dataUrl||"").split(",",2);const mime=((meta||"").match(/data:([^;]+)/)||[])[1]||"application/octet-stream";const binary=atob(data||"");const arr=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)arr[i]=binary.charCodeAt(i);return new Blob([arr],{type:mime});}
async function serializeLayerForTemplate(layer){const copy=snapshotClone(layer);copy.blobData=await blobToDataURL(layer.blob);delete copy.blob;delete copy.img;delete copy.imgPromise;delete copy.objectUrl;return copy;}
async function serializeEntryForTemplate(entry){const copy=snapshotClone(entry);copy.blobData=await blobToDataURL(entry.blob);delete copy.blob;delete copy.img;delete copy.imgPromise;delete copy.objectUrl;copy.images=[];for(const layer of (entry.images||[]))copy.images.push(await serializeLayerForTemplate(layer));return copy;}
function deserializeTemplateLayer(layer){const copy=snapshotClone(layer);copy.blob=dataURLToBlob(layer.blobData);delete copy.blobData;copy.img=null;copy.imgPromise=null;copy.objectUrl="";copy.images=[];return copy;}
function deserializeTemplateEntry(serialized){const copy=snapshotClone(serialized);copy.blob=dataURLToBlob(serialized.blobData);delete copy.blobData;copy.img=null;copy.imgPromise=null;copy.objectUrl="";copy.images=(serialized.images||[]).map(deserializeTemplateLayer);copy.texts=(serialized.texts||[]).map(t=>({...t}));copy.layouts=copy.layouts||{};return copy;}
let templateDbPromise=null;
function templateDB(){
 if(!templateDbPromise)templateDbPromise=new Promise((resolve,reject)=>{
  if(!window.indexedDB){reject(Error('Dieser Browser erlaubt keine IndexedDB-Speicherung. Vorlagen als Datei exportieren.'));return;}
  const request=indexedDB.open('niimbot-druckstudio',3);
  request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('templates'))db.createObjectStore('templates',{keyPath:'id'});};
  request.onblocked=()=>reject(Error('Bitte andere geöffnete Druckstudio-Tabs schließen und erneut versuchen.'));
  request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();templateDbPromise=null;};resolve(db);};request.onerror=()=>reject(request.error||Error('Vorlagen-Datenbank nicht verfügbar'));
 }).catch(err=>{templateDbPromise=null;throw err;});
 return templateDbPromise;
}
async function templateTransaction(mode,operation){
 const db=await templateDB();return new Promise((resolve,reject)=>{
  const transaction=db.transaction('templates',mode),store=transaction.objectStore('templates');
  transaction.onabort=()=>reject(transaction.error||Error('Speicherung abgebrochen'));
  let value;const request=operation(store);
  request.onsuccess=()=>{value=request.result};request.onerror=()=>reject(request.error||Error('Datenbankzugriff fehlgeschlagen'));
  transaction.oncomplete=()=>resolve(value);transaction.onerror=()=>reject(transaction.error||Error('Vorlagen konnten nicht gespeichert werden'));
 });
}
async function loadTemplateStore(){
 try{state.savedTemplates=await templateTransaction('readonly',store=>store.getAll());state.savedTemplates.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));renderTemplateLibrary();}
 catch(e){message('Vorlagenspeicher nicht verfügbar: '+(e.message||e),true);}
}
async function persistTemplateRecord(record){await templateTransaction('readwrite',store=>store.put(record));const index=state.savedTemplates.findIndex(t=>t.id===record.id);if(index>=0)state.savedTemplates[index]=record;else state.savedTemplates.unshift(record);state.savedTemplates.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));renderTemplateLibrary();}
function templateMetaSummary(record){const sizeLabel=record?.sizeLabel||record?.sizeKey||"unbekannte Größe";const when=record?.updatedAt?new Date(record.updatedAt).toLocaleString("de-DE",{dateStyle:"short",timeStyle:"short"}):"";return [sizeLabel+(record?.pageRotation===90?" · 90°":""),when].filter(Boolean).join(" · ");}
function downloadBlob(filename,blob){const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function syncTemplateFields(){
 const entry=state.queue[state.selected],input=$('dd-template-name'),folder=$('dd-template-folder');if(!input||!folder)return;
 if(entry&&!entry.editorId)entry.editorId=uid('edit_');
 const id=entry?.editorId||'';if(input.dataset.entry===id)return;
 input.dataset.entry=id;input.value=entry?.templateName||entry?.name||'';folder.value=entry?.templateFolder||'Meine Vorlagen';
}
function usedFontRecords(entry){
 const ids=new Set((entry.texts||[]).map(t=>t.font));
 return state.fonts.filter(f=>ids.has(f.id)&&f.bytes).map(f=>({id:f.id,name:f.name,bytes:f.bytes.slice(0)}));
}
async function restoreTemplateFonts(record){
 for(const font of record.fonts||[]){if(state.fonts.some(f=>f.id===font.id))continue;state.fonts.push(await installFontRecord(font));}
 renderFonts();
}
async function serializeFonts(fonts){return Promise.all((fonts||[]).map(async f=>({id:f.id,name:f.name,blobData:await blobToDataURL(new Blob([f.bytes],{type:'application/octet-stream'}))})));}
function entryTemplateName(entry){const input=$("dd-template-name");const fromInput=input?.dataset.entry===entry?.editorId?input.value.trim():'';return fromInput||entry?.templateName||entry?.name||("Label "+(state.queue.length||1));}
async function makeTemplateThumbnail(entry,info){
 const full=await renderLabelCanvas(entry,info,{oneBit:true});const t=document.createElement('canvas');const factor=Math.min(1,240/Math.max(full.width,full.height));t.width=Math.max(1,Math.round(full.width*factor));t.height=Math.max(1,Math.round(full.height*factor));t.getContext('2d').drawImage(full,0,0,t.width,t.height);full.width=full.height=0;
 const blob=await new Promise((resolve,reject)=>t.toBlob(v=>v?resolve(v):reject(Error('Vorschaubild konnte nicht erstellt werden')),'image/png'));
 t.width=t.height=0;return blob;
}
async function saveCurrentTemplateToBrowser({saveAs=false}={}){
 if(isBusy())return;
 const entry=state.queue[state.selected];if(!entry){message('Bitte zuerst ein Etikett auswählen oder anlegen.',true);return;}
 clearHistoryTimer();commitHistory();state.templateBusy=true;refreshBusyUi();
 try{
  const name=entryTemplateName(entry),baseInfo=readSize(),id=(!saveAs&&entry.templateId)||uid('tpl_'),now=new Date().toISOString();
  const folder=$('dd-template-folder').value.trim()||'Meine Vorlagen',old=state.savedTemplates.find(t=>t.id===id);
  const record={id,name,folder,createdAt:old?.createdAt||now,updatedAt:now,sizeKey:baseInfo.sizeKey,sizeMeta:{...baseInfo.size},sizeLabel:$('size').selectedOptions[0]?.textContent||'',modelKey:baseInfo.modelKey,modelDpi:baseInfo.model.dpi||201,pageRotation:entry.pageRotation===90?90:0,entry:snapshotClone(entry),fonts:usedFontRecords(entry)};
  record.thumbnail=await makeTemplateThumbnail(record.entry,baseInfo);record.entry=snapshotClone(record.entry);
  for(const key of ['templateId','templateSourceSizeKey','templateSourceSizeMeta','editorId'])delete record.entry[key];
  await persistTemplateRecord(record);
  entry.templateId=id;entry.templateName=name;entry.templateFolder=folder;entry.templateSourceSizeKey=baseInfo.sizeKey;entry.templateSourceSizeMeta={...baseInfo.size};
  showQueue();message((saveAs?'Neue Kopie gespeichert: ':'Vorlage gespeichert: ')+name);
 }finally{state.templateBusy=false;refreshBusyUi();renderTextControls();}
}
async function exportCurrentTemplateFile(){
 if(isBusy())return;
 const current=state.queue[state.selected];if(!current){message('Bitte zuerst ein Etikett auswählen oder anlegen.',true);return;}
 const entry=snapshotClone(current),name=entryTemplateName(current),folder=$('dd-template-folder')?.value||'Meine Vorlagen',baseInfo=snapshotClone(readSize());
 const fonts=usedFontRecords(entry),sizeLabel=$('size').selectedOptions[0]?.textContent?.trim()||'',now=new Date().toISOString();
 const record={version:2,type:'niimbot-template',id:uid('tpl_'),name,folder,createdAt:now,updatedAt:now,sizeKey:baseInfo.sizeKey,sizeMeta:baseInfo.size,modelDpi:baseInfo.model.dpi||baseInfo.size.dpi||201,sizeLabel,modelKey:baseInfo.modelKey,pageRotation:entry.pageRotation===90?90:0,fonts:await serializeFonts(fonts),entry:await serializeEntryForTemplate(entry)};
 const safe=name.replace(/[^a-z0-9äöüß_-]+/gi,'_');downloadBlob(safe+'.niimbot-label.json',new Blob([JSON.stringify(record,null,2)],{type:'application/json'}));message('Vorlage lokal exportiert: '+name);
}
function sameTemplateSize(record,info){const source=record.sizeMeta||sizeByKey(record.sizeKey);return !!source&&Number(source.w_px)===Number(info.size.w_px)&&Number(source.h_px)===Number(info.size.h_px)&&(!record.modelDpi||Number(record.modelDpi)===Number(info.model?.dpi||info.size.dpi||201));}
async function prepareTemplateEntry(record,mode='edit'){
 await restoreTemplateFonts(record);const currentInfo=readSize();let entry=snapshotClone(record.entry);delete entry.editorId;const isSame=sameTemplateSize(record,currentInfo);
 entry.pageRotation=record.pageRotation===90?90:(entry.pageRotation===90?90:0);
 if(!isSame&&!entry.templateFlattened){
  const sourceSize=record.sizeMeta||sizeByKey(record.sizeKey);
  if(sourceSize){
   const fromInfo={...currentInfo,model:{...currentInfo.model,dpi:record.modelDpi||sourceSize.dpi},size:{dpi:record.modelDpi||sourceSize.dpi,...sourceSize},sizeKey:record.sizeKey};
   // Older templates may carry a layout under a different key; normalise to the source key first.
   for(const {layer} of allImages(entry)){const all=layer.layouts||{},key=fromInfo.sizeKey+orientationSuffix(entry);if(!all[key]){const src=Object.values(all)[0];if(src){layer.layouts={...all,[key]:src};}}}
   remapEntry(entry,fromInfo,currentInfo);
  }
 }else{
  const oldKey=record.sizeKey+orientationSuffix(entry),newKey=currentInfo.sizeKey+orientationSuffix(entry);
  if(oldKey!==newKey)for(const layer of [entry,...(entry.images||[])]){if(layer.layouts?.[oldKey])layer.layouts[newKey]=snapshotClone(layer.layouts[oldKey]);}
 }
 entry.templateSourceSizeKey=currentInfo.sizeKey;entry.templateSourceSizeMeta={...currentInfo.size};
 if(mode==='edit'&&isSame)entry.templateId=record.id;else delete entry.templateId;
 entry.templateName=record.name;entry.templateFolder=record.folder||'Meine Vorlagen';
 return {entry,isSame};
}
async function openTemplateRecord(record,{mode='edit'}={}){
 if(isBusy())return;state.templateBusy=true;refreshBusyUi();
 try{
  const {entry,isSame}=await prepareTemplateEntry(record,mode);
  beginHistory('Vorlage '+(mode==='queue'?'in Warteschlange':'öffnen'));
  state.queue.push(entry);state.selected=state.queue.length-1;state.textSelectedId=null;state.activeImageId='image';showQueue();renderTextControls();setImagePanel(activeImageLayer(entry));requestPreview();scheduleHistoryCommit(100);
  if(mode!=='queue')window.NiimbotStudioUI?.selectTab(isSame?'text':'align');
  message(mode==='queue'?'Vorlage zur Warteschlange hinzugefügt: '+record.name:isSame?'Vorlage '+(mode==='copy'?'als Kopie':'zum Bearbeiten')+' geöffnet.':'Vorlage auf '+($('size')?.selectedOptions?.[0]?.textContent?.trim()||'neue Größe')+' angepasst – alle Ebenen bleiben bearbeitbar. Das Original bleibt unverändert gespeichert.');
 }catch(e){message('Vorlage konnte nicht geöffnet werden: '+(e.message||e),true);}finally{state.templateBusy=false;refreshBusyUi();}
}
async function printSavedTemplate(record){return runPrintJob(async()=>[(await prepareTemplateEntry(record,'queue')).entry],1);}
// Moves every text and image layer of an entry from one label size to another.
// Each label size remembers its own arrangement: switching back restores it exactly.
// A size that was never used before gets a proportional copy of the current design,
// so everything stays editable (nothing is flattened into a single picture).
const TEXT_GEOMETRY_KEYS=['x','y','size','boxW','boxH','curveRadius','letterSpace'];
function remapEntry(entry,fromBase,toBase){
 const from=effectiveSizeInfo(entry,fromBase),to=effectiveSizeInfo(entry,toBase);
 const fw=Number(from.size.w_px),fh=Number(from.size.h_px),tw=Number(to.size.w_px),th=Number(to.size.h_px);
 if(!(fw>0&&fh>0&&tw>0&&th>0))return false;
 if(from.sizeKey===to.sizeKey&&fw===tw&&fh===th)return false;
 const sx=tw/fw,sy=th/fh,s=Math.min(sx,sy),dpiRatio=sizeDpi(to.size)/sizeDpi(from.size);
 for(const t of entry.texts||[]){
  t.layouts=(t.layouts&&typeof t.layouts==='object')?t.layouts:{};
  const current={};for(const k of TEXT_GEOMETRY_KEYS)current[k]=Number(t[k])||0;
  t.layouts[from.sizeKey]=current;
  const saved=t.layouts[to.sizeKey];
  if(saved&&TEXT_GEOMETRY_KEYS.every(k=>Number.isFinite(Number(saved[k])))){for(const k of TEXT_GEOMETRY_KEYS)t[k]=Number(saved[k]);continue;}
  t.x=current.x*sx;t.y=current.y*sy;t.size=Math.max(4,Math.min(600,(current.size||32)*s));
  t.boxW=current.boxW?Math.max(20,current.boxW*sx):0;t.boxH=current.boxH?Math.max(20,current.boxH*sy):0;
  t.curveRadius=current.curveRadius*s;t.letterSpace=current.letterSpace*s;
 }
 for(const {layer} of allImages(entry)){
  layer.layouts||={};
  if(layer.layouts[to.sizeKey])continue;
  const old=layer.layouts[from.sizeKey];if(!old)continue;
  const ratio=importDpiValue(layer)?dpiRatio:1;
  layer.layouts[to.sizeKey]={...old,tx:(Number(old.tx)||0)*sx,ty:(Number(old.ty)||0)*sy,scale:clampScale((Number(old.scale)||1)*s/ratio),baseScale:(Number(old.baseScale)||1)*s/ratio,refW:old.refW*ratio,refH:old.refH*ratio};
 }
 return true;
}
function sizeInfoFromSettings(settings){
 const model=state.registry?.models?.[settings?.model],size=sizeByKey(settings?.size);
 if(!model||!size)return null;return {model,size,sizeKey:settings.size,modelKey:settings.model};
}
async function handleSizeChange(){
 if(!loaded()||history.restoring)return;
 updatePrinterSummary();
 const now=readSettings();if(!committedSettings){committedSettings=now;requestPreview();return;}
 if(now.model===committedSettings.model&&now.size===committedSettings.size&&now.density===committedSettings.density)return;
 if(isBusy()){restoreSettings(committedSettings);return;}
 clearHistoryTimer();commitHistory();beginHistory('Druckeinstellungen wechseln');history.hold=true;
 try{
  let newInfo=null;try{newInfo=readSize();}catch(e){}
  const oldInfo=sizeInfoFromSettings(committedSettings);
  let moved=0;
  if(newInfo&&oldInfo&&(now.size!==committedSettings.size||now.model!==committedSettings.model)){
   for(const entry of state.queue)if(remapEntry(entry,oldInfo,newInfo))moved++;
  }
  committedSettings=now;
  if(moved)message('Neue Etikettgröße: '+moved+' Etikett(en) proportional angepasst. Alles bleibt bearbeitbar.');
 }catch(e){restoreSettings(committedSettings);message('Größenwechsel fehlgeschlagen: '+(e.message||e),true);}
 finally{history.hold=false;commitHistory();refreshBusyUi();showQueue();renderTextControls();setImagePanel(activeImageLayer(state.queue[state.selected]));requestPreview();}
}
async function deleteTemplateRecord(id){
 const record=state.savedTemplates.find(t=>t.id===id);if(!record)return;
 if(!window.confirm('Vorlage „'+record.name+'“ wirklich aus diesem Browser löschen?'))return;
 try{await templateTransaction('readwrite',store=>store.delete(id));state.savedTemplates=state.savedTemplates.filter(t=>t.id!==id);renderTemplateLibrary();message('Vorlage gelöscht: '+record.name);}catch(e){message('Löschen fehlgeschlagen: '+(e.message||e),true);}
}
async function exportTemplateRecord(record){
 try{
  const safe=(record.name||'label').replace(/[^a-z0-9äöüß_-]+/gi,'_');
  const copy={...record,entry:await serializeEntryForTemplate(record.entry),thumbnail:undefined,fonts:await serializeFonts(record.fonts||usedFontRecords(record.entry)),version:2,type:'niimbot-template'};
  downloadBlob(safe+'.niimbot-label.json',new Blob([JSON.stringify(copy,null,2)],{type:'application/json'}));
 }catch(e){message('Export fehlgeschlagen: '+(e.message||e),true);}
}
function validateSize(size){
 if(!size||!['w_px','h_px'].every(k=>Number.isFinite(size[k])&&size[k]>=1&&size[k]<=12000)||size.w_px*size.h_px>12000000)throw Error('Ungültige Etikettengröße in der Vorlage.');
 return size;
}
function validateEntry(entry){
 if(!entry||!['blank','image','pdf'].includes(entry.kind)||!Array.isArray(entry.texts)||!Array.isArray(entry.images)||entry.texts.length>100||entry.images.length>100)throw Error('Ungültige Ebenen in der Vorlage.');
 if(entry.layers!==undefined&&(!Array.isArray(entry.layers)||entry.layers.length>201||entry.layers.some(id=>typeof id!=='string')))throw Error('Ungültige Ebenenreihenfolge');
 const ids=new Set(['image']);
 for(const layer of [entry,...entry.images]){
  if(!layer||typeof layer!=='object'||(layer.name!==undefined&&typeof layer.name!=='string'))throw Error('Ungültige Bildbeschreibung');
  if(layer!==entry){if(typeof layer.id!=='string'||!layer.id.startsWith('img:')||ids.has(layer.id))throw Error('Doppelte oder ungültige Bildebene');ids.add(layer.id);}
  if(typeof layer.blobData!=='string'||!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(layer.blobData))throw Error('Ungültige Bilddaten in der Vorlage.');
  for(const l of Object.values(layer.layouts||{}))if(!l||!['tx','ty','scale','baseScale','rotation','refW','refH'].every(k=>Number.isFinite(l[k]))||l.scale<=0||l.scale>50||l.refW<=0||l.refH<=0)throw Error('Ungültige Bildposition in der Vorlage.');
 }
 for(const t of entry.texts){
  if(!t||typeof t.id!=='string'||t.id.startsWith('img:')||ids.has(t.id)||typeof t.text!=='string'||t.text.length>20000)throw Error('Ungültiges Textfeld in der Vorlage.');ids.add(t.id);
  for(const k of ['x','y','size'])if(!Number.isFinite(t[k]))throw Error('Ungültige Textmaße');
  if(t.font!==undefined&&typeof t.font!=='string')throw Error('Ungültige Schriftreferenz');
  for(const k of ['boxW','boxH','rotation','zoomScale','widthPct','curveDeg','curveRadius','letterSpace','lineHeight'])if(t[k]!==undefined&&!Number.isFinite(t[k]))throw Error('Ungültiger Textwert: '+k);
  if(t.size<4||t.size>600||t.zoomScale!==undefined&&(t.zoomScale<.05||t.zoomScale>40))throw Error('Ungültige Textgröße');
  if(t.layouts!==undefined){if(!t.layouts||typeof t.layouts!=='object'||Array.isArray(t.layouts)||Object.keys(t.layouts).length>60)throw Error('Ungültige Textpositionen');for(const l of Object.values(t.layouts))if(!l||typeof l!=='object'||!TEXT_GEOMETRY_KEYS.every(k=>l[k]===undefined||Number.isFinite(l[k])))throw Error('Ungültige Textposition');}
 }
 return entry;
}
async function importTemplateFile(file){
 if(isBusy())return;if(file.size>100*1024*1024)throw Error('Vorlagendatei zu groß (maximal 100 MB).');
 state.templateBusy=true;refreshBusyUi();
 try{
  const parsed=JSON.parse(await file.text(),(k,v)=>{if(['__proto__','constructor','prototype'].includes(k))throw Error('Ungültiges Datenfeld');if(typeof v==='number'&&(!Number.isFinite(v)||Math.abs(v)>1000000))throw Error('Ungültiger Zahlenwert');return v;});
  const items=Array.isArray(parsed)?parsed:[parsed];if(!items.length||items.length>100)throw Error('Bitte 1 bis 100 Vorlagen importieren.');
  const records=[];
  for(const item of items){
   if(item?.type!=='niimbot-template'||![1,2].includes(item.version||1))throw Error('Diese Datei enthält keine unterstützte Niimbot-Vorlage.');
   validateEntry(item.entry);const sizeMeta=validateSize(item.sizeMeta||sizeByKey(item.sizeKey));
   const now=new Date().toISOString(),record={id:uid('tpl_'),name:String(item.name||file.name).slice(0,100),folder:String(item.folder||'Meine Vorlagen').slice(0,100),createdAt:now,updatedAt:now,sizeKey:String(item.sizeKey||''),sizeMeta,sizeLabel:String(item.sizeLabel||''),modelKey:String(item.modelKey||''),modelDpi:item.modelDpi||sizeMeta.dpi||201,pageRotation:item.pageRotation===90?90:0,entry:deserializeTemplateEntry(item.entry),fonts:[]};
   if(item.fonts&&!Array.isArray(item.fonts)||item.fonts?.length>50)throw Error('Ungültige Schriftarten');
   for(const f of item.fonts||[]){
    if(typeof f.id!=='string'||typeof f.blobData!=='string'||f.blobData.length>14000000||!/^data:application\/octet-stream;base64,[A-Za-z0-9+/=]+$/.test(f.blobData))throw Error('Ungültige Schriftdatei');
    const id=uid('font_'),bytes=await dataURLToBlob(f.blobData).arrayBuffer();await new FontFace('NiimbotImportValidation',bytes).load();record.fonts.push({id,name:String(f.name||'Schrift').slice(0,100),bytes});
    for(const t of record.entry.texts)if(t.font===f.id)t.font=id;
   }
   for(const layer of allImages(record.entry))await ensureImage(layer.layer);
   record.entry=snapshotClone(record.entry);records.push(record);
  }
  const db=await templateDB();await new Promise((resolve,reject)=>{const tx=db.transaction('templates','readwrite');tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error||Error('Import abgebrochen'));for(const record of records)tx.objectStore('templates').put(record);});
  state.savedTemplates.unshift(...records);renderTemplateLibrary();message(records.length+' Vorlage(n) importiert.');
 }finally{state.templateBusy=false;refreshBusyUi();}
}
function updateTemplateUiState(){const hasCurrent=!!state.queue[state.selected];for(const id of ["dd-template-save-browser","dd-template-save-as","dd-template-export-file"]){if($(id))$(id).disabled=!hasCurrent||isBusy();}if($("dd-label-rotation-status"))$("dd-label-rotation-status").textContent=state.queue[state.selected]?.pageRotation===90?"90° Hochkant":"0° Querformat";if($("dd-preview-overflow-toggle")){$("dd-preview-overflow-toggle").textContent="⬚ Außen";$("dd-preview-overflow-toggle").setAttribute("aria-pressed",String(state.showOutsideBounds));}if($("dd-printview-toggle")){const b=$("dd-printview-toggle");b.textContent=state.printView?"◐ Druckansicht":"🎨 Original";b.setAttribute("aria-pressed",String(state.printView));b.title=state.printView?"Zeigt genau, was gedruckt wird (nur Schwarz/Weiß). Tippen für Originalfarben.":"Zeigt Originalfarben. Tippen für die echte Druckansicht.";}if($("dd-show-outside-check"))$("dd-show-outside-check").checked=!!state.showOutsideBounds;}
let templateThumbUrls=[];
function renderTemplateLibrary(){
 const list=$('dd-template-list');if(!list)return;
 for(const url of templateThumbUrls)URL.revokeObjectURL(url);templateThumbUrls=[];
 list.replaceChildren();updateTemplateUiState();
 const current=state.queue[state.selected];if($('dd-template-current'))$('dd-template-current').textContent=current?'Aktuell: '+current.name+' · Gespeicherte Originale bleiben unabhängig von neuen Druckgrößen.':'Noch kein Etikett ausgewählt.';
 const q=($('dd-template-search')?.value||'').trim().toLocaleLowerCase('de');
 const filtered=state.savedTemplates.filter(t=>(t.name||'').toLocaleLowerCase('de').includes(q)||(t.folder||'').toLocaleLowerCase('de').includes(q));
 if(!filtered.length){const empty=document.createElement('p');empty.className='dd-muted';empty.textContent=q?'Keine passenden Vorlagen gefunden.':'Noch keine Vorlagen gespeichert.';list.appendChild(empty);return;}
 for(const record of filtered){
  const card=document.createElement('div');card.className='dd-template-card';
  const top=document.createElement('div');top.className='dd-template-cardmain';
  if(record.thumbnail){const image=document.createElement('img');const url=URL.createObjectURL(record.thumbnail);templateThumbUrls.push(url);image.src=url;image.alt='Vorschau '+record.name;top.appendChild(image);}
  const labels=document.createElement('div');labels.className='dd-template-summary';const title=document.createElement('strong');title.textContent=record.name;const sub=document.createElement('div');sub.className='dd-muted';sub.textContent=templateMetaSummary(record);const folder=document.createElement('div');folder.className='dd-caption';folder.textContent='📁 '+(record.folder||'Meine Vorlagen');labels.append(title,sub,folder);top.append(labels);card.appendChild(top);
  const actions=document.createElement('div');actions.className='dd-template-actions';
  for(const [label,action] of [['✏️ Bearbeiten',()=>openTemplateRecord(record,{mode:'edit'})],['⧉ Kopie',()=>openTemplateRecord(record,{mode:'copy'})],['➕ Warteschlange',()=>openTemplateRecord(record,{mode:'queue'})],['🖨 Drucken',()=>printSavedTemplate(record)],['↓ Datei',()=>exportTemplateRecord(record)],['🗑',()=>deleteTemplateRecord(record.id)]]){
   const btn=document.createElement('button');btn.type='button';btn.textContent=label;btn.onclick=action;actions.appendChild(btn);
  }
  card.appendChild(actions);list.appendChild(card);
 }
}
function toggleLabelRotation(){
 const entry=state.queue[state.selected];if(!entry){message('Bitte zuerst ein Etikett auswählen.',true);return;}
 const current=currentEntryAndLayout();if(!current)return;
 // Turning the rectangular print area swaps its logical width/height. The user
 // can choose between a stationary design and rotating every layer with it.
 const rotateWithContent=(state.labelRotateMode==='with');
 const delta=entry.pageRotation===90?-90:90;
 const oldW=current.sizeInfo.size.w_px,oldH=current.sizeInfo.size.h_px;
 const newW=oldH,newH=oldW,oldKey=current.sizeInfo.sizeKey;
 beginHistory('Druckbereich 90° drehen'+(rotateWithContent?' · mit Inhalt':' · Inhalt beibehalten'));
 const transform=(x,y)=>{
  const dx=(Number(x)||0)-oldW/2,dy=(Number(y)||0)-oldH/2;
  return rotateWithContent ? {x:newW/2+(delta===90?-dy:dy),y:newH/2+(delta===90?dx:-dx)} : {x:newW/2+dx,y:newH/2+dy};
 };
 for(const t of entry.texts||[]){
  const pos=transform(t.x,t.y);t.x=pos.x;t.y=pos.y;
  if(rotateWithContent)t.rotation=normalizeAngle((Number(t.rotation)||0)+delta);
 }
 entry.pageRotation=entry.pageRotation===90?0:90;
 const newKey=readSize().sizeKey+orientationSuffix(entry);
 for(const layer of allImages(entry).map(x=>x.layer)){
  const previous=layer.layouts?.[oldKey];if(!previous)continue;
  const next=snapshotClone(previous);
  if(rotateWithContent){
    const tx=Number(previous.tx)||0,ty=Number(previous.ty)||0;
    next.tx=delta===90?-ty:ty;
    next.ty=delta===90?tx:-tx;
    next.rotation=normalizeAngle((Number(previous.rotation)||0)+delta);
  }
  layer.layouts||={};layer.layouts[newKey]=next;
 }
 requestPreview();showQueue();renderTextControls();setImagePanel(activeImageLayer(entry));scheduleHistoryCommit(120);
 message((entry.pageRotation===90?'Hochkant':'Querformat')+': '+(rotateWithContent?'alle Bild- und Textebenen mitgedreht.':'Bild- und Textebenen behalten ihre Ausrichtung.'));
}
function bluetoothHint(){
  const hint=$('dd-blehint'); if(!hint)return;
  if(!window.isSecureContext){hint.hidden=false;hint.textContent='Die App muss über HTTPS oder localhost geöffnet werden. Bitte den GitHub-Pages-Link verwenden, nicht die lokale HTML-Datei.';return;}
  if(!navigator.bluetooth){hint.hidden=false;hint.textContent='Dieser Browser meldet keine Web-Bluetooth-Unterstützung. Auf iPhone/iPad die veröffentlichte HTTPS-Adresse in Bluefy öffnen. Safari und normales iPhone-Chrome eignen sich dafür nicht.';return;}
  hint.hidden=true;
}
const message = (text, isError = false) => {
  $('dd-state').textContent = text;
  $('dd-state').style.color = isError ? '#b42318' : '#244269';
  (isError ? console.error : console.log).call(console, '[dragdrop] '+text);
};
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function buttonState(){
  $('dd-print').disabled = !state.queue.length || isBusy() || !loaded();
  if(!state.printing){const n=state.queue.length*copyCount();$('dd-print').textContent=n>1?'🖨️ Drucken ('+n+')':'🖨️ Drucken';$('dd-print').title=n>1?n+' Etiketten nacheinander drucken':'Etikett drucken';}
  $('dd-clear').disabled = isBusy() || !state.queue.length;
  for(const id of ['dd-files','dd-layer-files','dd-picker','dd-add-layer','dd-add-blank','dd-fontfile','dd-template-import-btn'])if($(id))$(id).disabled=isBusy();
  $('dd-stop').disabled = !state.printing;
}
async function upstreamRegistry(){
  if(state.registry)return state.registry;
  const url = new URL('registry.json', document.baseURI);
  const res = await fetch(url.href);
  if(!res.ok)throw Error('Drucker-Liste nicht verfügbar (HTTP '+res.status+').');
  const reg = await res.json();
  if(!reg.models || !reg.sizes)throw Error('Drucker-Liste hat ein unerwartetes Format.');
  state.registry=reg; return reg;
}
function readSize(){
  if(!loaded())throw Error('Original-App nicht fertig geladen. Seite neu öffnen.');
  const modelKey=$('model').value; const sizeKey=$('size').value; const model=state.registry?.models[modelKey];
  let custom={};
  try{const m=JSON.parse(localStorage.getItem('niimbot-demo:custom-sizes')||'{}'); if(m && typeof m==='object' && !Array.isArray(m)) custom=m;}catch(e){}
  const size=state.registry?.sizes[sizeKey]||custom[sizeKey];
  if(!model||!size||![size.w_px,size.h_px].every(v=>Number.isFinite(v)&&v>=1&&v<=12000)||size.w_px*size.h_px>12000000) throw Error('Bitte oben ein Druckermodell und ein gültiges Etikett auswählen.');
  if(size.dpi && model.dpi && size.dpi!==model.dpi) throw Error('Das gewählte Etikett ist nicht für dieses Druckermodell kalibriert.');
  return {model,size,sizeKey,modelKey,density:Number($('density').value)||model.density||3};
}
function loadScript(url){return new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=url;script.async=true;script.onload=resolve;script.onerror=()=>reject(Error('PDF-Bibliothek nicht geladen. Bitte prüfe, ob pdf.min.js im Hauptverzeichnis liegt.'));document.head.appendChild(script);});}
async function pdfLib(){ if(state.pdfJs)return state.pdfJs; if(!window.pdfjsLib)await loadScript(PDF_URL); if(!window.pdfjsLib)throw Error('PDF.js ist nicht verfügbar.'); window.pdfjsLib.GlobalWorkerOptions.workerSrc=PDF_WORKER; state.pdfJs=window.pdfjsLib; return state.pdfJs; }
function swap(i,j){ [state.queue[i],state.queue[j]]=[state.queue[j],state.queue[i]]; if(state.selected===i)state.selected=j; else if(state.selected===j)state.selected=i; showQueue(); }
const thumbCache=new WeakMap();let thumbJob=null;
function storeThumb(entry,label){
 try{const f=Math.min(1,96/Math.max(label.width,label.height)),c=document.createElement('canvas');c.width=Math.max(1,Math.round(label.width*f));c.height=Math.max(1,Math.round(label.height*f));
  const x=c.getContext('2d');x.imageSmoothingQuality='high';x.drawImage(label,0,0,c.width,c.height);const url=c.toDataURL('image/png');c.width=c.height=0;
  thumbCache.set(entry,url);const i=state.queue.indexOf(entry),img=document.querySelector('#dd-queue [data-index="'+i+'"] .dd-thumb img');if(img)img.src=url;
 }catch(e){}
}
function scheduleThumbs(){
 if(thumbJob)return;
 thumbJob=(async()=>{
  try{
   for(let n=0;n<40;n++){
    if(isBusy())break;
    const entry=state.queue.find(e=>!thumbCache.has(e));if(!entry)break;
    await sleep(60);
    let info;try{info=readSize();}catch(e){break;}
    try{const label=await renderLabelCanvas(entry,info,{oneBit:true});storeThumb(entry,label);label.width=label.height=0;}catch(e){thumbCache.set(entry,'');}
    if(entry!==state.queue[state.selected])releaseDecodedImages(entry);
   }
  }finally{thumbJob=null;}
 })();
}
function selectQueueEntry(i){
 if(i<0||i>=state.queue.length)return;
 state.selected=i;state.textSelectedId=null;state.activeImageId='image';
 showQueue();renderTextControls();setImagePanel(activeImageLayer(state.queue[i]));showPreview();
}
function showQueue(){
  for(const item of state.queue)if(item!==state.queue[state.selected])releaseDecodedImages(item);
  const root=$('dd-queue'); root.replaceChildren(); const total=state.queue.length; const copies=copyCount();
  $('dd-count').textContent=total?(total+(total===1?' Etikett':' Etiketten')+(copies>1?' × '+copies+' Kopien':'')):'Noch kein Etikett';
  if(!total){const p=document.createElement('p');p.className='dd-muted';p.textContent='Die Warteschlange ist leer. Bilder/PDF importieren oder ein leeres Etikett anlegen.';root.append(p);}
  state.queue.forEach((entry,i)=>{
    const row=document.createElement('div'); row.className='dd-queueitem'+(state.selected===i?' selected':''); row.dataset.index=String(i);
    row.addEventListener('click',e=>{if(e.target.closest('button')||isBusy())return;selectQueueEntry(i);});
    const im=document.createElement('div'); im.className='dd-thumb';
    const url=thumbCache.get(entry);
    if(url){const img=document.createElement('img');img.alt='';img.src=url;im.append(img);}else{const img=document.createElement('img');img.alt='';im.append(img);im.dataset.kind=entry.kind==='pdf'?'PDF':'IMG';}
    const details=document.createElement('div');
    const title=document.createElement('div'); title.className='dd-title'; title.textContent=(i+1)+'. '+entry.name+(entry.pageRotation===90?' · 90°':'');
    const sub=document.createElement('div'); sub.className='dd-muted';
    const nImg=allImages(entry).length,nTxt=(entry.texts||[]).length;
    sub.textContent=[nImg?nImg+(nImg===1?' Bild':' Bilder'):'',nTxt?nTxt+(nTxt===1?' Text':' Texte'):'',entry.templateName?'Vorlage: '+entry.templateName:''].filter(Boolean).join(' · ')||'leer';
    details.append(title,sub);
    const buttons=document.createElement('div'); buttons.className='dd-inline';
    const ops=[['↑','Nach oben',()=>swap(i,i-1),i===0],['↓','Nach unten',()=>swap(i,i+1),i===total-1],['🗑','Etikett entfernen',()=>{revokeEntry(state.queue[i]);state.queue.splice(i,1);if(i<state.selected)state.selected--;else if(state.selected>=state.queue.length)state.selected=state.queue.length-1;state.textSelectedId=null;state.activeImageId="image";showQueue();renderTextControls();setImagePanel(activeImageLayer(state.queue[state.selected]));showPreview()},false]];
    for(const [label,title2,action,disabled] of ops){const btn=document.createElement('button');btn.type='button';btn.textContent=label;btn.title=title2;btn.setAttribute('aria-label',title2+': '+entry.name);btn.disabled=isBusy()||disabled;btn.onclick=action;buttons.append(btn);}
    row.append(im,details,buttons); root.append(row);
  }); buttonState(); syncTemplateFields();renderTemplateLibrary();scheduleThumbs();
}
function releaseDecodedImages(entry){
 for(const layer of [entry,...(entry?.images||[])]){
  if(!layer?.img?.naturalWidth)continue;
  if(layer.objectUrl)URL.revokeObjectURL(layer.objectUrl);layer.objectUrl='';layer.img=null;layer.imgPromise=null;
  const cached=adjustedImages.get(layer);if(cached){adjustedPixels-=cached.canvas.width*cached.canvas.height;cached.canvas.width=cached.canvas.height=0;adjustedImages.delete(layer);}
 }
}
function revokeEntry(entry){
 releaseDecodedImages(entry);
 if(entry?.objectUrl){ URL.revokeObjectURL(entry.objectUrl); entry.objectUrl=''; }
 for(const img of entry?.images||[])revokeEntry(img);
}
function decodeBlob(blob){return new Promise((resolve,reject)=>{ const url=URL.createObjectURL(blob), img=new Image(); let settled=false; const done=(error)=>{ if(settled)return; settled=true; URL.revokeObjectURL(url); error?reject(error):resolve(img); }; img.onload=()=>done(); img.onerror=()=>done(Error('Bild konnte nicht dekodiert werden')); img.src=url; if(img.complete && img.naturalWidth)done(); });}
async function ensureImage(entry){
  if(entry.img?.naturalWidth)return entry.img;
  if(entry.imgPromise)return entry.imgPromise;
  entry.imgPromise=new Promise((resolve,reject)=>{
    if(!entry.objectUrl)entry.objectUrl=URL.createObjectURL(entry.blob);
    const img=new Image(); img.onload=()=>{entry.img=img; resolve(img)}; img.onerror=()=>{entry.imgPromise=null;if(entry.objectUrl)URL.revokeObjectURL(entry.objectUrl);entry.objectUrl='';reject(Error('Bildformat ist beschädigt oder nicht unterstützt'));}; img.src=entry.objectUrl;
  });
  return entry.imgPromise;
}
async function rasterizePdfPage(page, importMode){
  const dpi = importMode==='original' ? 144 : Number(importMode)||203;
  let scale = dpi/72; const base = page.getViewport({scale:1});
  if(![base.width,base.height].every(v=>Number.isFinite(v)&&v>0))throw Error('Ungültige PDF-Seitengröße');
  scale=Math.min(scale,8192/base.width,8192/base.height);
  const maxPixels = 8_000_000; if((base.width*scale)*(base.height*scale)>maxPixels) scale=Math.sqrt(maxPixels/(base.width*base.height));
  const viewport=page.getViewport({scale}); const canvas=document.createElement('canvas'); canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height);
  await page.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport,background:'#ffffff'}).promise;
  const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('PDF-Seite konnte nicht gerastert werden')),'image/png'));
  canvas.width=0; canvas.height=0; return blob;
}
function createImageLayer(blob,name,importMode){return {id:'img:'+Date.now().toString(36)+Math.random().toString(36).slice(2),kind:'image',blob,name,importDpi:importMode,locked:false,layouts:{},crop:{x:0,y:0,w:1,h:1,shape:'rect',preset:'free'}};}
async function createEmptyLabelEntry(){
 const canvas=document.createElement('canvas');canvas.width=canvas.height=2;
 const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,2,2);
 const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('Leeres Etikett konnte nicht erstellt werden')),'image/png'));
 canvas.width=canvas.height=0;
 return {kind:'blank',blob,name:'Etikett '+(state.queue.length+1),importDpi:'original',layouts:{},texts:[],images:[],layers:[],pageRotation:0};
}
async function addFiles(files,asLayersOverride=null){
 const input=Array.from(files||[]);if(!input.length||isBusy())return;
 const asLayers=asLayersOverride===null?$('dd-import-mode').value==='layers':Boolean(asLayersOverride);
 let target=state.queue[state.selected]||null;
 clearHistoryTimer();commitHistory();beginHistory('Dateien importieren');history.hold=true;state.importingFiles=true;refreshBusyUi();
 let added=0,skipped=0;const failed=[];const importMode=$('dd-importdpi').value,autoCrop=$('dd-crop-onimport').checked;
 const importedLayers=[];
 const capacity=()=>asLayers?100-(target?allImages(target).length:0):MAX_PAGES-state.queue.length;
 const addBlob=async(blob,name,kind)=>{
  if(capacity()<=0)throw Error('Maximal 100 Etiketten bzw. Bildebenen.');
  let layer;
  if(asLayers){
   if(!target){
    if(state.queue.length>=MAX_PAGES)throw Error('Die Warteschlange ist voll (maximal 100 Etiketten).');
    target=await createEmptyLabelEntry();state.queue.push(target);state.selected=state.queue.length-1;
   }
   target.images||=[];
   layer=createImageLayer(blob,name,importMode);
   layer.initialStackIndex=allImages(target).length;
   target.images.push(layer);
   layerOrder(target);
   state.activeImageId=layer.id;
  }else{
   target={kind,blob,name,importDpi:importMode,layouts:{},texts:[],images:[],crop:{x:0,y:0,w:1,h:1,shape:'rect',preset:'free'},pageRotation:0};
   state.queue.push(target);state.selected=state.queue.length-1;
   layer=target;state.activeImageId='image';
  }
  state.textSelectedId=null;importedLayers.push({entry:target,layer});added++;
 };
 try{
  for(const file of input){
   if(capacity()<=0){skipped++;continue;}
   if(file.size>FILE_LIMIT){skipped++;failed.push(file.name+' (größer als 40 MB)');continue;}
   const ext=(file.name.split('.').pop()||'').toLowerCase();
   try{
    if(file.type==='application/pdf'||ext==='pdf'){
     const lib=await pdfLib(),task=lib.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,useSystemFonts:false,standardFontDataUrl:'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/',cMapUrl:'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',cMapPacked:true});
     try{
      const doc=await task.promise,max=Math.min(doc.numPages,capacity());
      if(max<doc.numPages)skipped+=doc.numPages-max;
      for(let n=1;n<=max;n++){
       const page=await doc.getPage(n);
       try{await addBlob(await rasterizePdfPage(page,importMode),file.name+' – Seite '+n,'pdf');}
       finally{page.cleanup();}
      }
     }finally{await task.destroy();}
    }else if(['png','jpg','jpeg','webp','gif','heic','heif'].includes(ext)||/^image\/(png|jpeg|webp|gif|heic|heif)$/.test(file.type)){
     const decoded=await decodeBlob(file);
     let blob=file;
     if(!['image/png','image/jpeg'].includes(file.type)){
      // Store everything as PNG so templates stay portable between browsers.
      const c=document.createElement('canvas');c.width=decoded.naturalWidth;c.height=decoded.naturalHeight;c.getContext('2d').drawImage(decoded,0,0);
      blob=await new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(Error('Bild konnte nicht umgewandelt werden')),'image/png'));c.width=c.height=0;
     }
     await addBlob(blob,file.name,'image');
     if(/jpe?g|heic|heif/i.test(file.type||ext)){const last=importedLayers.at(-1)?.layer;if(last)imageAdjustments(last).mode='dither';}
    }else{skipped++;failed.push(file.name+' (nur PDF, PNG, JPG)');}
   }catch(e){skipped++;failed.push(file.name+' ('+(e.message||e)+')');}
  }
 }finally{
  history.hold=false;state.importingFiles=false;commitHistory();refreshBusyUi();
  showQueue();renderTextControls();setImagePanel(activeImageLayer(state.queue[state.selected]));requestPreview();
 }
 if(added){
  message(added+(added===1?' Bild/Seite eingefügt':' Bilder/Seiten eingefügt')+(asLayers?' (als Ebenen auf einem Etikett).':' (je ein eigenes Etikett).')+(skipped?' Übersprungen: '+(failed.join(', ')||skipped+' Seite(n) – Grenze 100 erreicht')+'.':''),!!skipped);
  // The crop dialog is interactive and cannot be used while the workspace is disabled for an import.
  // Open it only after import has completed, keeping each crop as a separate undoable step.
  if(autoCrop){
   for(const {entry:owner,layer} of importedLayers){
    const idx=state.queue.indexOf(owner);if(idx<0)continue;
    state.selected=idx;state.textSelectedId=null;
    state.activeImageId=owner===layer?'image':layer.id;
    showQueue();renderTextControls();setImagePanel(layer);await showPreview();
    await openCropEditor(layer);
   }
  }
 }else if(skipped)message('Nicht importiert: '+(failed.join(', ')||skipped+' Datei(en)/Seite(n)')+'.',true);
}
function normalizedCrop(layer){return validNormalizedCrop(layer?.crop||{});}

function sizeDpi(size){return Number(size?.dpi)||203;}
function importDpiValue(layer){const v=Number(layer?.importDpi);return Number.isFinite(v)&&v>=50&&v<=1200?v:0;}
function refSize(entry,img,size){
 const c=normalizedCrop(entry),w=img.naturalWidth*c.w,h=img.naturalHeight*c.h;
 const dpi=importDpiValue(entry);
 if(dpi)return {w:w*(sizeDpi(size)/dpi),h:h*(sizeDpi(size)/dpi)};
 return {w,h};
}

function initLayout(entry,sizeInfo,img,mode){
  const ref=refSize(entry,img,sizeInfo.size); const fit=mode || $('dd-fit').value; let scale=(fit==='cover'?Math.max(sizeInfo.size.w_px/ref.w,sizeInfo.size.h_px/ref.h):Math.min(sizeInfo.size.w_px/ref.w,sizeInfo.size.h_px/ref.h));
  if(!isFinite(scale)||scale<=0)scale=1;
  // Subsequent images initially appear smaller and slightly offset instead of hiding every prior image.
  // Their positions remain fully editable; this affects only the first automatic layout.
  const stack=Math.max(0,Number(entry.initialStackIndex)||0);
  let tx=0,ty=0;
  if(stack>0&&fit!=='cover'){
    const positions=[[.12,.10],[-.12,-.10],[.12,-.10],[-.12,.10]];
    const [dx,dy]=positions[(stack-1)%positions.length];
    scale*=.72;tx=sizeInfo.size.w_px*dx;ty=sizeInfo.size.h_px*dy;
  }
  entry.layouts ||= {}; entry.layouts[sizeInfo.sizeKey]={tx,ty,scale,baseScale:scale,rotation:0,refW:ref.w,refH:ref.h}; return entry.layouts[sizeInfo.sizeKey];
}
async function getLayout(entry,sizeInfo,modeIfInit){ const img=await ensureImage(entry); let layout=entry.layouts?.[sizeInfo.sizeKey]; const ref=refSize(entry,img,sizeInfo.size); if(!layout || Math.abs(layout.refW-ref.w)>.001 || Math.abs(layout.refH-ref.h)>.001) layout=initLayout(entry,sizeInfo,img,modeIfInit); return {img,layout}; }
// The image and text are rasterized by the SAME function for screen and printer.
function clampScale(v){ return Math.max(.015,Math.min(50,Number(v)||1)); }
function normalizeAngle(a){ return (((Number(a)||0)+180)%360+360)%360-180; }
function degrees(angle){ return (Number(angle)||0)*Math.PI/180; }
function updateEditorViewport(size){
 const canvas=$('dd-editor'),wrap=$('dd-editorwrap');if(!canvas||!wrap)return;
 if($('dd-workspace')){canvas.style.removeProperty('height');return;}
 const wrapW=Math.max(230,Math.round(wrap.clientWidth||canvas.clientWidth||320));
 const ratio=size?Math.max(.3,Math.min(2.9,size.h_px/size.w_px)):.75;
 const mobile=window.innerWidth<=520;
 const h=Math.max(mobile?330:405,Math.min(mobile?690:790,Math.round(wrapW*Math.max(.75,ratio)+115)));
 canvas.style.height=h+'px';
 // The slider is deliberately compact and does not stretch with the canvas.
}

function editorSize(){
 const c=$('dd-editor'),dpr=Math.max(1,Math.min(3,window.devicePixelRatio||1));
 const cssW=Math.max(1,Math.round(c.clientWidth||320)),cssH=Math.max(1,Math.round(c.clientHeight||320));
 c.width=Math.round(cssW*dpr);c.height=Math.round(cssH*dpr);
 const ctx=c.getContext('2d');ctx.setTransform(c.width/cssW,0,0,c.height/cssH,0,0);return {ctx,cssW,cssH};
}
function cropForViewport(cssW,cssH,size,viewZoom=1){
 // Leaves room for the handles around the label and for the zoom buttons at the bottom.
 const pad=Math.max(22,Math.round(Math.min(cssW,cssH)*.08)),bottom=44;
 const fit=Math.max(.0001,Math.min(Math.max(1,cssW-2*pad)/size.w_px,Math.max(1,cssH-pad-Math.max(pad,bottom))/size.h_px));
 const previewScale=fit*Math.max(.2,Math.min(4,Number(viewZoom)||1));
 const w=size.w_px*previewScale,h=size.h_px*previewScale;
 return {x:(cssW-w)/2,y:(cssH-Math.max(pad,bottom)+pad-h)/2,w,h,scale:previewScale};
}

function rotatedPoint(cx,cy,dx,dy,deg){ const r=degrees(deg),co=Math.cos(r),si=Math.sin(r);return {x:cx+dx*co-dy*si,y:cy+dx*si+dy*co}; }
function imageRect(layout,sizeInfo,crop){ const {size}=sizeInfo;const scale=crop.scale;const cx=crop.x+crop.w/2+layout.tx*scale,cy=crop.y+crop.h/2+layout.ty*scale;const halfW=layout.refW*layout.scale*scale/2,halfH=layout.refH*layout.scale*scale/2;return {cx,cy,halfW,halfH,angle:layout.rotation||0,tl:rotatedPoint(cx,cy,-halfW,-halfH,layout.rotation),tr:rotatedPoint(cx,cy,halfW,-halfH,layout.rotation),br:rotatedPoint(cx,cy,halfW,halfH,layout.rotation),bl:rotatedPoint(cx,cy,-halfW,halfH,layout.rotation)}; }
function textScale(t){return Math.max(.05,Math.min(40,Number(t?.zoomScale)||1));}
function canvasFont(ctx,t){
 const fontSize=Math.max(4,Math.min(600,Number(t.size)||30));
 const generic=(t.font||'system:sans-serif').startsWith('system:');
 const family=generic?(t.font||'system:sans-serif').slice(7):(state.fonts.find(f=>f.id===t.font)?.family||'sans-serif');
 ctx.font=`${t.italic?'italic ':''}${t.bold?'bold ':''}${fontSize}px ${generic?family:'"'+family.replace(/"/g,'')+'", sans-serif'}`;
 return fontSize;
}
function glyphWidth(ctx,text,spacing){ const chars=Array.from(text); return ctx.measureText(text).width + Math.max(0,chars.length-1)*(Number(spacing)||0); }
function splitLines(ctx,text,maxWidth,letterSpacing){ const result=[];for(const original of String(text||' ').split(/\r?\n/)){
  const words=original.split(/(\s+)/).filter(s=>s.length>0);let line='';if(!words.length){result.push(' ');continue;}
  for(const word of words){const candidate=line+word;if(glyphWidth(ctx,candidate,letterSpacing)<=maxWidth){line=candidate;continue;}
    if(line.trim()){result.push(line.trimEnd());line='';}
    if(glyphWidth(ctx,word,letterSpacing)<=maxWidth){line=word.trimStart();continue;}
    for(const char of Array.from(word)){const candidate2=line+char;if(glyphWidth(ctx,candidate2,letterSpacing)>maxWidth&&line){result.push(line);line=char;}else line=candidate2;}
  } result.push(line||' ');
 }return result.slice(0,120);}
function imageIds(entry){return (entry.images||[]).map(im=>im.id);}
function allImages(entry){return (entry.kind==='blank'?[]:[{id:'image',layer:entry}]).concat((entry.images||[]).map(layer=>({id:layer.id,layer})));}
function imageForId(entry,id){if(!entry||!id)return null;if(id==='image')return entry.kind==='blank'?null:entry;return (entry.images||[]).find(im=>im.id===id)||null;}
function activeImageLayer(entry){
 if(!entry)return null;
 const image=imageForId(entry,state.activeImageId);
 return image||allImages(entry)[0]?.layer||null;
}
function setActiveImage(entry,id){
 if(layerLocked(entry,id))return;
 state.textSelectedId=null;
 state.activeImageId=imageForId(entry,id)?id:(allImages(entry)[0]?.id||'image');
 renderTextControls();setImagePanel(activeImageLayer(entry));requestPreview();
}
function getLayerObject(entry,id){
 if(!entry)return null;
 return imageForId(entry,id)||(entry.texts||[]).find(t=>t.id===id)||null;
}
function layerLocked(entry,id){return !!getLayerObject(entry,id)?.locked;}
function selectedLocked(){const entry=state.queue[state.selected];return !!entry && layerLocked(entry,state.textSelectedId||state.activeImageId);}
function unlockRequired(){if(selectedLocked()){message('Diese Ebene ist gesperrt. Bitte zuerst über das Schloss in der Ebenenliste entsperren.',true);return false;}return true;}
function toggleLayerLock(id){
 const entry=state.queue[state.selected],layer=getLayerObject(entry,id);if(!layer||state.printing)return;
 layer.locked=!layer.locked;
 if(layer.locked){
  if(state.textSelectedId===id)state.textSelectedId=null;
  if(state.activeImageId===id)state.activeImageId=allImages(entry).find(x=>!x.layer.locked)?.id||id;
  state.editor.mode=null;state.editor.start=null;state.editor.pointers.clear();
 }
 renderTextControls();setImagePanel(activeImageLayer(entry));requestPreview();
 message(layer.locked?'Ebene gesperrt – bleibt sichtbar und wird gedruckt.':'Ebene entsperrt – wieder bearbeitbar.');
}
function layerOrder(entry){
 const all=(entry.kind==='blank'?[]:['image']).concat(imageIds(entry),(entry.texts||[]).map(t=>t.id));
 entry.layers ||= [...all];
 entry.layers=entry.layers.filter(id=>all.includes(id));
 for(const id of all)if(!entry.layers.includes(id))entry.layers.push(id);
 return entry.layers;
}
function selectLayer(id){
 const entry=state.queue[state.selected];if(!entry||layerLocked(entry,id))return;
 if(id==='image'||id.startsWith('img:'))setActiveImage(entry,id);
 else{state.textSelectedId=id;renderTextControls();requestPreview();}
 // After selecting via the layers panel, arrow keys should immediately move it.
 const canvas=$('dd-editor');if(canvas)requestAnimationFrame(()=>canvas.focus({preventScroll:true}));
}
function moveLayer(id,position){
 const entry=state.queue[state.selected];if(!entry||layerLocked(entry,id))return;const order=layerOrder(entry),i=order.indexOf(id);if(i<0)return;
 order.splice(i,1);const target=position==='front'?order.length:position==='back'?0:Math.max(0,Math.min(order.length,i+position));order.splice(target,0,id);renderTextControls();requestPreview();
}
function removeImageLayer(id){
 const entry=state.queue[state.selected];if(!entry||state.printing||layerLocked(entry,id))return;
 if(id==='image'){
   if(entry.objectUrl)URL.revokeObjectURL(entry.objectUrl);entry.objectUrl='';entry.kind='blank';entry.img=null;entry.imgPromise=null;entry.layouts={};
   // Discard the original image bytes as well, including from subsequently exported templates.
   entry.blob=dataURLToBlob('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8//8/AwMDEwMDAwMDAwAkBgMB/DXemwAAAABJRU5ErkJggg==');
 }else{const idx=(entry.images||[]).findIndex(im=>im.id===id);if(idx<0)return;revokeEntry(entry.images[idx]);entry.images.splice(idx,1);}
 entry.layers=(entry.layers||[]).filter(x=>x!==id);
 if(state.activeImageId===id)state.activeImageId=allImages(entry).at(-1)?.id||'image';
 renderTextControls();setImagePanel(activeImageLayer(entry));showQueue();requestPreview();
}
function renderLayerControls(){
 const entry=state.queue[state.selected],root=$('dd-layers');if(!root)return;root.replaceChildren();if(!entry)return;
 const order=layerOrder(entry);
 [...order].reverse().forEach(id=>{
  const text=(entry.texts||[]).find(t=>t.id===id),im=imageForId(entry,id),row=document.createElement('div');row.className='dd-layer';
  row.dataset.selected=String((!state.textSelectedId&&state.activeImageId===id)||(state.textSelectedId===id));
  const title=document.createElement('label');title.textContent=im?'🖼️ '+(id==='image'?entry.name:im.name||'Bild'):('🔤 '+(text?.text||'Textfeld').replace(/\s+/g,' ').slice(0,30));
  const sel=document.createElement('button');sel.type='button';sel.textContent='Wählen';sel.disabled=layerLocked(entry,id);sel.onclick=()=>selectLayer(id);
  const up=document.createElement('button');up.type='button';up.textContent='↑';up.title='Eine Ebene nach vorne';up.disabled=order.at(-1)===id||layerLocked(entry,id);up.onclick=()=>moveLayer(id,1);
  const down=document.createElement('button');down.type='button';down.textContent='↓';down.title='Eine Ebene nach hinten';down.disabled=order[0]===id||layerLocked(entry,id);down.onclick=()=>moveLayer(id,-1);
  const locked=layerLocked(entry,id);row.dataset.locked=String(locked);
  const lock=document.createElement('button');lock.type='button';lock.className='dd-lock-toggle';lock.dataset.layerId=id;
  lock.textContent=locked?'🔒':'🔓';lock.title=locked?'Ebene entsperren':'Ebene gegen Änderungen sperren';
  lock.setAttribute('aria-label',lock.title);lock.setAttribute('aria-pressed',String(locked));
  lock.onclick=()=>toggleLayerLock(id);
  row.append(title,lock,sel,up,down);
  if(im){const crop=document.createElement('button');crop.type='button';crop.textContent='✂';crop.title='Diese Bilddatei zuschneiden';crop.disabled=locked;crop.onclick=()=>{setActiveImage(entry,id);openCropEditor(im);};row.append(crop);
  const remove=document.createElement('button');remove.type='button';remove.textContent='🗑 Entfernen';remove.title='Nur diese Bildebene entfernen, nicht das gesamte Etikett';remove.setAttribute('aria-label','Bildebene '+(im.name||entry.name)+' entfernen');remove.disabled=locked;remove.onclick=()=>removeImageLayer(id);row.append(remove);}
  root.append(row);
 });
 const active=activeImageLayer(entry);if($('dd-active-image'))$('dd-active-image').textContent=state.textSelectedId?'Aktiv: Textfeld':active?'Aktives Bild: '+(active.name||entry.name)+' · Bild- und Beschnittwerte gelten nur für diese Ebene':'Kein Bild ausgewählt';
 if($('dd-crop-image'))$('dd-crop-image').disabled=!active||state.printing||!!active.locked;
 if($('dd-remove-selected-image'))$('dd-remove-selected-image').disabled=!active||isBusy()||!!active.locked;
}

function splitLinesByMode(ctx,text,maxWidth,spacing,mode){
 if(mode==='off')return String(text||' ').split(/\r?\n/).slice(0,120);
 if(mode==='char'){
   const lines=[];for(const original of String(text||' ').split(/\r?\n/)){
     let line='';for(const ch of Array.from(original)){if(line&&glyphWidth(ctx,line+ch,spacing)>maxWidth){lines.push(line);line='';}line+=ch;}lines.push(line||' ');
   }return lines.slice(0,120);
 }
 return splitLines(ctx,text,maxWidth,spacing);
}
function textFlow(t){ return t?.flow||'horizontal'; }
function curveTextContent(t){ return String(t?.text||' ').replace(/\s*\r?\n\s*/g,' ').trim() || ' '; }
function verticalLines(t){ const chars=Array.from(String(t?.text||' ').replace(/\r/g,'')); const out=[]; for(const ch of chars){ if(ch==='\n') continue; out.push(ch===' ' ? ' ' : ch); } return out.length ? out.slice(0,220) : [' ']; }
function normalizeCurveDeg(v){ const n=Number(v); return Number.isFinite(n)?Math.max(-360,Math.min(360,n)):180; }
function curveRadiusForBox(width,height,fs){ return Math.max(fs*1.05, Math.min(width,height)*0.5 - fs*0.95 - 6); }
function curvePlacement(t){ return ['top','bottom','circle'].includes(t?.curvePlacement)?t.curvePlacement:'top'; }
function curveFacing(t){ return t?.curveFacing==='inside'?'inside':'outside'; }
function effectiveCurveRadius(t,g){ const manual=Number(t?.curveRadius)||0; return manual>0 ? Math.max(g.fs*0.9,manual) : curveRadiusForBox(g.boxWidth,g.boxHeight,g.fs); }
function textGeometry(ctx,t,labelW){
 ctx.save();let fs=canvasFont(ctx,t),spacing=Number(t.letterSpace)||0;
 const desiredW=Number(t.boxW)||Math.max(30,labelW*Math.max(.1,Math.min(2,(Number(t.widthPct)||85)/100)));
 const manualDiameter=textFlow(t)==='curve'&&Number(t.curveRadius)>0?2*(Number(t.curveRadius)+fs+6):0;
 const boxWidth=Math.min(4000,Math.max(20,desiredW,manualDiameter));
 const flow=textFlow(t), available=Math.max(4,boxWidth-10);
 let lines;
 if(flow==='curve') lines=[curveTextContent(t)];
 else if(flow==='vertical') lines=verticalLines(t);
 else lines=splitLinesByMode(ctx,t.text,available,spacing,t.wrap||'word');
 if(t.autoFit){
   const wantedMaxHeight=Math.max(20,Number(t.boxH)||1e6);
   for(let j=0;j<45;j++){
     let width,height;
     if(flow==='curve'){
       width=Math.min(boxWidth-10, Math.max(...lines.map(s=>glyphWidth(ctx,s,spacing))));
       height=Math.max(fs*2.8, Math.min(boxWidth, boxWidth*.95));
     }else{
       width=Math.max(...lines.map(s=>glyphWidth(ctx,s,spacing)));
       height=lines.length*fs*Math.max(.7,Math.min(3,(Number(t.lineHeight)||120)/100));
     }
     if(width<=available && height<=wantedMaxHeight-8)break;
     fs=Math.max(4,fs*.95);canvasFont(ctx,{...t,size:fs});
     if(flow==='curve') lines=[curveTextContent(t)];
     else if(flow==='vertical') lines=verticalLines(t);
     else lines=splitLinesByMode(ctx,t.text,available,spacing,t.wrap||'word');
   }
 }
 const lineHeight=fs*Math.max(.7,Math.min(3,(Number(t.lineHeight)||120)/100));
 let naturalH=lines.length*lineHeight+10;
 if(flow==='curve') naturalH=Math.max(fs*2.8, Math.min(boxWidth, Math.max(Number(t.curveRadius)||0,boxWidth*.92)));
 const boxHeight=Math.min(4000,Math.max(20,Number(t.boxH)||naturalH,manualDiameter));
 ctx.restore();return {lines,fs,lineHeight,boxWidth,boxHeight,spacing,flow,curveDeg:curvePlacement(t)==='circle'?360:Math.abs(normalizeCurveDeg(t.curveDeg))};
}
function drawSpacedText(ctx,str,x,y,spacing){ if(!spacing){ctx.fillText(str,x,y);return;} for(const ch of Array.from(str)){ctx.fillText(ch,x,y);x+=ctx.measureText(ch).width+spacing;} }
function drawCurvedTextItem(ctx,t,g){
 const text=g.lines[0]||' ';
 const chars=Array.from(text);
 const theta=degrees(Math.abs(g.curveDeg??180));
 if(theta<0.001 || chars.length===0){ drawSpacedText(ctx,text,-glyphWidth(ctx,text,g.spacing)/2,0,g.spacing); return; }
 const placement=curvePlacement(t), facing=curveFacing(t), radius=effectiveCurveRadius(t,g);
 const weights=chars.map(ch=>Math.max(0.0001, ctx.measureText(ch).width + (g.spacing||0)));
 const total=weights.reduce((a,b)=>a+b,0) || 1;
 let startAngle, direction, rotationOffset;
 if(placement==='bottom'){
   startAngle=Math.PI + theta/2;
   direction=-1;
   rotationOffset=(facing==='outside') ? Math.PI : 0;
 }else if(placement==='circle'){
   startAngle=-theta/2;
   direction=1;
   rotationOffset=(facing==='outside') ? 0 : Math.PI;
 }else{
   startAngle=-theta/2;
   direction=1;
   rotationOffset=(facing==='outside') ? 0 : Math.PI;
 }
 let cursor=startAngle;
 ctx.textAlign='center'; ctx.textBaseline='middle';
 chars.forEach((ch,idx)=>{
   const span=theta*(weights[idx]/total), mid=cursor + direction*span/2;
   const x=Math.sin(mid)*radius, y=-Math.cos(mid)*radius;
   const rot=mid + rotationOffset;
   ctx.save();
   ctx.translate(x,y);
   ctx.rotate(rot);
   ctx.fillText(ch,0,0);
   if(t.underline){ const w=Math.max(1,ctx.measureText(ch).width); ctx.fillRect(-w/2,g.fs*.43,w,Math.max(1,g.fs*.055)); }
   if(t.strike){ const w=Math.max(1,ctx.measureText(ch).width); ctx.fillRect(-w/2,g.fs*.03,w,Math.max(1,g.fs*.055)); }
   ctx.restore();
   cursor += direction*span;
 });
}
function drawTextItem(ctx,t,labelW,{guides=false}={}){
 ctx.save();ctx.translate(t.x,t.y);ctx.rotate(degrees(t.rotation));ctx.scale(textScale(t),textScale(t));
 const g=textGeometry(ctx,t,labelW);canvasFont(ctx,{...t,size:g.fs});ctx.textBaseline='middle';
 const width=g.boxWidth,height=g.boxHeight;
 if(t.inverse){ctx.fillStyle='#000';ctx.fillRect(-width/2,-height/2,width,height);ctx.fillStyle='#fff';}
 else ctx.fillStyle='#000';
 ctx.save();ctx.beginPath();ctx.rect(-width/2,-height/2,width,height);ctx.clip();
 if(g.flow==='curve'){
   drawCurvedTextItem(ctx,t,g);
 }else{
   const totalH=g.lines.length*g.lineHeight,top=(t.vertical==='top'?-height/2+5:t.vertical==='bottom'?height/2-totalH-5:-totalH/2);
   g.lines.forEach((line,index)=>{
     const lineW=glyphWidth(ctx,line,g.spacing),left=t.align==='left'||t.align==='justify'?-width/2+5:t.align==='right'?width/2-5-lineW:-lineW/2,y=top+(index+.5)*g.lineHeight;
     if(t.align==='justify' && index<g.lines.length-1 && line.trim().includes(' ')){
        const parts=line.trim().split(/(\s+)/);let x=left;const extra=Math.max(0,(width-10-lineW)/(parts.filter(v=>/^\s+$/.test(v)).length||1));
        for(const part of parts){drawSpacedText(ctx,part,x,y,g.spacing);x+=glyphWidth(ctx,part,g.spacing)+(/^\s+$/.test(part)?extra:0);}
     }else drawSpacedText(ctx,line,left,y,g.spacing);
     if(t.underline)ctx.fillRect(left,y+g.fs*.43,Math.max(1,lineW),Math.max(1,g.fs*.055));
     if(t.strike)ctx.fillRect(left,y+g.fs*.03,Math.max(1,lineW),Math.max(1,g.fs*.055));
   });
 }
 ctx.restore();
 if(guides){ctx.strokeStyle='#0ea5e9';ctx.lineWidth=1.5;ctx.setLineDash([4,3]);ctx.strokeRect(-width/2,-height/2,width,height);}
 ctx.restore();return g;
}
const ADJUST_DEFAULTS={exposure:0,contrast:0,blacks:0,whites:0,brightness:0,saturation:0,gamma:1,threshold:128,mode:'default'};
const ADJUST_KEYS=['exposure','contrast','blacks','whites','brightness','saturation','gamma'];
function imageAdjustments(entry){return entry.adjustments ||= {...ADJUST_DEFAULTS};}
function adjustFormat(key,value){return key==='gamma'?Number(value).toFixed(2):String(Math.round(Number(value)));}
function adjustNormalize(key,value){
 const slider=$('dd-'+key), min=Number(slider.min),max=Number(slider.max),step=Number(slider.step)||1;
 const finite=Number(value);if(!Number.isFinite(finite))return null;
 // Integer step indexing avoids accumulating 0.05 floating-point errors for gamma.
 const clamped=Math.max(min,Math.min(max,finite));
 return Number((min+Math.round((clamped-min)/step)*step).toFixed(key==='gamma'?2:0));
}
function syncAdjustControl(key,value,{preserveNumberFocus=false}={}){
 const slider=$('dd-'+key),number=$('dd-'+key+'-number'),display=$('dd-'+key+'-value');
 const normalized=adjustNormalize(key,value);if(normalized===null)return;
 slider.value=String(normalized);
 if(!preserveNumberFocus || document.activeElement!==number)number.value=String(normalized);
 display.textContent=adjustFormat(key,normalized);
 $('dd-'+key+'-minus').disabled=normalized<=Number(slider.min);
 $('dd-'+key+'-plus').disabled=normalized>=Number(slider.max);
}
function setImageAdjustValue(key,value,{preserveNumberFocus=false}={}){
 const normalized=adjustNormalize(key,value);
 if(normalized===null)return false;
 const entry=activeImageLayer(state.queue[state.selected]);
 if(!entry||entry.locked)return false;
 imageAdjustments(entry)[key]=normalized;
 syncAdjustControl(key,normalized,{preserveNumberFocus});
 requestPreview();
 return true;
}
function setImagePanel(entry){
 const values=entry?imageAdjustments(entry):ADJUST_DEFAULTS;
 const disabled=!entry||!!entry.locked,mode=entry?layerPrintMode(entry):'bw';
 $('dd-bw').value=mode;$('dd-bw').disabled=disabled;$('dd-adjust-reset').disabled=disabled;
 for(const key of ADJUST_KEYS){
   syncAdjustControl(key,values[key]??ADJUST_DEFAULTS[key]);
   for(const suffix of ['','-number','-minus','-plus'])$('dd-'+key+suffix).disabled=disabled;
 }
 syncThresholdControl();
}
// ---- Black/white threshold, shown in the preview header next to the print view ----
function effectiveThreshold(layer){
 const a=imageAdjustments(layer);
 if(a.mode==='bw'){const v=Number(a.threshold);return Number.isFinite(v)?Math.max(1,Math.min(254,Math.round(v))):128;}
 return 128; // 'default' (V17 and earlier) = the printer driver's own 50 % rule
}
function syncThresholdControl(){
 const wrap=$('dd-threshold-wrap');if(!wrap)return;
 const entry=state.queue[state.selected],layer=activeImageLayer(entry);
 wrap.hidden=!layer;if(!layer)return;
 const dither=layerPrintMode(layer)==='dither',off=dither||!!layer.locked,value=effectiveThreshold(layer);
 const slider=$('dd-threshold');
 if(document.activeElement!==slider)slider.value=String(value);
 $('dd-threshold-value').textContent=String(value);
 for(const el of [slider,$('dd-threshold-minus'),$('dd-threshold-plus')])el.disabled=off;
 wrap.classList.toggle('dd-off',off);
 wrap.title=layer.locked?'Bild ist gesperrt':dither?'Bei „Foto – Rasterung“ gibt es keine Schwelle. Im Tab „Bild“ auf Schwarzweiß umstellen.':'Schwarzweiß-Schwelle für „'+(layer.name||'Bild')+'“: höher = mehr Schwarz, niedriger = mehr Weiß';
}
function setThreshold(value){
 const layer=activeImageLayer(state.queue[state.selected]);if(!layer||layer.locked||layerPrintMode(layer)==='dither')return;
 const a=imageAdjustments(layer);a.mode='bw';a.threshold=Math.max(1,Math.min(254,Math.round(Number(value)||128)));
 if(!state.printView){state.printView=true;try{localStorage.setItem('niimbot-studio:printview','1');}catch(e){}updateTemplateUiState();message('Druckansicht eingeschaltet, damit die Wirkung der Schwelle sichtbar ist.');}
 $('dd-bw').value='bw';syncThresholdControl();requestPreview();
}
function clamp01(v){return Math.max(0,Math.min(1,v));}
function applyAdjustments(ctx,w,h,a){
 // Tonal corrections only. The 1-bit conversion for the thermal printer happens later,
 // at the final label resolution (see binarizeLayerCanvas / finalizeOneBit).
 const brightness=(Number(a.brightness)||0)/100, exposure=Math.pow(2,(Number(a.exposure)||0)/45),contrast=(Number(a.contrast)||0)/100;
 const black=(Number(a.blacks)||0)/100,white=(Number(a.whites)||0)/100,sat=1+(Number(a.saturation)||0)/100,gamma=Number(a.gamma)||1;
 if(!brightness&&!contrast&&!black&&!white&&sat===1&&gamma===1&&exposure===1)return;
 const img=ctx.getImageData(0,0,w,h),px=img.data;
 const contrastFactor=contrast>=0?1+contrast*2:1/(1-contrast*2);
 const adj=v=>{v=clamp01(v*exposure+brightness);
   v=clamp01(.5+(v-.5)*contrastFactor);
   v=clamp01(v-black*Math.pow(1-v,2)*.75+white*Math.pow(v,2)*.75);
   return clamp01(Math.pow(v,1/gamma));};
 const lut=new Uint8ClampedArray(256);for(let i=0;i<256;i++)lut[i]=Math.round(adj(i/255)*255);
 for(let i=0;i<px.length;i+=4){if(!px[i+3])continue;
   let r=px[i]/255,g=px[i+1]/255,b=px[i+2]/255;
   if(sat!==1){const l=.2126*r+.7152*g+.0722*b;r=clamp01(l+(r-l)*sat);g=clamp01(l+(g-l)*sat);b=clamp01(l+(b-l)*sat);}
   px[i]=lut[Math.round(r*255)];px[i+1]=lut[Math.round(g*255)];px[i+2]=lut[Math.round(b*255)];
 }
 ctx.putImageData(img,0,0);
}
// ---- Thermal printer output: exactly what the driver will print ----
// The Niimbot driver turns every pixel with luminance < 128 into a black dot. To make the
// preview honest and photos printable, every image layer is converted to pure black/white
// at label resolution: a fixed or custom threshold, or Floyd-Steinberg dithering for photos.
function layerPrintMode(layer){const m=imageAdjustments(layer).mode;return (m==='gray'||m==='dither')?'dither':'bw';}
function binarizeLayerCanvas(canvas,mode,threshold){
 const w=canvas.width,h=canvas.height;if(!w||!h)return;
 const ctx=canvas.getContext('2d',{willReadFrequently:true}),img=ctx.getImageData(0,0,w,h),px=img.data;
 const thr=mode==='bw'?Math.max(1,Math.min(254,Number(threshold)||128)):128;
 if(mode==='dither'){
  const lum=new Float32Array(w*h),solid=new Uint8Array(w*h);
  for(let i=0,p=0;p<lum.length;i+=4,p++){const a=px[i+3]/255;if(a<.5)continue;solid[p]=1;lum[p]=(.299*px[i]+.587*px[i+1]+.114*px[i+2])*a+255*(1-a);}
  for(let y=0;y<h;y++){const ltr=!(y&1);
   for(let k=0;k<w;k++){const x=ltr?k:w-1-k,p=y*w+x;if(!solid[p])continue;
    const old=lum[p],nv=old<128?0:255,err=old-nv,d=ltr?1:-1;lum[p]=nv;
    if(x+d>=0&&x+d<w&&solid[p+d])lum[p+d]+=err*7/16;
    if(y+1<h){const q=p+w;if(x-d>=0&&x-d<w&&solid[q-d])lum[q-d]+=err*3/16;if(solid[q])lum[q]+=err*5/16;if(x+d>=0&&x+d<w&&solid[q+d])lum[q+d]+=err/16;}
   }}
  for(let i=0,p=0;p<lum.length;i+=4,p++){if(!solid[p]){px[i+3]=0;continue;}const v=lum[p]<128?0:255;px[i]=px[i+1]=px[i+2]=v;px[i+3]=255;}
 }else{
  for(let i=0;i<px.length;i+=4){const a=px[i+3]/255;if(a<.5){px[i+3]=0;continue;}
   const l=(.299*px[i]+.587*px[i+1]+.114*px[i+2])*a+255*(1-a),v=l<thr?0:255;px[i]=px[i+1]=px[i+2]=v;px[i+3]=255;}
 }
 ctx.putImageData(img,0,0);
}
function finalizeOneBit(canvas){
 // Same rule as niimbot.js imageToPacked(): luminance < 128 prints black.
 const ctx=canvas.getContext('2d',{willReadFrequently:true}),img=ctx.getImageData(0,0,canvas.width,canvas.height),px=img.data;
 for(let i=0;i<px.length;i+=4){const v=(.299*px[i]+.587*px[i+1]+.114*px[i+2])<128?0:255;px[i]=px[i+1]=px[i+2]=v;px[i+3]=255;}
 ctx.putImageData(img,0,0);
}
function drawImageAtLayout(ctx,img,layout,pxPerLabel=1,view=null,layer=null){
 const cx=view?view.x+view.w/2+layout.tx*pxPerLabel:ctx.canvas.width/2+layout.tx;
 const cy=view?view.y+view.h/2+layout.ty*pxPerLabel:ctx.canvas.height/2+layout.ty;
 const w=layout.refW*layout.scale*pxPerLabel,h=layout.refH*layout.scale*pxPerLabel;
 const c=normalizedCrop(layer),srcW=img.naturalWidth||img.width,srcH=img.naturalHeight||img.height,sx=srcW*c.x,sy=srcH*c.y,sw=srcW*Math.min(c.w,1-c.x),sh=srcH*Math.min(c.h,1-c.y);
 ctx.save();ctx.translate(cx,cy);ctx.rotate(degrees(layout.rotation));ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
 if(c.shape==='circle'){ctx.beginPath();ctx.ellipse(0,0,w/2,h/2,0,0,Math.PI*2);ctx.clip();}
 ctx.drawImage(img,sx,sy,sw,sh,-w/2,-h/2,w,h);ctx.restore();
}
const adjustedImages=new Map();let adjustedPixels=0;
const MAX_ADJUSTED_PIXELS=12000000,MAX_ADJUSTED_ITEMS=24;
function adjustedSource(layer,img){
 const crop=normalizedCrop(layer),key=JSON.stringify([crop,imageAdjustments(layer)]);
 const cached=adjustedImages.get(layer);if(cached&&cached.key===key&&cached.blob===layer.blob){adjustedImages.delete(layer);adjustedImages.set(layer,cached);return cached.canvas;}
 const sw=Math.max(1,img.naturalWidth*crop.w),sh=Math.max(1,img.naturalHeight*crop.h),factor=Math.min(1,Math.sqrt(8000000/(sw*sh)));
 const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(sw*factor));canvas.height=Math.max(1,Math.round(sh*factor));
 const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,img.naturalWidth*crop.x,img.naturalHeight*crop.y,sw,sh,0,0,canvas.width,canvas.height);
 applyAdjustments(ctx,canvas.width,canvas.height,imageAdjustments(layer));
 if(cached){adjustedPixels-=cached.canvas.width*cached.canvas.height;cached.canvas.width=cached.canvas.height=0;adjustedImages.delete(layer);}
 const pixels=canvas.width*canvas.height;
 while(adjustedImages.size&&(adjustedPixels+pixels>MAX_ADJUSTED_PIXELS||adjustedImages.size>=MAX_ADJUSTED_ITEMS)){const [oldLayer,old]=adjustedImages.entries().next().value;adjustedPixels-=old.canvas.width*old.canvas.height;old.canvas.width=old.canvas.height=0;adjustedImages.delete(oldLayer);}
 adjustedPixels+=pixels;adjustedImages.set(layer,{key,blob:layer.blob,canvas});return canvas;
}
function rasterizeImageLayer(layer,sizeInfo,img,layout){
 const c=document.createElement('canvas');c.width=Math.round(sizeInfo.size.w_px);c.height=Math.round(sizeInfo.size.h_px);
 drawImageAtLayout(c.getContext('2d'),adjustedSource(layer,img),layout,1,null,{crop:{x:0,y:0,w:1,h:1,shape:normalizedCrop(layer).shape}});return c;
}
async function renderLabelCanvas(entry,baseSizeInfo,{physical=false,oneBit=false}={}){
 const sizeInfo=effectiveSizeInfo(entry,baseSizeInfo),{size}=sizeInfo;validateSize(size);const canvas=document.createElement('canvas');canvas.width=Math.round(size.w_px);canvas.height=Math.round(size.h_px);
 if(canvas.width*canvas.height>12_000_000)throw Error('Etikett ist zu groß (max. 12 Millionen Pixel)');
 const ctx=canvas.getContext('2d',{alpha:false,willReadFrequently:oneBit});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
 for(const id of layerOrder(entry)){
   const layer=imageForId(entry,id);
   if(layer){const {img,layout}=await getLayout(layer,sizeInfo);const raster=rasterizeImageLayer(layer,sizeInfo,img,layout);if(oneBit)binarizeLayerCanvas(raster,layerPrintMode(layer),effectiveThreshold(layer));ctx.drawImage(raster,0,0);raster.width=raster.height=0;}
   else{const t=(entry.texts||[]).find(t=>t.id===id);if(t)drawTextItem(ctx,t,canvas.width);}
 }
 if(oneBit)finalizeOneBit(canvas);
 if(!physical || entry.pageRotation!==90)return canvas;
 const out=document.createElement('canvas');out.width=Math.round(baseSizeInfo.size.w_px);out.height=Math.round(baseSizeInfo.size.h_px);
 const octx=out.getContext('2d',{alpha:false});octx.fillStyle='#fff';octx.fillRect(0,0,out.width,out.height);octx.imageSmoothingEnabled=false;octx.save();octx.translate(out.width/2,out.height/2);octx.rotate(Math.PI/2);octx.drawImage(canvas,-canvas.width/2,-canvas.height/2);octx.restore();canvas.width=canvas.height=0;return out;
}

let previewFrame=0;
function requestPreview(){if(previewFrame)return;previewFrame=requestAnimationFrame(()=>{previewFrame=0;showPreview();});}
function setRotationField(layout){
 const t=selectedText(),a=Math.round(t ? (t.rotation||0) : (layout.rotation||0));
 for(const id of ['dd-rotation','dd-rotation-num'])if(document.activeElement!==$(id))$(id).value=String(a);
 if(t && document.activeElement!==$('dd-textrotation'))$('dd-textrotation').value=String(a);
}
function setZoomField(layout){
 const t=selectedText(),zoom=t ? textScale(t)*100 : layout.scale/(layout.baseScale||1)*100;
 const value=String(Math.max(5,Math.round(zoom)));
 if(document.activeElement!==$('dd-zoom'))$('dd-zoom').value=value;
 if(t && $('dd-textzoom') && document.activeElement!==$('dd-textzoom'))$('dd-textzoom').value=value;
 $('dd-transform-target').textContent=t?'Aktiv: Textfeld – Zoom und Rotation wirken auf den Text samt Rahmen':'Aktiv: Bild – Zoom und Rotation wirken auf die importierte Datei';
}
function setPreviewZoomUi(){ const el=$('dd-viewzoom'),out=$('dd-viewzoom-value'); if(!el||!out)return; const value=Math.round((Number(state.viewZoom)||1)*100); if(document.activeElement!==el)el.value=String(value); out.textContent=value+'%'; }
function drawImageOutsidePrintArea(ctx,img,layout,crop,layer){
 drawImageAtLayout(ctx,adjustedSource(layer,img),layout,crop.scale,crop,{crop:{x:0,y:0,w:1,h:1,shape:normalizedCrop(layer).shape}});
}
function drawCenteredHint(ctx,lines,box){
 ctx.save();ctx.fillStyle='#64748b';ctx.textAlign='center';ctx.textBaseline='middle';
 let fs=14;const maxW=Math.max(40,box.w-16);
 const widest=()=>{ctx.font=fs+'px system-ui,sans-serif';return Math.max(...lines.map(l=>ctx.measureText(l).width));};
 while(fs>8&&widest()>maxW)fs--;
 const lh=fs*1.35,top=box.y+box.h/2-(lines.length-1)*lh/2;
 lines.forEach((l,i)=>ctx.fillText(l,box.x+box.w/2,top+i*lh));ctx.restore();
}
let previewRunning=null,previewAgain=false;
function showPreview(){
 if(previewRunning){previewAgain=true;return previewRunning;}
 previewRunning=(async()=>{do{previewAgain=false;await paintPreview();}while(previewAgain);})().finally(()=>previewRunning=null);
 return previewRunning;
}
async function paintPreview(){
 const version=++state.previewVersion;
 const entry=state.queue[state.selected];
 updateTemplateUiState();
 if(!entry){
  // A selected roll defines the red print region, independent of imported artwork.
  state.editor.entry=null;state.editor.imageHandle=null;state.editor.textHandles=null;
  let sizeInfo=null;
  try{if(loaded()){if(!state.registry)await upstreamRegistry();sizeInfo=readSize();}}catch(e){console.warn('[dragdrop] Etikett-Rahmen noch nicht verfügbar:',e.message||e);}
  if(version!==state.previewVersion)return;
  updateEditorViewport(sizeInfo?.size||null);
  const {ctx,cssW,cssH}=editorSize();ctx.fillStyle='#d9dee7';ctx.fillRect(0,0,cssW,cssH);
  if(!sizeInfo){
   state.editor.crop=null;state.editor.sizeInfo=null;
   drawCenteredHint(ctx,['Bitte oben Drucker','und Etikettgröße wählen'],{x:0,y:0,w:cssW,h:cssH});
   $('dd-preview-title').textContent='Druckbereich – Etikett auswählen';return;
  }
  const crop=cropForViewport(cssW,cssH,sizeInfo.size,state.viewZoom);
  state.editor.crop=crop;state.editor.sizeInfo=sizeInfo;
  ctx.fillStyle='#fff';ctx.fillRect(crop.x,crop.y,crop.w,crop.h);
  ctx.save();ctx.strokeStyle='#f43f5e';ctx.lineWidth=2.5;ctx.setLineDash([6,5]);ctx.strokeRect(crop.x,crop.y,crop.w,crop.h);ctx.restore();
  drawCenteredHint(ctx,['Leeres Etikett','Bild oder Text hinzufügen'],crop);
  const mm=(Number(sizeInfo.size.w_mm)||0)+' × '+(Number(sizeInfo.size.h_mm)||0)+' mm';
  $('dd-preview-title').textContent='Druckbereich '+(sizeInfo.size.w_mm&&sizeInfo.size.h_mm?mm:'');
  setPreviewZoomUi();return;
 }
 $('dd-preview-title').textContent=(state.queue.length>1?(state.selected+1)+'/'+state.queue.length+' · ':'')+entry.name+(entry.pageRotation===90?' · 90°':'');
 try{
  if(!state.registry)await upstreamRegistry();
  const baseSizeInfo=readSize();
  const sizeInfo=effectiveSizeInfo(entry,baseSizeInfo);
  updateEditorViewport(sizeInfo.size);
  const {ctx,cssW,cssH}=editorSize();
  const active=activeImageLayer(entry),activeResult=active?await getLayout(active,sizeInfo):null;
  if(version!==state.previewVersion)return;
  const crop=cropForViewport(cssW,cssH,sizeInfo.size,state.viewZoom);
  state.editor.crop=crop;state.editor.sizeInfo=sizeInfo;state.editor.entry=entry;
  ctx.fillStyle='#d9dee7';ctx.fillRect(0,0,cssW,cssH);
  ctx.fillStyle='#fff';ctx.fillRect(crop.x,crop.y,crop.w,crop.h);
  if(state.showOutsideBounds){
    // Parts outside the print area are shown faded; inside, the exact label is drawn.
    ctx.save();ctx.globalAlpha=.38;
    for(const id of layerOrder(entry)){
      const layer=imageForId(entry,id);
      if(layer){const {img,layout}=await getLayout(layer,sizeInfo);drawImageOutsidePrintArea(ctx,img,layout,crop,layer);}
      else {const t=(entry.texts||[]).find(t=>t.id===id);if(t){ctx.save();ctx.translate(crop.x,crop.y);ctx.scale(crop.scale,crop.scale);drawTextItem(ctx,t,sizeInfo.size.w_px);ctx.restore();}}
    }
    ctx.restore();
  }
  const label=await renderLabelCanvas(entry,baseSizeInfo,{oneBit:state.printView});
  if(version!==state.previewVersion){label.width=label.height=0;return;}
  if(state.printView&&!state.editor.pointers.size)storeThumb(entry,label);
  ctx.save();
  // 1-bit preview: crisp dots when enlarged, smooth (grey-looking) when reduced.
  ctx.imageSmoothingEnabled=!(state.printView&&crop.scale*(window.devicePixelRatio||1)>=1.5);ctx.imageSmoothingQuality='high';
  ctx.drawImage(label,crop.x,crop.y,crop.w,crop.h);ctx.restore();label.width=label.height=0;
  ctx.save();ctx.strokeStyle='#f43f5e';ctx.lineWidth=2.5;ctx.setLineDash([6,5]);ctx.strokeRect(crop.x,crop.y,crop.w,crop.h);ctx.restore();
  if(state.showOutsideBounds){
   const gc=$('dd-editor').getContext('2d');
   for(const id of layerOrder(entry)){
    const layer=imageForId(entry,id),text=(entry.texts||[]).find(t=>t.id===id);
    let corners=null;
    if(layer){const {layout}=await getLayout(layer,sizeInfo);const r=imageRect(layout,sizeInfo,crop);corners=[r.tl,r.tr,r.br,r.bl];}
    else if(text){const g=textGeometry(gc,text,sizeInfo.size.w_px),sc=textScale(text)*crop.scale;
      const x=crop.x+text.x*crop.scale,y=crop.y+text.y*crop.scale;
      corners=[[-g.boxWidth/2,-g.boxHeight/2],[g.boxWidth/2,-g.boxHeight/2],[g.boxWidth/2,g.boxHeight/2],[-g.boxWidth/2,g.boxHeight/2]].map(([dx,dy])=>rotatedPoint(x,y,dx*sc,dy*sc,text.rotation||0));}
    if(!corners)continue;
    const isActive=(text&&state.textSelectedId===id)||(layer&&!state.textSelectedId&&state.activeImageId===id);
    if(isActive)continue;
    ctx.save();ctx.strokeStyle=layerLocked(entry,id)?'rgba(71,85,105,.60)':'rgba(30,110,210,.60)';ctx.lineWidth=1.1;ctx.setLineDash([4,4]);
    ctx.beginPath();ctx.moveTo(corners[0].x,corners[0].y);for(let k=1;k<4;k++)ctx.lineTo(corners[k].x,corners[k].y);ctx.closePath();ctx.stroke();ctx.restore();
   }
  }
  const selected=selectedText();state.editor.imageHandle=null;state.editor.textHandles=null;
  if(active&&activeResult&&!selected&&!active.locked){
   const layout=activeResult.layout,r=imageRect(layout,sizeInfo,crop);state.editor.imageHandle={...r,id:state.activeImageId};
   ctx.save();ctx.strokeStyle='#155eef';ctx.lineWidth=1.7;ctx.beginPath();ctx.moveTo(r.tl.x,r.tl.y);ctx.lineTo(r.tr.x,r.tr.y);ctx.lineTo(r.br.x,r.br.y);ctx.lineTo(r.bl.x,r.bl.y);ctx.closePath();ctx.stroke();
   for(const [pos,symbol] of [[r.tl,'↻'],[r.br,'↘']]){
    ctx.beginPath();ctx.arc(pos.x,pos.y,12,0,Math.PI*2);ctx.fillStyle='#098bd3';ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=2;ctx.stroke();ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='bold 15px sans-serif';ctx.fillStyle='white';ctx.fillText(symbol,pos.x,pos.y+.5);
   }ctx.restore();
  }
  if(selected&&!selected.locked){
   const g=textGeometry(ctx,selected,sizeInfo.size.w_px),cx=crop.x+selected.x*crop.scale,cy=crop.y+selected.y*crop.scale;
   const rad=selected.rotation||0,ts=textScale(selected),corners=[[-g.boxWidth/2,-g.boxHeight/2],[g.boxWidth/2,-g.boxHeight/2],[g.boxWidth/2,g.boxHeight/2],[-g.boxWidth/2,g.boxHeight/2]].map(([x,y])=>rotatedPoint(cx,cy,x*crop.scale*ts,y*crop.scale*ts,rad));
   ctx.save();ctx.strokeStyle='#0887de';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(corners[0].x,corners[0].y);for(let n=1;n<4;n++)ctx.lineTo(corners[n].x,corners[n].y);ctx.closePath();ctx.stroke();
   const w=rotatedPoint(cx,cy,g.boxWidth/2*crop.scale*ts,0,rad),h=rotatedPoint(cx,cy,0,g.boxHeight/2*crop.scale*ts,rad),wh=corners[2],rotate=corners[0];
   for(const [kind,pt,symbol] of [['rotate',rotate,'↻'],['width',w,'↔'],['height',h,'↕'],['both',wh,'⤡']]){
    ctx.beginPath();ctx.arc(pt.x,pt.y,11,0,Math.PI*2);ctx.fillStyle='#0a8ad9';ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();ctx.fillStyle='#fff';ctx.font='bold 12px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(symbol,pt.x,pt.y+.5);
   }
   state.editor.textHandles={rotate,width:w,height:h,both:wh,cx,cy,rotation:rad};ctx.restore();
  }
  syncThresholdControl();setRotationField(activeResult?.layout||{scale:1,baseScale:1,rotation:0});setZoomField(activeResult?.layout||{scale:1,baseScale:1,rotation:0});setPreviewZoomUi();
 }catch(e){if(version!==state.previewVersion)return;message('Vorschau nicht verfügbar: '+(e.message||e),true);}
}

async function learnRollAfterPrint(size,sizeKey){ if(!window.labelMemory||!window.Niimbot?.printer)return; try{ const result=await Niimbot.getStatus(); const rfid=result?.decoded?.rfid; if(!rfid?.tagPresent||!rfid.barCode)return; const prev=window.labelMemory.recall(rfid.barCode)||{}; const mm=Number(size.w_mm)>0&&Number(size.h_mm)>0; const rec={...prev,...(mm?{w_mm:size.w_mm,h_mm:size.h_mm}:{size:sizeKey})}; if(mm)delete rec.size; else{delete rec.w_mm;delete rec.h_mm;} window.labelMemory.remember(rfid.barCode,rec); }catch(e){ console.log('[dragdrop] RFID nach Druck nicht abrufbar:',e.message||e);} }
async function printAll(){if(!state.queue.length)return;return runPrintJob(async()=>snapshotClone(state.queue),copyCount());}
async function runPrintJob(entriesForJob,copies){
 if(isBusy()||state.cropState)return;clearHistoryTimer();commitHistory();
 state.printing=true;state.stop=false;$('dd-progress').value=0;refreshBusyUi();showQueue();
 try{
  await upstreamRegistry();const sizeInfo=snapshotClone(readSize()),{model,size,density,sizeKey}=sizeInfo;
  const notReady=text=>Object.assign(Error(text),{beforePrint:true});
  if(!Niimbot.isSupported())throw notReady('Dieser Browser kann kein Bluetooth. Auf dem iPhone die Seite in Bluefy öffnen, am Computer Chrome oder Edge verwenden.');
  if(!Niimbot.printer)throw notReady('Bitte zuerst den Drucker verbinden („🔗 Verbinden“).');
  if(Number(Niimbot.printer.modelId)!==Number(model.id))throw notReady('Der verbundene Drucker ('+(Niimbot.printer.label||'?')+') passt nicht zum gewählten Modell. Bitte Modell anpassen oder neu verbinden.');
  const entries=await entriesForJob(),total=entries.length*copies;let completed=0;
  for(const entry of entries){
   if(state.stop)break;const canvas=await renderLabelCanvas(entry,sizeInfo,{physical:true,oneBit:true});const url=canvas.toDataURL('image/png');canvas.width=canvas.height=0;releaseDecodedImages(entry);
   for(let n=0;n<copies;n++){
    if(state.stop)break;message('Drucke '+(completed+1)+' von '+total+' …');
    await Niimbot.printImage(url,{model,size,density,onProgress:s=>{if(s!=='ok')$('dd-state').textContent='Druckstatus: '+String(s);}});
    completed++;$('dd-progress').value=100*completed/total;
   }
  }
  if(state.stop)message('Druck angehalten: '+completed+' von '+total+' Etiketten bestätigt.');
  else{await learnRollAfterPrint(size,sizeKey);message('Fertig: '+completed+' Etikett(en) bestätigt.');}
 }catch(e){message(e.beforePrint?(e.message||String(e)):'Druckfehler: '+(e.message||e)+' · Bitte Papier und Deckel prüfen; ein Etikett kann bereits ausgegeben worden sein.',true);if(e.beforePrint&&!isDesktopLayout()&&!Niimbot.printer)setPrinterCollapsed(true);}
 finally{state.printing=false;refreshBusyUi();showQueue();renderTextControls();setImagePanel(activeImageLayer(state.queue[state.selected]));}
}
function currentEntryAndLayout(){if(state.selected<0||state.selected>=state.queue.length)return null;try{const entry=state.queue[state.selected],sizeInfo=effectiveSizeInfo(entry,readSize());return {entry,sizeInfo};}catch{return null;}}
async function modifyLayout(fn){
 const cur=currentEntryAndLayout();if(!cur)return;
 const layer=activeImageLayer(cur.entry);if(!layer||layer.locked)return;
 const {layout}=await getLayout(layer,cur.sizeInfo);fn(layout,cur.sizeInfo,cur.entry);requestPreview();
}

function alignHorizontal(mode){const selected=selectedText();if(selected){if(selected.locked)return;const cur=currentEntryAndLayout();if(!cur)return;const ctx=$('dd-editor').getContext('2d'),g=textGeometry(ctx,selected,cur.sizeInfo.size.w_px);const a=degrees(selected.rotation),ts=textScale(selected),bw=ts*(Math.abs(g.boxWidth*Math.cos(a))+Math.abs(g.boxHeight*Math.sin(a)));selected.x=mode==='left'?bw/2:mode==='right'?cur.sizeInfo.size.w_px-bw/2:cur.sizeInfo.size.w_px/2;renderTextControls();requestPreview();return;}modifyLayout((l,s)=>{const a=degrees(l.rotation),w=l.refW*l.scale,h=l.refH*l.scale,bw=Math.abs(w*Math.cos(a))+Math.abs(h*Math.sin(a));l.tx=mode==='left'?(bw-s.size.w_px)/2:mode==='right'?(s.size.w_px-bw)/2:0;});}
function alignVertical(mode){const selected=selectedText();if(selected){if(selected.locked)return;const cur=currentEntryAndLayout();if(!cur)return;const ctx=$('dd-editor').getContext('2d'),g=textGeometry(ctx,selected,cur.sizeInfo.size.w_px);const a=degrees(selected.rotation),ts=textScale(selected),bh=ts*(Math.abs(g.boxHeight*Math.cos(a))+Math.abs(g.boxWidth*Math.sin(a)));selected.y=mode==='top'?bh/2:mode==='bottom'?cur.sizeInfo.size.h_px-bh/2:cur.sizeInfo.size.h_px/2;renderTextControls();requestPreview();return;}modifyLayout((l,s)=>{const a=degrees(l.rotation),w=l.refW*l.scale,h=l.refH*l.scale,bh=Math.abs(h*Math.cos(a))+Math.abs(w*Math.sin(a));l.ty=mode==='top'?(bh-s.size.h_px)/2:mode==='bottom'?(s.size.h_px-bh)/2:0;});}
function nudge(dx,dy){const selected=selectedText();if(selected){if(selected.locked)return;const cur=currentEntryAndLayout();if(!cur)return;const step=Math.max(1,Math.round(cur.sizeInfo.size.dpi/25.4));selected.x+=dx*step;selected.y+=dy*step;renderTextControls();requestPreview();return;}modifyLayout((l,s)=>{const step=Math.max(1,Math.round(s.size.dpi/25.4));l.tx+=dx*step;l.ty+=dy*step;});}
// Arrow-key editing is opt-in for controls that own the keyboard: focused sliders
// and number inputs edit their own values. Otherwise arrows nudge the selected
// layer, including text layers selected from the layer list or preview.
function nudgeSelectedWithKeyboard(dx,dy){
 const cur=currentEntryAndLayout();if(!cur||isBusy()||state.cropState)return false;
 const text=selectedText();
 if(text){
  if(text.locked)return false;
  beginHistory('Textfeld mit Pfeiltasten verschieben');
  text.x=(Number(text.x)||0)+dx;text.y=(Number(text.y)||0)+dy;
  // Text coordinates and preview are updated immediately, without stealing focus.
  if($('dd-textx')&&document.activeElement!==$('dd-textx'))$('dd-textx').value=String(Math.round(text.x*100)/100);
  if($('dd-texty')&&document.activeElement!==$('dd-texty'))$('dd-texty').value=String(Math.round(text.y*100)/100);
  requestPreview();scheduleHistoryCommit(460);return true;
 }
 const image=activeImageLayer(cur.entry);
 if(!image||image.locked)return false;
 beginHistory('Bildebene mit Pfeiltasten verschieben');
 // The layout may be initialized asynchronously after importing an image.
 getLayout(image,cur.sizeInfo).then(({layout})=>{
  if(isBusy())return;
  layout.tx=(Number(layout.tx)||0)+dx;
  layout.ty=(Number(layout.ty)||0)+dy;
  requestPreview();scheduleHistoryCommit(460);
 }).catch(e=>message('Verschieben nicht möglich: '+(e.message||e),true));
 return true;
}
function keyboardStepControl(control,direction,multiplier){
 if(control.disabled||control.readOnly)return;
 const min=control.min!==''?Number(control.min):-Infinity;
 const max=control.max!==''?Number(control.max):Infinity;
 const stepRaw=Number(control.step);const step=Number.isFinite(stepRaw)&&stepRaw>0?stepRaw:1;
 const current=control.value!==''&&Number.isFinite(Number(control.value))?Number(control.value):(Number.isFinite(min)?min:0);
 const precision=(String(step).split('.')[1]||'').length;
 const target=Math.round((current+direction*step*multiplier)*1e6)/1e6;
 const clamped=Math.max(min,Math.min(max,target));
 const value=String(Number(clamped.toFixed(Math.max(precision+2,4))));
 if(value===control.value)return;
 control.value=value;
 control.dispatchEvent(new Event('input',{bubbles:true}));
 control.dispatchEvent(new Event('change',{bubbles:true}));
}
document.addEventListener('keydown',event=>{
 if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)||event.defaultPrevented||event.isComposing||isBusy()||event.ctrlKey||event.metaKey)return;
 const target=event.target;
 if(!(target instanceof Element)||!target.closest('#dd-addon'))return;
 // Browser-native select controls, the tab strip and resize grip own the arrows.
 if(target.closest('#dd-tabstrip,.dd-gripbar,[contenteditable="true"]'))return;
 if(target.matches('input[type="number"],input[type="range"]')){
  if(target.type==='number'&&(event.key==='ArrowLeft'||event.key==='ArrowRight'))return; // Allow editing digits.
  const direction=(event.key==='ArrowUp'||event.key==='ArrowRight')?1:-1;
  event.preventDefault();keyboardStepControl(target,direction,event.shiftKey?10:(event.altKey?0.25:1));
  return;
 }
 if(target.closest('input,textarea,select,button,a,[role="slider"]'))return;
 const delta=event.altKey?0.25:(event.shiftKey?10:1);
 const dx=(event.key==='ArrowLeft'?-delta:event.key==='ArrowRight'?delta:0);
 const dy=(event.key==='ArrowUp'?-delta:event.key==='ArrowDown'?delta:0);
 if(nudgeSelectedWithKeyboard(dx,dy))event.preventDefault();
});

async function doReset(mode){
 const current=currentEntryAndLayout();if(!current)return;
 const selected=selectedText();
 if(selected){if(selected.locked)return;
   const {sizeInfo}=current,g=textGeometry($('dd-editor').getContext('2d'),selected,sizeInfo.size.w_px);
   const factor=mode==='cover'?Math.max(sizeInfo.size.w_px/g.boxWidth,sizeInfo.size.h_px/g.boxHeight):Math.min(sizeInfo.size.w_px*.9/g.boxWidth,sizeInfo.size.h_px*.9/g.boxHeight);
   selected.zoomScale=clampTextScale(factor);selected.x=sizeInfo.size.w_px/2;selected.y=sizeInfo.size.h_px/2;
   selected.rotation=0;renderTextControls();requestPreview();return;
 }
 const {entry,sizeInfo}=current,layer=activeImageLayer(entry);if(!layer||layer.locked)return;const img=await ensureImage(layer);initLayout(layer,sizeInfo,img,mode);requestPreview();
}
function pointCanvas(e){const c=$('dd-editor'),rect=c.getBoundingClientRect();return {x:(e.clientX-rect.left)*(c.clientWidth||rect.width)/(rect.width||1),y:(e.clientY-rect.top)*(c.clientHeight||rect.height)/(rect.height||1)};}
function hitHandle(point,handle,radius=24){return handle&&Math.hypot(point.x-handle.x,point.y-handle.y)<=radius;}
function touchDistance(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
function touchCenter(a,b){return {x:(a.x+b.x)/2,y:(a.y+b.y)/2};}
function textAtPoint(point){const crop=state.editor.crop,current=currentEntryAndLayout();if(!crop||!current)return null;const {entry,sizeInfo}=current;
 const lx=(point.x-crop.x)/crop.scale,ly=(point.y-crop.y)/crop.scale;
 const texts=(layerOrder(entry).filter(id=>!imageForId(entry,id)).reverse()).map(id=>entry.texts?.find(t=>t.id===id)).filter(Boolean);
 const m=$('dd-editor').getContext('2d');
 for(let i=0;i<texts.length;i++){const t=texts[i],angle=-degrees(t.rotation),co=Math.cos(angle),si=Math.sin(angle),dx=lx-t.x,dy=ly-t.y;
  const rx=dx*co-dy*si,ry=dx*si+dy*co,g=textGeometry(m,t,sizeInfo.size.w_px);
  if(Math.abs(rx)<=Math.max(18,g.boxWidth*textScale(t)/2)&&Math.abs(ry)<=Math.max(18,g.boxHeight*textScale(t)/2))return t;
 }return null;
}
function clampTextScale(s){return Math.max(.05,Math.min(40,Number(s)||1));}
function syncTextTransformFields(t){
 if(!t)return;const angle=Math.round(normalizeAngle(t.rotation)),zoom=Math.round(100*textScale(t));
 for(const id of ['dd-rotation','dd-rotation-num','dd-textrotation']){const el=$(id);if(el&&document.activeElement!==el)el.value=String(angle);}
 for(const id of ['dd-zoom','dd-textzoom']){const el=$(id);if(el&&document.activeElement!==el)el.value=String(zoom);}
 renderTextSizeOnly(t);
}
function pointerAngle(a,b){return Math.atan2(b.y-a.y,b.x-a.x);}
function textLocalVector(dx,dy,angle){const r=degrees(-angle);return {x:dx*Math.cos(r)-dy*Math.sin(r),y:dx*Math.sin(r)+dy*Math.cos(r)};}
function rotateDiffDegrees(next,start){let diff=(next-start)*180/Math.PI;return ((diff+180)%360+360)%360-180;}
function objectAtPoint(pt,entry,sizeInfo,crop){
 if(!state.showOutsideBounds&&(pt.x<crop.x||pt.x>crop.x+crop.w||pt.y<crop.y||pt.y>crop.y+crop.h))return null;
 const lx=(pt.x-crop.x)/crop.scale,ly=(pt.y-crop.y)/crop.scale;
 const ctx=$('dd-editor').getContext('2d');
 for(const id of [...layerOrder(entry)].reverse()){
  const text=(entry.texts||[]).find(t=>t.id===id);
  if(text){
   if(text.locked)continue;
   const a=degrees(-text.rotation),co=Math.cos(a),si=Math.sin(a),dx=lx-text.x,dy=ly-text.y;
   const rx=dx*co-dy*si,ry=dx*si+dy*co,g=textGeometry(ctx,text,sizeInfo.size.w_px);
   if(Math.abs(rx)<=Math.max(12,g.boxWidth*textScale(text)/2)&&Math.abs(ry)<=Math.max(12,g.boxHeight*textScale(text)/2))return {type:'text',id,text};
  }else{
   const layer=imageForId(entry,id),layout=layer?.layouts?.[sizeInfo.sizeKey];if(!layout||layer.locked)continue;
   const a=degrees(-layout.rotation),co=Math.cos(a),si=Math.sin(a),dx=lx-(sizeInfo.size.w_px/2+layout.tx),dy=ly-(sizeInfo.size.h_px/2+layout.ty);
   const rx=dx*co-dy*si,ry=dx*si+dy*co;
   if(Math.abs(rx)<=layout.refW*layout.scale/2 && Math.abs(ry)<=layout.refH*layout.scale/2)return {type:'image',id,layer,layout};
  }
 }
 return null;
}
function startGesture(e){
 if(isBusy()||state.editor.pointers.size>=2)return;
 const cur=currentEntryAndLayout(),crop=state.editor.crop;if(!cur||!crop||state.editor.entry!==cur.entry)return;
 const ed=state.editor,pt=pointCanvas(e),entry=cur.entry;
 if(ed.pointers.size===0){beginHistory('Element mit Touch bearbeiten');history.gesturing=true;}
 $('dd-editor').setPointerCapture(e.pointerId);ed.pointers.set(e.pointerId,pt);
 if(ed.pointers.size===2){
  const [a,b]=[...ed.pointers.values()].slice(0,2),center=touchCenter(a,b),dist=Math.max(2,touchDistance(a,b)),angle=pointerAngle(a,b);
  const text=ed.start?.textId?entry.texts?.find(t=>t.id===ed.start.textId):selectedText();
  if(text&&!text.locked){ed.mode='textPinch';ed.start={textId:text.id,dist,center,angle,scale:textScale(text),rotation:text.rotation||0,x:text.x,y:text.y};}
  else{const imageId=ed.start?.imageId||state.activeImageId,layer=imageForId(entry,imageId),layout=layer?.layouts?.[cur.sizeInfo.sizeKey];
   if(layout&&!layer.locked){ed.mode='imagePinch';ed.start={imageId,dist,center,angle,scale:layout.scale,tx:layout.tx,ty:layout.ty,rotation:layout.rotation||0};}}
  return;
 }
 const selected=selectedText(),handles=ed.textHandles;
 if(selected&&!selected.locked&&handles){
  const nearCenter=Math.hypot(pt.x-handles.cx,pt.y-handles.cy)<10;
  for(const kind of (nearCenter?[]:['rotate','both','width','height']).sort((a,b)=>touchDistance(pt,handles[a])-touchDistance(pt,handles[b]))){
   if(!hitHandle(pt,handles[kind],24))continue;
   const g=textGeometry($('dd-editor').getContext('2d'),selected,cur.sizeInfo.size.w_px);
   if(kind==='rotate'){ed.mode='textRotate';ed.start={textId:selected.id,center:{x:handles.cx,y:handles.cy},angle:Math.atan2(pt.y-handles.cy,pt.x-handles.cx),rotation:selected.rotation||0};}
   else{ed.mode=kind==='both'?'textScale':'textResize';ed.start={textId:selected.id,kind,px:pt.x,py:pt.y,w:g.boxWidth,h:g.boxHeight,rotation:selected.rotation||0,scale:textScale(selected),center:{x:handles.cx,y:handles.cy},dist:Math.max(1,touchDistance(pt,{x:handles.cx,y:handles.cy}))};}
   return;
  }
 }
 const image=ed.imageHandle;
 if(!selected&&image&&!imageForId(entry,image.id)?.locked&&hitHandle(pt,image.tl)){
   const l=imageForId(entry,image.id)?.layouts?.[cur.sizeInfo.sizeKey];if(l){ed.mode='imageRotate';ed.start={imageId:image.id,center:{x:image.cx,y:image.cy},angle:Math.atan2(pt.y-image.cy,pt.x-image.cx),rotation:l.rotation||0};return;}
 }
 if(!selected&&image&&!imageForId(entry,image.id)?.locked&&hitHandle(pt,image.br)){
   const l=imageForId(entry,image.id)?.layouts?.[cur.sizeInfo.sizeKey];if(l){ed.mode='imageScale';ed.start={imageId:image.id,scale:l.scale,center:{x:image.cx,y:image.cy},dist:Math.max(1,touchDistance(pt,{x:image.cx,y:image.cy}))};return;}
 }
 const hit=objectAtPoint(pt,entry,cur.sizeInfo,crop);
 if(!hit){ed.mode=null;ed.start=null;return;}
 if(hit.type==='text'){
   state.textSelectedId=hit.id;ed.mode='textDrag';ed.start={textId:hit.id,px:pt.x,py:pt.y,x:hit.text.x,y:hit.text.y};renderTextControls();requestPreview();
 }else{
   state.textSelectedId=null;state.activeImageId=hit.id;ed.mode='imageDrag';ed.start={imageId:hit.id,px:pt.x,py:pt.y,x:hit.layout.tx,y:hit.layout.ty};
   renderTextControls();setImagePanel(hit.layer);requestPreview();
 }
}
function moveGesture(e){
 const ed=state.editor;if(!ed.pointers.has(e.pointerId)||!ed.mode||!ed.start)return;
 const pt=pointCanvas(e);ed.pointers.set(e.pointerId,pt);
 const cur=currentEntryAndLayout(),crop=ed.crop;if(!cur||!crop)return;
 const entry=cur.entry,start=ed.start,mode=ed.mode;
 const text=start.textId?entry.texts?.find(t=>t.id===start.textId):null;
 const layer=start.imageId?imageForId(entry,start.imageId):null,layout=layer?.layouts?.[cur.sizeInfo.sizeKey];
 if(mode==='textPinch'&&text&&!text.locked&&ed.pointers.size>=2){
  const [a,b]=[...ed.pointers.values()].slice(0,2),center=touchCenter(a,b);
  text.zoomScale=clampTextScale(start.scale*touchDistance(a,b)/start.dist);
  text.rotation=normalizeAngle(start.rotation+rotateDiffDegrees(pointerAngle(a,b),start.angle));
  text.x=start.x+(center.x-start.center.x)/crop.scale;text.y=start.y+(center.y-start.center.y)/crop.scale;syncTextTransformFields(text);
 }else if(mode==='imagePinch'&&layout&&!layer.locked&&ed.pointers.size>=2){
  const [a,b]=[...ed.pointers.values()].slice(0,2),center=touchCenter(a,b);
  layout.scale=clampScale(start.scale*touchDistance(a,b)/start.dist);layout.rotation=normalizeAngle(start.rotation+rotateDiffDegrees(pointerAngle(a,b),start.angle));
  layout.tx=start.tx+(center.x-start.center.x)/crop.scale;layout.ty=start.ty+(center.y-start.center.y)/crop.scale;
 }else if(mode==='textRotate'&&text&&!text.locked){const angle=Math.atan2(pt.y-start.center.y,pt.x-start.center.x);text.rotation=normalizeAngle(start.rotation+rotateDiffDegrees(angle,start.angle));syncTextTransformFields(text);
 }else if(mode==='textScale'&&text&&!text.locked){text.zoomScale=clampTextScale(start.scale*touchDistance(pt,start.center)/start.dist);syncTextTransformFields(text);
 }else if(mode==='textResize'&&text&&!text.locked){const local=textLocalVector((pt.x-start.px)/crop.scale,(pt.y-start.py)/crop.scale,start.rotation);
  if(start.kind!=='height')text.boxW=Math.min(4000,Math.max(20,start.w+2*local.x/start.scale));
  if(start.kind!=='width')text.boxH=Math.min(4000,Math.max(20,start.h+2*local.y/start.scale));renderTextSizeOnly(text);
 }else if(mode==='textDrag'&&text&&!text.locked){text.x=start.x+(pt.x-start.px)/crop.scale;text.y=start.y+(pt.y-start.py)/crop.scale;
 }else if(mode==='imageRotate'&&layout&&!layer.locked){const angle=Math.atan2(pt.y-start.center.y,pt.x-start.center.x);layout.rotation=normalizeAngle(start.rotation+rotateDiffDegrees(angle,start.angle));
 }else if(mode==='imageScale'&&layout&&!layer.locked){layout.scale=clampScale(start.scale*touchDistance(pt,start.center)/start.dist);
 }else if(mode==='imageDrag'&&layout&&!layer.locked){layout.tx=start.x+(pt.x-start.px)/crop.scale;layout.ty=start.y+(pt.y-start.py)/crop.scale;}
 requestPreview();
}
function endGesture(e){
 const ed=state.editor;if(!ed.pointers.has(e.pointerId))return;ed.pointers.delete(e.pointerId);
 if(ed.pointers.size===1&&(ed.mode==='textPinch'||ed.mode==='imagePinch')){
  const pt=[...ed.pointers.values()][0],cur=currentEntryAndLayout(),entry=cur?.entry;
  if(ed.mode==='textPinch'){
   const t=entry?.texts?.find(t=>t.id===ed.start?.textId);
   if(t){ed.mode='textDrag';ed.start={textId:t.id,px:pt.x,py:pt.y,x:t.x,y:t.y};return;}
  }else{const l=imageForId(entry,ed.start?.imageId)?.layouts?.[cur.sizeInfo.sizeKey];
   if(l){ed.mode='imageDrag';ed.start={imageId:ed.start.imageId,px:pt.x,py:pt.y,x:l.tx,y:l.ty};return;}}
 }
 if(ed.pointers.size<2){ed.mode=null;ed.start=null;}
 if(ed.pointers.size===0){history.gesturing=false;scheduleHistoryCommit(20);}
}

// Source-image crop editor: normalized bounds; presets are physical aspect ratios.
const CROPS={'1:1':1,'4:6':4/6,'3:5':3/5,'5:8':5/8,'2:3':2/3,'4:7':4/7,'5:7':5/7,'circle':1};
function validNormalizedCrop(c){
 const x=Math.min(.985,clamp01(Number(c.x)||0)),y=Math.min(.985,clamp01(Number(c.y)||0));
 return {x,y,w:Math.min(1-x,Math.max(.015,Number(c.w)||1)),h:Math.min(1-y,Math.max(.015,Number(c.h)||1)),shape:c.shape==='circle'?'circle':'rect',preset:c.preset||'free'};
}
let cropPointer=null;
function cropCanvasCoords(event){const r=$('dd-crop-canvas').getBoundingClientRect();return {x:event.clientX-r.left,y:event.clientY-r.top};}
function cropViewport(){
 const c=$('dd-crop-canvas'),width=Math.max(32,c.clientWidth||320),height=Math.max(32,c.clientHeight||300),padding=15;
 const img=state.cropState?.img,scale=Math.min((width-2*padding)/(img?.naturalWidth||300),(height-2*padding)/(img?.naturalHeight||300));
 const w=(img?.naturalWidth||300)*scale,h=(img?.naturalHeight||300)*scale;
 return {width,height,scale,x:(width-w)/2,y:(height-h)/2,w,h};
}
function cropRectPixels(){
 const c=state.cropState?.crop,v=cropViewport();
 return c?{x:v.x+c.x*v.w,y:v.y+c.y*v.h,w:c.w*v.w,h:c.h*v.h}:null;
}
function drawCropCanvas(){
 const item=state.cropState;if(!item)return;
 const canvas=$('dd-crop-canvas'),dpr=Math.max(1,window.devicePixelRatio||1),v=cropViewport();
 canvas.width=Math.round(v.width*dpr);canvas.height=Math.round(v.height*dpr);
 const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);
 ctx.fillStyle='#d3dbe6';ctx.fillRect(0,0,v.width,v.height);ctx.drawImage(item.img,v.x,v.y,v.w,v.h);
 const r=cropRectPixels(),circle=item.crop.shape==='circle';
 ctx.save();ctx.beginPath();ctx.rect(v.x,v.y,v.w,v.h);
 if(circle){ctx.ellipse(r.x+r.w/2,r.y+r.h/2,r.w/2,r.h/2,0,0,Math.PI*2,true);}else{ctx.rect(r.x,r.y,r.w,r.h);}
 ctx.fillStyle='rgba(26,40,62,.48)';ctx.fill('evenodd');ctx.restore();
 ctx.strokeStyle='#fb444b';ctx.lineWidth=2;ctx.setLineDash([5,4]);
 if(circle){ctx.beginPath();ctx.ellipse(r.x+r.w/2,r.y+r.h/2,r.w/2,r.h/2,0,0,Math.PI*2);ctx.stroke();}else ctx.strokeRect(r.x,r.y,r.w,r.h);
 ctx.setLineDash([]);ctx.beginPath();ctx.arc(r.x+r.w,r.y+r.h,11,0,Math.PI*2);ctx.fillStyle='#119be1';ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=2;ctx.stroke();
 $('dd-crop-presets').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.cropPreset===item.crop.preset)));
}
function applyCropPreset(preset){
 const item=state.cropState;if(!item)return;
 const ratio=CROPS[preset],img=item.img;
 if(!ratio){item.crop={...item.crop,preset:'free',shape:'rect'};drawCropCanvas();return;}
 // Ratios apply to actual pixel width/height, not the normalized viewport.
 const targetW=Math.min(img.naturalWidth,img.naturalHeight*ratio),targetH=targetW/ratio;
 const fx=targetW/img.naturalWidth,fy=targetH/img.naturalHeight;
 item.crop={x:(1-fx)/2,y:(1-fy)/2,w:fx,h:fy,shape:preset==='circle'?'circle':'rect',preset};
 drawCropCanvas();
}
function cropPointerDown(e){
 const item=state.cropState;if(!item)return;e.preventDefault();
 const p=cropCanvasCoords(e),r=cropRectPixels(),v=cropViewport();
 const near=Math.hypot(p.x-r.x-r.w,p.y-r.y-r.h)<34;
 const inside=p.x>=r.x&&p.x<=r.x+r.w&&p.y>=r.y&&p.y<=r.y+r.h;
 cropPointer={id:e.pointerId,kind:near?'resize':inside?'move':'move',start:p,crop:{...item.crop},v};
 $('dd-crop-canvas').setPointerCapture(e.pointerId);
}
function cropPointerMove(e){
 const item=state.cropState,gesture=cropPointer;if(!item||!gesture||gesture.id!==e.pointerId)return;
 const p=cropCanvasCoords(e),dx=(p.x-gesture.start.x)/gesture.v.w,dy=(p.y-gesture.start.y)/gesture.v.h;
 const c=gesture.crop,ratio=CROPS[c.preset];let next;
 if(gesture.kind==='move')next={...c,x:Math.max(0,Math.min(1-c.w,c.x+dx)),y:Math.max(0,Math.min(1-c.h,c.y+dy))};
 else{
  let w=Math.max(.02,Math.min(1-c.x,c.w+dx)),h=Math.max(.02,Math.min(1-c.y,c.h+dy));
  if(ratio){const nh=w*item.img.naturalWidth/(item.img.naturalHeight*ratio);if(nh<=1-c.y)h=nh;else{h=1-c.y;w=h*item.img.naturalHeight*ratio/item.img.naturalWidth;}}
  next={...c,w,h};
 }
 item.crop=validNormalizedCrop(next);drawCropCanvas();
}
function cropPointerUp(e){if(cropPointer?.id===e.pointerId)cropPointer=null;}
async function openCropEditor(layer){
 if(!layer||layer.locked){message('Gesperrte Bilder zum Zuschneiden erst entsperren.',true);return false;}
 if(state.cropState||state.printing||state.resizingTemplate)return false;
 const img=await ensureImage(layer),dialog=$('dd-crop-dialog');
 beginHistory('Bild zuschneiden');history.hold=true;
 return new Promise(resolve=>{
  state.cropState={layer,img,crop:validNormalizedCrop(normalizedCrop(layer)),resolve};
  $('dd-crop-title').textContent=layer.name||'Bildausschnitt';
  if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
  requestAnimationFrame(drawCropCanvas);
 });
}
function closeCropEditor(save){
 const item=state.cropState;if(!item)return;
 if(save&&!item.layer.locked){
  const old=normalizedCrop(item.layer),next=validNormalizedCrop(item.crop);
  if(state.importingFiles)item.layer.layouts={};
  else for(const l of Object.values(item.layer.layouts||{})){
   const dx=((next.x+next.w/2)-(old.x+old.w/2))*l.refW/old.w*l.scale;
   const dy=((next.y+next.h/2)-(old.y+old.h/2))*l.refH/old.h*l.scale;
   const r=degrees(l.rotation);l.tx+=dx*Math.cos(r)-dy*Math.sin(r);l.ty+=dx*Math.sin(r)+dy*Math.cos(r);
   l.refW*=next.w/old.w;l.refH*=next.h/old.h;
  }
  item.layer.crop=next;
 }
 state.cropState=null;cropPointer=null;
 const dialog=$('dd-crop-dialog');if(dialog.open)dialog.close();else dialog.removeAttribute('open');
 if(save){renderTextControls();requestPreview();}
 // During import, the outer file-import transaction stays open until all pages complete.
 if(!state.importingFiles){history.hold=false;commitHistory();}
 item.resolve(Boolean(save));
}
$('dd-crop-canvas').addEventListener('pointerdown',cropPointerDown);
$('dd-crop-canvas').addEventListener('pointermove',cropPointerMove);
$('dd-crop-canvas').addEventListener('pointerup',cropPointerUp);
$('dd-crop-canvas').addEventListener('pointercancel',cropPointerUp);
$('dd-crop-presets').querySelectorAll('button').forEach(b=>b.onclick=()=>applyCropPreset(b.dataset.cropPreset));
$('dd-crop-save').onclick=()=>closeCropEditor(true);
$('dd-crop-cancel').onclick=()=>closeCropEditor(false);
$('dd-crop-reset').onclick=()=>{if(state.cropState){state.cropState.crop={x:0,y:0,w:1,h:1,shape:'rect',preset:'free'};drawCropCanvas();}};
$('dd-crop-dialog').addEventListener('cancel',e=>{e.preventDefault();closeCropEditor(false)});
window.addEventListener('resize',()=>{if(state.cropState)drawCropCanvas();});

// Font persistence – tied to this HTTPS origin and browser profile.
const FONT_DB='niimbot-druckstudio-fonts-v1';
function openFontDb(){return new Promise((resolve,reject)=>{if(!window.indexedDB){reject(Error('IndexedDB wird von diesem Browser nicht unterstützt'));return;}const r=indexedDB.open(FONT_DB,1);r.onupgradeneeded=()=>r.result.createObjectStore('fonts',{keyPath:'id'});r.onblocked=()=>reject(Error('Schriftenspeicher ist durch einen anderen Tab blockiert'));r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};r.onerror=()=>reject(r.error||Error('Fontdatenbank konnte nicht geöffnet werden'));});}
async function fontStore(op,arg){const db=await openFontDb();return new Promise((resolve,reject)=>{const tx=db.transaction('fonts',op==='list'?'readonly':'readwrite'),store=tx.objectStore('fonts');let request;
 if(op==='list')request=store.getAll();if(op==='put')request=store.put(arg);if(op==='delete')request=store.delete(arg);
 request.onerror=()=>reject(request.error);tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
 }).finally(()=>db.close());}
function fontStatus(text,isError=false){$('dd-fontstatus').textContent=text;$('dd-fontstatus').style.color=isError?'#b42318':'#475569';}
async function installFontRecord(record){const family='NiimbotUploaded_'+record.id.replace(/[^A-Za-z0-9]/g,'');const face=new FontFace(family,record.bytes);await face.load();document.fonts.add(face);return {id:record.id,name:record.name,bytes:record.bytes,family,face};}
async function loadSavedFonts(){try{const records=await fontStore('list');for(const r of records){try{state.fonts.push(await installFontRecord(r));}catch(e){console.warn('Font nicht ladbar',r.name,e)}}renderFonts();fontStatus(`${state.fonts.length} eigene Schriftart(en) dauerhaft gespeichert.`);}catch(e){fontStatus('Schriftspeicherung nicht verfügbar: '+(e.message||e),true);renderFonts();}}
function renderFonts(){const sel=$('dd-font'),current=sel.value;sel.replaceChildren();for(const [value,label] of [['system:sans-serif','Arial / Sans Serif'],['system:serif','Serif'],['system:monospace','Monospace'],['system:cursive','Handschrift / Cursive']]){const opt=document.createElement('option');opt.value=value;opt.textContent=label;sel.append(opt);}for(const f of state.fonts){const opt=document.createElement('option');opt.value=f.id;opt.textContent='Eigene: '+f.name;sel.append(opt);}if([...sel.options].some(o=>o.value===current))sel.value=current;
 const root=$('dd-fontlist');root.replaceChildren();for(const f of state.fonts){const row=document.createElement('div');row.style.cssText='display:flex;align-items:center;gap:10px;border-top:1px solid #e5e7eb;padding:6px 0';const label=document.createElement('span');label.style.flex='1';label.textContent=f.name;const del=document.createElement('button');del.textContent='Font löschen';del.type='button';del.onclick=async()=>{if(!confirm(`Schriftart „${f.name}“ aus diesem Browser löschen?`))return;try{await fontStore('delete',f.id);document.fonts.delete(f.face);state.fonts=state.fonts.filter(x=>x.id!==f.id);renderFonts();fontStatus('Font gelöscht. Textfelder verwenden anschließend eine Ersatzschrift.');requestPreview();}catch(e){fontStatus('Löschen fehlgeschlagen: '+e.message,true);}};row.append(label,del);root.append(row);}}
async function uploadFonts(files){if(isBusy())return;const list=Array.from(files||[]);if(!list.length)return;clearHistoryTimer();commitHistory();beginHistory('Schriftart hochladen');history.hold=true;state.fontBusy=true;refreshBusyUi();try{for(const file of list){try{
 if(!/\.(ttf|otf|woff2?)$/i.test(file.name))throw Error('Nur .ttf, .otf, .woff und .woff2');
 if(file.size>8_000_000)throw Error('Font größer als 8 MB');
 const id=(crypto.randomUUID?.()||String(Date.now())+'_'+Math.random().toString(36).slice(2)).replace(/-/g,'');const record={id,name:file.name,bytes:await file.arrayBuffer(),added:Date.now()};
 const installed=await installFontRecord(record);state.fonts.push(installed);
 try{await fontStore('put',record);fontStatus(`Gespeichert: ${file.name}. Die Schrift bleibt beim nächsten Besuch verfügbar.`);}catch(e){fontStatus(`Font nur vorübergehend geladen: ${e.message}. Browser-Speicher prüfen.`,true);}
 renderFonts(); $('dd-font').value=id;if(selectedText()&&!selectedText().locked){selectedText().font=id;renderTextControls();}requestPreview();
 }catch(e){fontStatus(`Font ${file.name} konnte nicht geladen werden: ${e.message}`,true)}}}finally{history.hold=false;state.fontBusy=false;commitHistory();refreshBusyUi();}}
function selectedText(){const item=state.queue[state.selected];return item?.texts?.find(t=>t.id===state.textSelectedId)||null;}
function renderTextSizeOnly(t){
 const bw=$('dd-boxwidth'),bh=$('dd-boxheight'),ts=textScale(t);
 if(bw&&document.activeElement!==bw)bw.value=String(Math.round((t.boxW||0)*ts));
 if(bh&&document.activeElement!==bh)bh.value=String(Math.round((t.boxH||0)*ts));
 if($('dd-textzoom')&&document.activeElement!==$('dd-textzoom'))$('dd-textzoom').value=String(Math.round(ts*100));
}
function newText(){return {id:Math.random().toString(36).slice(2)+Date.now().toString(36),text:'Dein Text',x:0,y:0,font:'system:sans-serif',size:32,bold:false,italic:false,underline:false,strike:false,inverse:false,align:'center',vertical:'middle',wrap:'word',widthPct:85,boxW:0,boxH:0,letterSpace:0,lineHeight:120,rotation:0,zoomScale:1,autoFit:false,flow:'horizontal',curveDeg:180,curvePlacement:'top',curveFacing:'outside',curveRadius:0,locked:false};}
function renderTextControls(){const entry=state.queue[state.selected],texts=entry?.texts||[];const list=$('dd-textlist');list.replaceChildren();texts.forEach((t,i)=>{const btn=document.createElement('button');btn.textContent=(i+1)+': '+(t.text||'Leer').replace(/\s+/g,' ').slice(0,22);btn.type='button';btn.setAttribute('aria-pressed',t.id===state.textSelectedId?'true':'false');btn.disabled=!!t.locked;btn.onclick=()=>{if(t.locked)return;state.textSelectedId=t.id;renderTextControls();requestPreview();};list.append(btn);});
 const t=selectedText();for(const el of document.querySelectorAll('[data-tab="rund"] input,[data-tab="rund"] button,[data-tab="rund"] select'))el.disabled=!t||!!t.locked;
 $('dd-text-controls').querySelectorAll('input,textarea,select,button').forEach(el=>el.disabled=!t||!!t.locked);
 for(const id of ['dd-duplicate-text','dd-remove-text'])$(id).disabled=!t||!!t.locked;
 $('dd-select-image').disabled=!entry||!allImages(entry).length;$('dd-text-tofront').disabled=!t||!!t.locked;$('dd-text-toback').disabled=!t||!!t.locked;
 renderLayerControls();
 if(!t){$('dd-textcontent').value='';$('dd-curve-controls').hidden=true;return;}
 const fields={'dd-textcontent':'text','dd-font':'font','dd-fontsize':'size','dd-textalign':'align','dd-textwidth':'widthPct','dd-boxwidth':'boxW','dd-boxheight':'boxH','dd-textvertical':'vertical','dd-textwrap':'wrap','dd-textx':'x','dd-texty':'y','dd-letterspace':'letterSpace','dd-lineheight':'lineHeight','dd-textrotation':'rotation','dd-textscaling':'autoFit'};
 const flowControls=['dd-flow-horizontal','dd-flow-vertical','dd-flow-curve'];
 const curvePlacementButtons=['dd-curve-place-top','dd-curve-place-bottom','dd-curve-place-circle'];
 const curveFacingButtons=['dd-curve-facing-outside','dd-curve-facing-inside'];
 flowControls.forEach(id=>{$(id).disabled=!t||!!t.locked;$(id).classList.remove('dd-activated');$(id).setAttribute('aria-pressed','false');});
 curvePlacementButtons.forEach(id=>{$(id).disabled=!t||!!t.locked;$(id).classList.remove('dd-activated');$(id).setAttribute('aria-pressed','false');});
 curveFacingButtons.forEach(id=>{$(id).disabled=!t||!!t.locked;$(id).classList.remove('dd-activated');$(id).setAttribute('aria-pressed','false');});
 $('dd-curve-duplicate-opposite').disabled=!t||!!t.locked;
 $('dd-curve-controls').hidden=!t||textFlow(t)!=='curve';
 for(const [id,k] of Object.entries(fields)) {const el=$(id);if(id==='dd-textscaling')el.value=t.autoFit?'fit':'none';else if(id==='dd-font' && ![...el.options].some(o=>o.value===t.font))el.value='system:sans-serif';else el.value=t[k];}
 const activeFlow='dd-flow-'+(textFlow(t)==='curve'?'curve':textFlow(t)==='vertical'?'vertical':'horizontal');
 $(activeFlow).classList.add('dd-activated'); $(activeFlow).setAttribute('aria-pressed','true');
 for(const id of ['dd-curvedeg','dd-curvedeg-num'])$(id).disabled=!!t.locked||curvePlacement(t)==='circle';
 $('dd-curvedeg').value=String(Math.abs(normalizeCurveDeg(t.curveDeg))); $('dd-curvedeg-num').value=String(Math.abs(normalizeCurveDeg(t.curveDeg)));
 $('dd-curveradius').value=String(Math.max(0,Number(t.curveRadius)||0)); $('dd-curveradius-num').value=String(Math.max(0,Number(t.curveRadius)||0));
 const placementBtn='dd-curve-place-'+curvePlacement(t); $(placementBtn).classList.add('dd-activated'); $(placementBtn).setAttribute('aria-pressed','true');
 const facingBtn='dd-curve-facing-'+curveFacing(t); $(facingBtn).classList.add('dd-activated'); $(facingBtn).setAttribute('aria-pressed','true');
 $('dd-textwrap').disabled=!!t.locked||textFlow(t)!=='horizontal'; $('dd-textvertical').disabled=!!t.locked||textFlow(t)==='curve';
 for(const [id,k] of [['dd-textbold','bold'],['dd-textitalic','italic'],['dd-textunderline','underline'],['dd-textstrike','strike']]){$(id).setAttribute('aria-pressed',t[k]?'true':'false');$(id).classList.toggle('dd-activated',!!t[k]);}
 $('dd-textinverse').checked=!!t.inverse;renderTextSizeOnly(t);const cur=currentEntryAndLayout();if(cur){const layout=cur.entry.layouts?.[cur.sizeInfo.sizeKey];if(layout){setRotationField(layout);setZoomField(layout);}}
}
function addText(){const cur=currentEntryAndLayout();if(!cur){message('Bitte zuerst ein Bild oder ein leeres Etikett auswählen.',true);return;}
 const {entry,sizeInfo}=cur;entry.texts ||= [];const t=newText();t.x=sizeInfo.size.w_px/2;t.y=sizeInfo.size.h_px/2;t.size=Math.max(12,Math.round(sizeInfo.size.h_px/8));t.boxW=Math.round(sizeInfo.size.w_px*.85);t.boxH=Math.round(sizeInfo.size.h_px*.32);entry.texts.push(t);layerOrder(entry);state.textSelectedId=t.id;renderTextControls();requestPreview();}
async function blankLabel(){
 if(isBusy())return;if(state.queue.length>=MAX_PAGES){message('Maximal 100 Etiketten pro Auftrag.',true);return;}
 clearHistoryTimer();commitHistory();beginHistory('Leeres Etikett');history.hold=true;state.creatingLabel=true;refreshBusyUi();
 try{const entry=await createEmptyLabelEntry();entry.name='Leeres Etikett '+(state.queue.length+1);state.queue.push(entry);state.selected=state.queue.length-1;state.textSelectedId=null;state.activeImageId='image';
 }catch(e){message(e.message,true);}finally{history.hold=false;state.creatingLabel=false;commitHistory();refreshBusyUi();showQueue();setImagePanel(activeImageLayer(state.queue[state.selected]));requestPreview();renderTextControls();}
}
function duplicateText(){const t=selectedText(),entry=state.queue[state.selected];if(!t||t.locked)return;const copy={...t,id:newText().id,x:t.x+10,y:t.y+10};entry.texts.push(copy);layerOrder(entry);state.textSelectedId=copy.id;renderTextControls();requestPreview();}
function removeText(){const entry=state.queue[state.selected],id=state.textSelectedId;if(!entry||layerLocked(entry,id))return;entry.texts=entry.texts.filter(t=>t.id!==id);layerOrder(entry);state.textSelectedId=entry.texts.at(-1)?.id||null;renderTextControls();requestPreview();}
function wireTextEditor(){const textfields={'dd-textcontent':'text','dd-font':'font','dd-fontsize':'size','dd-textalign':'align','dd-textwidth':'widthPct','dd-boxwidth':'boxW','dd-boxheight':'boxH','dd-textvertical':'vertical','dd-textwrap':'wrap','dd-textx':'x','dd-texty':'y','dd-letterspace':'letterSpace','dd-lineheight':'lineHeight','dd-textrotation':'rotation','dd-textscaling':'autoFit'};
 for(const [id,key] of Object.entries(textfields))$(id).addEventListener(id==='dd-font'||id==='dd-textscaling'||id==='dd-textalign'?'change':'input',e=>{const t=selectedText();if(!t||t.locked)return;let val=e.target.value;if(key==='autoFit')val=val==='fit';else if(['size','widthPct','boxW','boxH','x','y','letterSpace','lineHeight','rotation'].includes(key)){if(val===''||!Number.isFinite(Number(val)))return;val=Number(val);if(e.target.min!=='')val=Math.max(Number(e.target.min),val);if(e.target.max!=='')val=Math.min(Number(e.target.max),val);}t[key]=val;if(key==='boxW'){t.boxW=Math.max(20,val/textScale(t));const cur=currentEntryAndLayout();if(cur)t.widthPct=Math.round(val*100/cur.sizeInfo.size.w_px);}
  if(key==='boxH')t.boxH=Math.max(20,val/textScale(t));
  if(key==='rotation'){t.rotation=normalizeAngle(val);syncTextTransformFields(t);}
  if(key==='widthPct'){const cur=currentEntryAndLayout();if(cur)t.boxW=Math.round(cur.sizeInfo.size.w_px*val/(100*textScale(t)));}requestPreview();if(key==='text'){renderTextListOnly();renderLayerControls();}});
 for(const [id,key] of [['dd-textbold','bold'],['dd-textitalic','italic'],['dd-textunderline','underline'],['dd-textstrike','strike']])$(id).onclick=()=>{const t=selectedText();if(!t||t.locked)return;t[key]=!t[key];renderTextControls();requestPreview();};
 $('dd-textinverse').onchange=e=>{const t=selectedText();if(t&&!t.locked){t.inverse=e.target.checked;requestPreview();}};
 function setTextFlow(flow){const t=selectedText();if(!t||t.locked)return;if(flow==='curve'&&textFlow(t)!=='curve'){t.curveDeg=Math.abs(normalizeCurveDeg(t.curveDeg));t.curvePlacement=curvePlacement(t);t.curveFacing=curveFacing(t);t.curveRadius=Math.max(0,Number(t.curveRadius)||0);const cur=currentEntryAndLayout();const d=cur?Math.round(Math.min(cur.sizeInfo.size.w_px,cur.sizeInfo.size.h_px)*.92/textScale(t)):220;t.boxW=t.boxH=Math.max(40,d);if(cur){t.x=cur.sizeInfo.size.w_px/2;t.y=cur.sizeInfo.size.h_px/2;}}t.flow=flow;renderTextControls();requestPreview();}
 function setCurvePlacement(place){const t=selectedText();if(!t||t.locked)return;t.curvePlacement=place;renderTextControls();requestPreview();}
 function setCurveFacing(facing){const t=selectedText();if(!t||t.locked)return;t.curveFacing=facing;renderTextControls();requestPreview();}
 function duplicateCurveOpposite(){const t=selectedText(),entry=state.queue[state.selected];if(!t||t.locked||textFlow(t)!=='curve'||!entry)return;const copy={...t,id:newText().id,x:t.x,y:t.y,curvePlacement:curvePlacement(t)==='top'?'bottom':curvePlacement(t)==='bottom'?'top':'circle'};entry.texts.push(copy);layerOrder(entry);state.textSelectedId=copy.id;renderTextControls();requestPreview();}
 $('dd-flow-horizontal').onclick=()=>setTextFlow('horizontal'); $('dd-flow-vertical').onclick=()=>setTextFlow('vertical'); $('dd-flow-curve').onclick=()=>setTextFlow('curve');
 $('dd-curve-place-top').onclick=()=>setCurvePlacement('top'); $('dd-curve-place-bottom').onclick=()=>setCurvePlacement('bottom'); $('dd-curve-place-circle').onclick=()=>setCurvePlacement('circle');
 $('dd-curve-facing-outside').onclick=()=>setCurveFacing('outside'); $('dd-curve-facing-inside').onclick=()=>setCurveFacing('inside'); $('dd-curve-duplicate-opposite').onclick=duplicateCurveOpposite;
 $('dd-curvedeg').addEventListener('input',e=>{const t=selectedText();if(!t||t.locked||curvePlacement(t)==='circle')return;t.curveDeg=Math.max(0,Math.min(360,Number(e.target.value)||0));$('dd-curvedeg-num').value=String(t.curveDeg);requestPreview();});
 $('dd-curvedeg-num').addEventListener('change',e=>{const t=selectedText();if(!t||t.locked||curvePlacement(t)==='circle')return;t.curveDeg=Math.max(0,Math.min(360,Number(e.target.value)||0));$('dd-curvedeg').value=String(t.curveDeg);requestPreview();});
 $('dd-curveradius').addEventListener('input',e=>{const t=selectedText();if(!t||t.locked)return;t.curveRadius=Math.max(0,Math.min(1200,Number(e.target.value)||0));$('dd-curveradius-num').value=String(t.curveRadius);requestPreview();});
 $('dd-curveradius-num').addEventListener('change',e=>{const t=selectedText();if(!t||t.locked)return;t.curveRadius=Math.max(0,Math.min(1200,Number(e.target.value)||0));$('dd-curveradius').value=String(t.curveRadius);requestPreview();});
 $('dd-curveradius-auto').onclick=()=>{const t=selectedText();if(!t||t.locked)return;t.curveRadius=0;$('dd-curveradius').value='0';$('dd-curveradius-num').value='0';requestPreview();};
 $('dd-add-text').onclick=addText;$('dd-add-blank').onclick=blankLabel;$('dd-duplicate-text').onclick=duplicateText;$('dd-remove-text').onclick=removeText;
 $('dd-fontfile').onchange=e=>{uploadFonts(e.target.files);e.target.value='';};
 $('dd-fontpersistent').onclick=async()=>{if(!navigator.storage?.persist){fontStatus('Dauerhafte Speicherung wird von diesem Browser nicht angeboten.',true);return;}try{const yes=await navigator.storage.persist();fontStatus(yes?'Permanenter Browserspeicher wurde genehmigt.':'Browser hat dauerhafte Speicherung nicht bestätigt. Fonts bleiben bis zum Löschen der Browserdaten gespeichert.',!yes);}catch(e){fontStatus('Speicher-Anfrage nicht möglich: '+e.message,true);}};
}
function wireAdditionalControls(){
 $('dd-select-image').onclick=()=>{const entry=state.queue[state.selected];if(entry)setActiveImage(entry,allImages(entry)[0]?.id||'image');};
 $('dd-text-tofront').onclick=()=>{const t=selectedText();if(t)moveLayer(t.id,'front');};
 $('dd-text-toback').onclick=()=>{const t=selectedText();if(t)moveLayer(t.id,'back');};
 for(const [id,fn] of [
 ['dd-txt-align-left',()=>alignHorizontal('left')],['dd-txt-align-hcenter',()=>alignHorizontal('center')],['dd-txt-align-right',()=>alignHorizontal('right')],
 ['dd-txt-align-top',()=>alignVertical('top')],['dd-txt-align-vcenter',()=>alignVertical('middle')],['dd-txt-align-bottom',()=>alignVertical('bottom')]
 ])$(id).onclick=fn;
 for(const key of ADJUST_KEYS){
  const slider=$('dd-'+key),number=$('dd-'+key+'-number');
  slider.addEventListener('input',e=>setImageAdjustValue(key,e.target.value));
  number.addEventListener('input',e=>{
    // Allow temporary empty/incomplete values while typing; commit valid values live.
    if(e.target.value==='' || e.target.value==='-' || e.target.value==='.')return;
    setImageAdjustValue(key,e.target.value,{preserveNumberFocus:true});
  });
  number.addEventListener('change',e=>{
    if(!setImageAdjustValue(key,e.target.value)){
      const entry=state.queue[state.selected];
      syncAdjustControl(key,activeImageLayer(entry)?imageAdjustments(activeImageLayer(entry))[key]:ADJUST_DEFAULTS[key]);
    }else{
      syncAdjustControl(key,imageAdjustments(activeImageLayer(state.queue[state.selected]))[key]);
    }
  });
  for(const [suffix,direction] of [['minus',-1],['plus',1]]){
    $('dd-'+key+'-'+suffix).addEventListener('click',()=>{
      const entry=activeImageLayer(state.queue[state.selected]);if(!entry||entry.locked)return;
      const current=Number(imageAdjustments(entry)[key] ?? ADJUST_DEFAULTS[key]);
      const step=Number(slider.step)||1;
      setImageAdjustValue(key,current+direction*step);
    });
  }
 }
 $('dd-bw').addEventListener('change',e=>{const layer=activeImageLayer(state.queue[state.selected]);if(layer&&!layer.locked){const a=imageAdjustments(layer);if(e.target.value==='bw'&&a.mode!=='bw')a.threshold=a.mode==='dither'&&Number.isFinite(Number(a.threshold))?a.threshold:128;a.mode=e.target.value==='dither'?'dither':'bw';if(!state.printView)message('Hinweis: Der Druckmodus ist nur in der Druckansicht sichtbar (Knopf oben in der Vorschau).');}setImagePanel(layer);requestPreview();});
 $('dd-adjust-reset').onclick=()=>{const layer=activeImageLayer(state.queue[state.selected]);if(!layer||layer.locked)return;layer.adjustments={...ADJUST_DEFAULTS};setImagePanel(layer);requestPreview();};
}
function renderTextListOnly(){const sel=state.textSelectedId;const entries=state.queue[state.selected]?.texts||[];const root=$('dd-textlist');root.replaceChildren();entries.forEach((t,i)=>{const b=document.createElement('button');b.type='button';b.textContent=`${i+1}: `+t.text.replace(/\s+/g,' ').slice(0,22);b.setAttribute('aria-pressed',t.id===sel?'true':'false');b.disabled=!!t.locked;b.onclick=()=>{if(t.locked)return;state.textSelectedId=t.id;renderTextControls();requestPreview();};root.append(b);});}
// Compact viewport zoom scales ONLY the canvas presentation, never the printed label.
for(const [id,factor] of [['dd-viewzoom-plus',1.25],['dd-viewzoom-minus',1/1.25]]){
 $(id).addEventListener('click',()=>{state.viewZoom=Math.max(.2,Math.min(4,state.viewZoom*factor));if(Math.abs(state.viewZoom-1)<.04)state.viewZoom=1;$('dd-viewzoom').value=String(Math.round(state.viewZoom*100));setPreviewZoomUi();requestPreview();});
}
const resetViewZoom=()=>{state.viewZoom=1;setPreviewZoomUi();requestPreview();};
$('dd-viewzoom-value').addEventListener('click',resetViewZoom);
$('dd-viewzoom-value').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();resetViewZoom();}});
$('dd-add-layer').addEventListener('click',()=>$('dd-layer-files').click());
$('dd-layer-files').addEventListener('change',e=>{const f=[...e.target.files];e.target.value='';addFiles(f,true);});
$('dd-crop-image').addEventListener('click',()=>{const layer=activeImageLayer(state.queue[state.selected]);if(layer)openCropEditor(layer);});

$('dd-picker').addEventListener('click',e=>{e.stopPropagation();$('dd-files').click()});
$('dd-drop').addEventListener('click',e=>{if(e.target.id!=='dd-picker')$('dd-files').click()});
$('dd-drop').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('dd-files').click()}});
$('dd-drop').addEventListener('dragover',e=>{e.preventDefault();$('dd-drop').classList.add('drag')});
$('dd-drop').addEventListener('dragleave',()=>{$('dd-drop').classList.remove('drag')});
$('dd-drop').addEventListener('drop',e=>{e.preventDefault();$('dd-drop').classList.remove('drag');addFiles(e.dataTransfer.files)});
$('dd-files').addEventListener('change',e=>{const files=Array.from(e.target.files);e.target.value='';addFiles(files)});
$('dd-import-mode').addEventListener('change',e=>{$('dd-import-mode-hint').textContent=e.target.value==='layers'?'Alle importierten Bilder/PDF-Seiten kommen als einzelne Ebenen auf das aktuell gewählte Etikett. Falls noch keines existiert, wird eines automatisch erstellt.':'Jede importierte Datei bzw. PDF-Seite wird ein eigenes Etikett in der Druckwarteschlange.';});
$('dd-clear').addEventListener('click',()=>{if(isBusy())return;beginHistory('Warteschlange leeren'); state.queue.forEach(revokeEntry); state.queue.length=0; state.selected=-1; state.textSelectedId=null;state.activeImageId="image"; showQueue(); renderTextControls(); showPreview(); $('dd-progress').value=0; commitHistory();message('Warteschlange geleert.')});
$('dd-print').addEventListener('click',printAll); $('dd-stop').addEventListener('click',()=>{state.stop=true; message('Stopp angefordert. Das laufende Etikett wird noch beendet.')});
$('dd-fit').addEventListener('change',()=>doReset($('dd-fit').value));

$('dd-copies').addEventListener('change',showQueue);
$('dd-viewzoom').addEventListener('input',e=>{state.viewZoom=Math.max(.2,Math.min(4,Number(e.target.value||100)/100));setPreviewZoomUi();requestPreview();});
for(const id of ['model','size','density'])$(id).addEventListener('change',handleSizeChange);
function applyActiveZoom(percent){
 if(String(percent).trim()===''||!Number.isFinite(Number(percent)))return;percent=Math.max(5,Math.min(4000,Number(percent)));
 const t=selectedText();if(t){if(t.locked)return;t.zoomScale=clampTextScale(Number(percent)/100);syncTextTransformFields(t);requestPreview();}
 else modifyLayout(l=>{l.scale=clampScale((l.baseScale||1)*(Number(percent)||100)/100);});
}
$('dd-zoom-apply').onclick=()=>applyActiveZoom($('dd-zoom').value);
$('dd-textzoom').addEventListener('input',e=>applyActiveZoom(e.target.value));
$('dd-zoom').addEventListener('change',()=>$('dd-zoom-apply').click());
$('dd-fit-reset').onclick=()=>doReset('contain');$('dd-cover-reset').onclick=()=>doReset('cover');
function applyActiveRotation(value){
 const t=selectedText();if(t){if(t.locked)return;t.rotation=normalizeAngle(value);syncTextTransformFields(t);requestPreview();}
 else modifyLayout(l=>{l.rotation=normalizeAngle(value);});
}
$('dd-rotation').addEventListener('input',e=>{ $('dd-rotation-num').value=e.target.value;applyActiveRotation(e.target.value); });
$('dd-rotation-num').addEventListener('change',e=>{ $('dd-rotation').value=normalizeAngle(e.target.value); applyActiveRotation(e.target.value); });
$('dd-rotate90').onclick=()=>{
 const t=selectedText();if(t){if(t.locked)return;t.rotation=normalizeAngle((t.rotation||0)+90);syncTextTransformFields(t);requestPreview();}
 else modifyLayout(l=>{l.rotation=normalizeAngle((l.rotation||0)+90);});
};
for(const [id,func] of [['dd-align-left',()=>alignHorizontal('left')],['dd-align-center-x',()=>alignHorizontal('center')],['dd-align-right',()=>alignHorizontal('right')],['dd-align-top',()=>alignVertical('top')],['dd-align-center-y',()=>alignVertical('middle')],['dd-align-bottom',()=>alignVertical('bottom')],['dd-nudge-up',()=>nudge(0,-1)],['dd-nudge-down',()=>nudge(0,1)],['dd-nudge-left',()=>nudge(-1,0)],['dd-nudge-right',()=>nudge(1,0)]])$(id).onclick=func;
const editorCanvas=$('dd-editor');editorCanvas.tabIndex=0;editorCanvas.setAttribute('role','application');editorCanvas.setAttribute('aria-label','Etikettenvorschau. Ausgewählte Bild- oder Textebene mit den Pfeiltasten verschieben. Umschalt für zehn Pixel, Alt für Viertelpixel.');editorCanvas.addEventListener('pointerdown',e=>{if(e.pointerType!=='touch')editorCanvas.focus({preventScroll:true});});editorCanvas.addEventListener('pointerdown',startGesture);editorCanvas.addEventListener('pointermove',moveGesture);editorCanvas.addEventListener('pointerup',endGesture);editorCanvas.addEventListener('pointercancel',endGesture);editorCanvas.addEventListener('lostpointercapture',endGesture);
window.addEventListener('resize',requestPreview);
setInterval(()=>{updatePrinterSummary();if(loaded()&&!isBusy())handleSizeChange();},1000);

/* Studio user interface: the original control nodes are moved, never cloned, so the
   original Bluetooth listeners, roll storage, printer and event handlers are preserved. */
const DESKTOP_QUERY='(min-width:900px)';
function isDesktopLayout(){return window.matchMedia?window.matchMedia(DESKTOP_QUERY).matches:window.innerWidth>=900;}
function setPrinterCollapsed(collapsed,persist=false){
 const bar=$('dd-printerbar'),toggle=$('dd-printer-toggle');if(!bar||!toggle)return;
 bar.classList.toggle('collapsed',!!collapsed);
 toggle.textContent=collapsed?'⚙ Drucker ▾':'Fertig ▴';toggle.setAttribute('aria-expanded',String(!collapsed));
 toggle.title=collapsed?'Drucker, Etikettgröße und Dichte einstellen':'Druckereinstellungen einklappen';
 if(persist){try{localStorage.setItem('niimbot-studio:printer-collapsed',collapsed?'1':'0');}catch(e){}}
 requestAnimationFrame(()=>{window.NiimbotStudioUI?.refitPanel?.();requestPreview();});
}
let lastConnected=null;
function updatePrinterSummary(){
 const conn=$('dd-conn'),short=$('dd-printer-short');if(!conn||!short)return;
 const connected=!!window.Niimbot?.printer;
 conn.classList.toggle('on',connected);conn.textContent=connected?'Verbunden':'Getrennt';conn.title=connected?'Drucker ist verbunden':'Kein Drucker verbunden';
 $('dd-printerbar')?.classList.toggle('connected',connected);
 for(const o of $('size')?.options||[]){const t=o.textContent,n=t.replace('(cable flag, 203 dpi)','(Kabelfahne, 203 dpi)').replace('(cable flag)','(Kabelfahne)').replace(' round corner',' abgerundet').replace('— no size for this model —','– keine Größe für dieses Modell –');if(n!==t)o.textContent=n;}
 const model=($('model')?.selectedOptions?.[0]?.textContent||'').replace(/^Niimbot\s+/,'');
 const size=$('size')?.selectedOptions?.[0]?.textContent||'';
 short.textContent=[model,size,$('density')?.value?'Dichte '+$('density').value:''].filter(Boolean).join(' · ');
 if(lastConnected!==null&&connected!==lastConnected){
  if(connected&&!isDesktopLayout())setPrinterCollapsed(true);
  if(!connected)setPrinterCollapsed(false);
 }
 lastConnected=connected;
}
function setupTabbedLayout(){
 const root=$('dd-addon'); if(!root||root.dataset.tabbed==='true')return;
 root.dataset.tabbed='true';document.body.classList.add('dd-has-studio');
 const make=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;};
 const moved=(node,to)=>{if(node&&to)to.appendChild(node);return node;};
 const labelOf=id=>$(id)?.closest('label')||$(id);
 const rowOf=id=>$(id)?.closest('.dd-row');
 const toolbarOf=id=>$(id)?.closest('.dd-toolbar');
 const panelOf=id=>$(id)?.closest('.dd-panel');
 const cropDialog=$('dd-crop-dialog');

 // ---- Printer bar (model, label size, density, connect) ----
 const printer=make('header','dd-printerbar'); printer.id='dd-printerbar';
 const head=make('div','dd-printerbar-head');
 const brand=make('div','dd-brand');brand.innerHTML='🏷️ Druckstudio<small>V18</small>';
 const summary=make('div','dd-printer-summary');summary.innerHTML='<span id="dd-conn" class="dd-conn">Getrennt</span><span id="dd-printer-short"></span>';
 const toggle=make('button','','Einklappen ▴');toggle.type='button';toggle.id='dd-printer-toggle';toggle.setAttribute('aria-expanded','true');
 toggle.onclick=()=>setPrinterCollapsed(!printer.classList.contains('collapsed'),true);
 const quick=make('button','dd-quick-connect','🔗 Verbinden');quick.type='button';quick.id='dd-quick-connect';quick.title='Drucker per Bluetooth verbinden';quick.onclick=()=>$('identify')?.click();
 head.append(brand,summary,quick,toggle);printer.appendChild(head);
 const selects=make('div','dd-printer-controls');
 for(const [id,name] of [['model','Drucker'],['size','Etikett'],['density','Dichte']]){const control=labelOf(id);if(control){if(control.tagName==='LABEL'&&control.firstChild?.nodeType===3)control.firstChild.textContent=name;selects.appendChild(control);}}
 printer.appendChild(selects);
 const actions=make('div','dd-printer-actions');
 for(const id of ['identify','disconnect']){const btn=$(id);if(btn){btn.textContent=id==='identify'?'🔗 Drucker verbinden':'Trennen';actions.appendChild(btn);}}
 printer.appendChild(actions);
 const statusLine=$('status');
 if(statusLine){const info=make('div','dd-printer-info'); moved(statusLine,info);printer.appendChild(info);
  new MutationObserver(()=>{updatePrinterSummary();statusLine.title=statusLine.textContent;}).observe(statusLine,{childList:true,characterData:true,subtree:true});}
 if($('dd-blehint'))moved($('dd-blehint'),printer);
 root.insertBefore(printer,root.firstChild);
 let startCollapsed=true;try{startCollapsed=localStorage.getItem('niimbot-studio:printer-collapsed')!=='0';}catch(e){}
 setPrinterCollapsed(!isDesktopLayout()&&startCollapsed);
 root.querySelector(':scope > h2')?.remove();
 root.querySelector(':scope > p.dd-muted')?.remove();

 // ---- Workspace: preview + tools ----
 const workspace=make('div','dd-workspace');workspace.id='dd-workspace';root.appendChild(workspace);
 const preview=make('section','dd-preview-area');preview.id='dd-preview-area';preview.setAttribute('aria-label','Druckvorschau');
 const previewHead=make('div','dd-preview-head');
 moved($('dd-preview-title'),previewHead);
 const thresholdWrap=make('div','dd-threshold');thresholdWrap.id='dd-threshold-wrap';thresholdWrap.setAttribute('role','group');thresholdWrap.setAttribute('aria-label','Schwarzweiß-Schwelle');thresholdWrap.hidden=true;
 thresholdWrap.innerHTML='<label for="dd-threshold">Schwelle</label><button id="dd-threshold-minus" type="button" aria-label="Schwelle verringern (mehr Weiß)">−</button><input id="dd-threshold" type="range" min="1" max="254" step="1" value="128" aria-label="Schwarzweiß-Schwelle"><button id="dd-threshold-plus" type="button" aria-label="Schwelle erhöhen (mehr Schwarz)">+</button><output id="dd-threshold-value">128</output>';
 previewHead.appendChild(thresholdWrap);
 thresholdWrap.querySelector('#dd-threshold').addEventListener('input',e=>setThreshold(e.target.value));
 thresholdWrap.querySelector('#dd-threshold-minus').addEventListener('click',()=>setThreshold(Number(thresholdWrap.querySelector('#dd-threshold').value)-5));
 thresholdWrap.querySelector('#dd-threshold-plus').addEventListener('click',()=>setThreshold(Number(thresholdWrap.querySelector('#dd-threshold').value)+5));
 const viewButton=make('button','dd-mobile-action');viewButton.type='button';viewButton.id='dd-printview-toggle';
 viewButton.onclick=()=>{state.printView=!state.printView;try{localStorage.setItem('niimbot-studio:printview',state.printView?'1':'0');}catch(e){}updateTemplateUiState();requestPreview();};
 previewHead.appendChild(viewButton);
 const outerButton=make('button','');outerButton.type='button';outerButton.id='dd-preview-overflow-toggle';outerButton.title='Teile außerhalb des Druckbereichs blass anzeigen';
 outerButton.onclick=()=>{state.showOutsideBounds=!state.showOutsideBounds;updateTemplateUiState();requestPreview();};previewHead.appendChild(outerButton);
 const historyBar=$('dd-undo')?.closest('.dd-historybar');
 if(historyBar){$('dd-undo').innerHTML='↶<span class="dd-label-long"> Zurück</span>';$('dd-redo').innerHTML='↷<span class="dd-label-long"> Vor</span>';moved(historyBar,previewHead);}
 preview.appendChild(previewHead);
 moved($('dd-editor')?.closest('.dd-editorstage'),preview);
 workspace.appendChild(preview);

 const tools=make('section','dd-toolshell');tools.id='dd-toolshell';tools.setAttribute('aria-label','Bearbeitungswerkzeuge');
 const grip=make('div','dd-gripbar');grip.id='dd-gripbar';grip.setAttribute('role','separator');grip.setAttribute('aria-label','Höhe des Werkzeugbereichs ändern');grip.setAttribute('aria-orientation','horizontal');
 grip.appendChild(make('span','dd-draghandle'));
 const sizes=make('div','dd-toolsizes');
 for(const [label,frac] of [['Klein',.34],['Mittel',.48],['Groß',.64]]){
   const b=make('button','',label);b.type='button';b.title='Werkzeugbereich '+label.toLowerCase();b.addEventListener('click',()=>setPanelFraction(frac));sizes.appendChild(b);
 }
 grip.appendChild(sizes);tools.appendChild(grip);
 const tabs=make('div','dd-tabstrip');tabs.id='dd-tabstrip';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Bearbeitungsbereiche');tools.appendChild(tabs);
 const contents=make('div','dd-tabcontent');contents.id='dd-tabcontent';tools.appendChild(contents);workspace.appendChild(tools);
 const tabDefinitions=[['dateien','📁 Dateien'],['text','✏️ Text'],['rund','◠ Rundtext'],['bild','🎛️ Bild'],['ebenen','▤ Ebenen'],['align','⌖ Position'],['vorlagen','💾 Vorlagen']];
 const pages=new Map();
 for(const [key,label] of tabDefinitions){
   const page=make('div','dd-tab-page');page.id='dd-panel-'+key;page.setAttribute('role','tabpanel');page.setAttribute('aria-labelledby','dd-tab-'+key);page.dataset.tab=key;page.hidden=true;pages.set(key,page);contents.appendChild(page);
   const button=make('button','',label);button.type='button';button.dataset.tab=key;button.id='dd-tab-'+key;button.setAttribute('role','tab');button.setAttribute('aria-controls','dd-panel-'+key);button.tabIndex=-1;button.setAttribute('aria-selected','false');
   button.addEventListener('click',()=>switchTab(key));tabs.appendChild(button);
 }
 tabs.addEventListener('keydown',e=>{const buttons=[...tabs.querySelectorAll('button')],i=buttons.indexOf(e.target);if(i<0)return;const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:e.key==='ArrowRight'?(i+1)%buttons.length:e.key==='ArrowLeft'?(i+buttons.length-1)%buttons.length:-1;if(next<0)return;e.preventDefault();switchTab(buttons[next].dataset.tab);buttons[next].focus();});
 let selectedTab='dateien';
 function switchTab(key){
   if(!pages.has(key))key='dateien';selectedTab=key;
   if(key==='bild'&&state.textSelectedId){const entry=state.queue[state.selected];if(entry&&allImages(entry).some(x=>!x.layer.locked))setActiveImage(entry,state.activeImageId);}
   if((key==='text'||key==='rund')&&!state.textSelectedId){const t=[...(state.queue[state.selected]?.texts||[])].reverse().find(x=>!x.locked);if(t){state.textSelectedId=t.id;renderTextControls();}}
   for(const [name,page] of pages){page.hidden=(name!==key);}
   contents.scrollTop=0;
   for(const b of tabs.querySelectorAll('button')){b.setAttribute('aria-selected',b.dataset.tab===key?'true':'false');b.tabIndex=b.dataset.tab===key?0:-1;}
   const active=tabs.querySelector('[aria-selected="true"]');if(active&&tabs.scrollWidth>tabs.clientWidth){const left=active.offsetLeft+active.offsetWidth/2-tabs.clientWidth/2;tabs.scrollLeft=Math.max(0,left);}
   try{sessionStorage.setItem('niimbot-studio:tab',key);}catch(e){}
   requestAnimationFrame(()=>requestPreview());
 }
 window.NiimbotStudioUI={selectTab:switchTab,get selectedTab(){return selectedTab;}};

 // Files: import controls, label queue and copies.
 const files=pages.get('dateien');files.appendChild(make('p','dd-tab-lead','Bilder / PDFs importieren'));
 moved($('dd-drop'),files);moved($('dd-files'),files);
 moved(rowOf('dd-import-mode'),files);
 moved($('dd-import-mode-hint'),files);
 const uploadActions=make('div','dd-toolbar');
 const addMore=make('button','dd-mobile-action','＋ Weitere Bilder aufs Etikett');addMore.type='button';addMore.id='dd-files-add-layer';
 addMore.onclick=()=>$('dd-layer-files').click();uploadActions.appendChild(addMore);
 const blankFromFiles=make('button','dd-mobile-action','＋ Leeres Etikett');blankFromFiles.type='button';blankFromFiles.id='dd-files-add-blank';blankFromFiles.onclick=()=>blankLabel();uploadActions.appendChild(blankFromFiles);
 files.appendChild(uploadActions);
 const importRow=rowOf('dd-importdpi');moved(importRow,files);
 files.appendChild(make('p','dd-tab-lead','Druckwarteschlange'));
 const queueBar=make('div','dd-row dd-queuebar');files.appendChild(queueBar);
 const copiesLabel=labelOf('dd-copies');if(copiesLabel){moved(copiesLabel,queueBar);if(copiesLabel.firstChild?.nodeType===3)copiesLabel.firstChild.textContent='Kopien je Etikett';}
 const clear=$('dd-clear');if(clear){clear.textContent='🗑️ Alle entfernen';queueBar.appendChild(clear);}
 moved($('dd-queue'),files);

 // Templates
 const templates=pages.get('vorlagen');templates.appendChild(make('p','dd-tab-lead','Etiketten speichern · wiederverwenden · in anderer Größe drucken'));
 const currentInfo=make('p','dd-muted');currentInfo.id='dd-template-current';templates.appendChild(currentInfo);
 const nameLine=make('div','dd-row');nameLine.innerHTML='<label>Vorlagenname<input id="dd-template-name" type="text" placeholder="Mein Etikett"></label><label>Ordner<input id="dd-template-folder" type="text" value="Meine Vorlagen"></label>';templates.appendChild(nameLine);
 const toolbar=make('div','dd-toolbar');toolbar.innerHTML='<button id="dd-template-save-browser" type="button" class="primary">💾 Speichern</button><button id="dd-template-save-as" type="button">Als Kopie speichern</button><button id="dd-template-export-file" type="button">↓ Als Datei</button><button id="dd-template-import-btn" type="button">↑ Datei öffnen</button><input id="dd-template-import-file" type="file" accept=".json,application/json" hidden>';templates.appendChild(toolbar);
 const searchLine=make('div','dd-row');searchLine.innerHTML='<label>Vorlagen durchsuchen<input id="dd-template-search" type="search" placeholder="Name oder Ordner"></label>';templates.appendChild(searchLine);
 const templateList=make('div','dd-template-gallery');templateList.id='dd-template-list';templates.appendChild(templateList);
 const note=make('p','dd-muted');note.textContent='Vorlagen werden nur in diesem Browser auf diesem Gerät gespeichert. Für Sicherung oder Gerätewechsel „↓ Als Datei“ verwenden. Wird eine Vorlage bei anderer Etikettgröße geöffnet, wird sie proportional angepasst; das Original bleibt unverändert.';templates.appendChild(note);

 // Image: print mode, tonal corrections, crop/remove.
 const image=pages.get('bild');image.appendChild(make('p','dd-tab-lead','Ausgewähltes Bild bearbeiten'));
 moved($('dd-active-image'),image);
 const selectedImageActions=make('div','dd-toolbar');
 const cropImage=make('button','dd-mobile-action','✂️ Zuschneiden');cropImage.type='button';cropImage.id='dd-crop-selected-image';cropImage.onclick=()=>$('dd-crop-image').click();
 const removeImage=make('button','dd-mobile-action','🗑 Bild entfernen');removeImage.type='button';removeImage.id='dd-remove-selected-image';
 removeImage.onclick=()=>{const entry=state.queue[state.selected];if(!entry)return;const id=imageForId(entry,state.activeImageId)?state.activeImageId:allImages(entry)[0]?.id;if(id)removeImageLayer(id);};
 selectedImageActions.append(cropImage,removeImage);image.appendChild(selectedImageActions);
 const bwRow=make('div','dd-row');moved(labelOf('dd-bw'),bwRow);image.appendChild(bwRow);
 image.appendChild(Object.assign(make('p','dd-caption'),{textContent:'Der Drucker kennt nur Schwarz und Weiß. Bei „Schwarzweiß“ stellst du die Schwelle oben in der Vorschau ein („Schwelle“). „Foto – Rasterung“ stellt Graustufen durch feine Punkte dar. Die Druckansicht zeigt genau das Druckergebnis.'}));
 moved($('dd-image-panel'),image);

 // Text: editor + custom fonts.
 const text=pages.get('text');
 const textPanel=$('dd-text-panel');const textCtrls=$('dd-text-controls');
 if(textPanel){
   const h=textPanel.querySelector('h3');if(h){h.className='dd-tab-lead';h.textContent='Text einfügen und formatieren';moved(h,text);}
   moved(toolbarOf('dd-add-text'),text);
   moved($('dd-textlist'),text);
 }
 const textMain=make('div','dd-text-main');
 const arc=pages.get('rund');arc.appendChild(make('p','dd-tab-lead','Gerader, senkrechter oder runder Text'));
 arc.appendChild(Object.assign(make('p','dd-caption'),{textContent:'Gilt für das ausgewählte Textfeld. Zuerst im Tab „Text“ ein Textfeld anlegen oder in der Vorschau antippen.'}));
 const layers=pages.get('ebenen');layers.appendChild(make('p','dd-tab-lead','Bilder und Texte · vorne / hinten / sperren'));
 if(textCtrls){
   const curveTitle=$('dd-flow-horizontal')?.closest('.dd-flow-buttons')?.previousElementSibling;
   const flowButtons=$('dd-flow-horizontal')?.closest('.dd-flow-buttons');
   const curveBlock=$('dd-curve-controls');
   const layerButtons=toolbarOf('dd-select-image');
   const layerList=$('dd-layers');
   const layerCaption=layerList?.previousElementSibling;
   if(curveTitle)moved(curveTitle,arc);
   if(flowButtons)moved(flowButtons,arc);
   if(curveBlock)moved(curveBlock,arc);
   while(textCtrls.firstChild){
     const node=textCtrls.firstChild;
     if(node===layerButtons||node===layerCaption||node===layerList){node.remove();continue;}
     textMain.appendChild(node);
   }
   moved($('dd-add-layer')?.closest('.dd-layer-files'),layers);
   if(layerButtons)moved(layerButtons,layers);
   if(layerCaption)moved(layerCaption,layers);
   if(layerList)moved(layerList,layers);
   textCtrls.appendChild(textMain);moved(textCtrls,text);
 }
 const customFonts=$('dd-fontfile')?.closest('details');if(customFonts){moved(customFonts,text);}
 moved(root.querySelector(':scope > .dd-layer-hint'),layers);
 if($('dd-layers')&&!layers.contains($('dd-layers')))moved($('dd-layers'),layers);

 // Position: rotation, alignment, zoom and the print-area rotation.
 const align=pages.get('align');align.appendChild(make('p','dd-tab-lead','Position, Drehung und Größe des ausgewählten Elements'));
 moved(rowOf('dd-align-left'),align);
 moved(panelOf('dd-rotation'),align);
 const alignZoom=make('div','dd-row');moved(labelOf('dd-zoom'),alignZoom);align.appendChild(alignZoom);
 const zoomQuick=make('div','dd-toolbar');
 for(const id of ['dd-zoom-apply','dd-fit-reset','dd-cover-reset']) if($(id))moved($(id),zoomQuick);
 align.appendChild(zoomQuick);
 const labelPanel=make('div','dd-panel');labelPanel.innerHTML='<h3>Etikett / Druckbereich</h3><label class="dd-rotate-mode-label" for="dd-label-rotate-mode">Beim Drehen des Druckbereichs</label><select id="dd-label-rotate-mode"><option value="keep">Inhalte behalten ihre Ausrichtung</option><option value="with">Alle Bild- und Textfelder mitdrehen</option></select><div class="dd-toolbar"><button id="dd-rotate-label" type="button">↻ Druckbereich 90° drehen</button><span id="dd-label-rotation-status" class="dd-muted">0° Querformat</span></div><label class="dd-check"><input id="dd-show-outside-check" type="checkbox"> Teile außerhalb des Druckbereichs anzeigen</label><p class="dd-keyboard-hint">⌨️ Laptop: Ausgewähltes Element mit den Pfeiltasten um 1 px bewegen · Umschalt + Pfeil: 10 px · Alt + Pfeil: 0,25 px. Vorher in die Vorschau klicken.</p>';align.appendChild(labelPanel);

 // ---- Bottom dock ----
 const dock=make('footer','dd-globaldock');dock.id='dd-globaldock';
 const dockMain=make('div','dd-dockmain');
 const save=make('button','dd-docksave','💾 Speichern');save.id='dd-dock-save';save.type='button';save.title='Aktuelles Etikett als Vorlage in diesem Browser speichern';
 save.onclick=async()=>{switchTab('vorlagen');if(!state.queue[state.selected]){message('Noch kein Etikett zum Speichern vorhanden.',true);return;}try{await saveCurrentTemplateToBrowser();}catch(e){message('Vorlage konnte nicht gespeichert werden: '+(e.message||e),true);}};
 dockMain.appendChild(save);
 const print=$('dd-print');if(print){print.classList.add('dd-dockprint');moved(print,dockMain);}
 const stop=moved($('dd-stop'),dockMain);if(stop){stop.classList.add('dd-dockstop');stop.textContent='⏹ Stopp';}
 const rolls=make('button','dd-dockrolls','🏷 Rollen');rolls.id='dd-dockrolls';rolls.type='button';rolls.title='Rollen und eigene Etikettgrößen';rolls.setAttribute('aria-expanded','false');dockMain.appendChild(rolls);
 const more=make('button','dd-dockjobs','⋯');more.id='dd-dockjobs';more.type='button';more.title='Druckerstatus und Protokoll';more.setAttribute('aria-label','Druckerstatus und Protokoll');more.setAttribute('aria-expanded','false');dockMain.appendChild(more);
 dock.appendChild(dockMain);
 const dockMeta=make('div','dd-dockmeta');moved($('dd-count'),dockMeta);moved($('dd-progress'),dockMeta);moved($('dd-state'),dockMeta);dock.appendChild(dockMeta);
 const drawer=make('div','dd-dockdrawer');drawer.id='dd-dockdrawer';drawer.hidden=true;
 const printSettings=make('section','dd-docksettings');
 printSettings.appendChild(make('p','dd-tab-lead','Drucker'));
 const statusButton=$('readstatus');if(statusButton){statusButton.textContent='Druckerstatus lesen';statusButton.style.display='inline-flex';moved(statusButton,printSettings);}
 const warn=root.querySelector(':scope > .dd-warning');if(warn)moved(warn,printSettings);
 const rollbox=$('rollbox');if(rollbox)moved(rollbox,drawer);
 drawer.appendChild(printSettings);
 const logbox=$('logbox');if(logbox){logbox.open=false;moved(logbox,drawer);}
 dock.appendChild(drawer);root.appendChild(dock);
 function measureDock(){if(!drawer.hidden)return;const h=Math.ceil(dock.getBoundingClientRect().height);if(h>20)document.documentElement.style.setProperty('--dock-h',h+'px');}
 function drawerOpen(kind){
   const show=drawer.hidden||drawer.dataset.view!==kind;
   if(show)measureDock();
   drawer.hidden=!show;drawer.dataset.view=show?kind:'';
   rolls.setAttribute('aria-expanded',show&&kind==='rolls'?'true':'false');
   more.setAttribute('aria-expanded',show&&kind==='more'?'true':'false');
   if(rollbox){rollbox.style.display=(show&&kind==='rolls')?'':'none';if(show&&kind==='rolls')rollbox.open=true;}
   if(logbox)logbox.style.display=(show&&kind==='more')?'':'none';
   printSettings.style.display=(show&&kind==='more')?'':'none';
 }
 rolls.onclick=()=>drawerOpen('rolls');more.onclick=()=>drawerOpen('more');
 document.addEventListener('pointerdown',e=>{if(!drawer.hidden&&!dock.contains(e.target)&&!e.target.closest('dialog'))drawerOpen(drawer.dataset.view);},true);
 if(window.ResizeObserver)new ResizeObserver(measureDock).observe(dock);
 measureDock();

 // ---- Resizable tool drawer (phone layout only) ----
 let panelFrac=.48;
 try{const v=Number(localStorage.getItem('niimbot-studio:panel-frac'));if(v>=.2&&v<=.9)panelFrac=v;}catch(e){}
 function limits(){const total=workspace.clientHeight||500;return {total,min:Math.min(150,total*.5),max:Math.max(150,total-190)};}
 function applyPanel(px){
   if(isDesktopLayout()){tools.style.removeProperty('height');tools.style.removeProperty('flex-basis');return;}
   const {min,max}=limits();const h=Math.min(max,Math.max(min,Math.round(px)));
   tools.style.height=h+'px';tools.style.flexBasis=h+'px';grip.setAttribute('aria-valuenow',String(h));
   requestAnimationFrame(()=>requestPreview());
 }
 function setPanelFraction(frac,persist=true){
   panelFrac=Math.max(.2,Math.min(.9,frac));applyPanel(limits().total*panelFrac);
   if(persist){try{localStorage.setItem('niimbot-studio:panel-frac',String(panelFrac));}catch(e){}}
 }
 window.NiimbotStudioUI.setPanelFraction=setPanelFraction;
 window.NiimbotStudioUI.refitPanel=()=>applyPanel(limits().total*panelFrac);
 let drag=null;
 grip.addEventListener('pointerdown',e=>{
   if(e.target.closest('button'))return;
   drag={pointerId:e.pointerId,y:e.clientY,height:tools.getBoundingClientRect().height};
   grip.setPointerCapture(e.pointerId);
 });
 grip.addEventListener('pointermove',e=>{if(!drag||drag.pointerId!==e.pointerId)return;applyPanel(drag.height+(drag.y-e.clientY));});
 const endDrag=e=>{if(!drag||drag.pointerId!==e.pointerId)return;drag=null;const {total}=limits();setPanelFraction(tools.getBoundingClientRect().height/total);};
 grip.addEventListener('pointerup',endDrag);grip.addEventListener('pointercancel',endDrag);
 grip.addEventListener('keydown',e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();setPanelFraction(panelFrac+(e.key==='ArrowUp'?.05:-.05));}});
 grip.tabIndex=0;
 window.addEventListener('resize',()=>{window.NiimbotStudioUI.refitPanel();measureDock();});
 requestAnimationFrame(()=>window.NiimbotStudioUI.refitPanel());
 try{selectedTab=sessionStorage.getItem('niimbot-studio:tab')||'dateien';}catch(e){}
 switchTab(selectedTab);

 $('dd-template-save-browser').onclick=async()=>{try{await saveCurrentTemplateToBrowser();}catch(e){message('Vorlage konnte nicht gespeichert werden: '+(e.message||e),true);}};
 $('dd-template-save-as').onclick=async()=>{try{await saveCurrentTemplateToBrowser({saveAs:true});}catch(e){message('Speichern als Kopie fehlgeschlagen: '+(e.message||e),true);}};
 $('dd-template-export-file').onclick=()=>exportCurrentTemplateFile().catch(e=>message('Export fehlgeschlagen: '+(e.message||e),true));
 $('dd-template-import-btn').onclick=()=>$('dd-template-import-file').click();
 $('dd-template-import-file').onchange=async event=>{const file=event.target.files?.[0];if(!file)return;try{await importTemplateFile(file);}catch(e){message('Vorlage konnte nicht importiert werden: '+(e.message||e),true);}event.target.value='';};
 $('dd-template-search').oninput=renderTemplateLibrary;
 for(const [id,key] of [['dd-template-name','templateName'],['dd-template-folder','templateFolder']])$(id).addEventListener('input',()=>{const entry=state.queue[state.selected];if(entry)entry[key]=$(id).value;});
 $('dd-rotate-label').onclick=toggleLabelRotation;
 $('dd-label-rotate-mode').value=state.labelRotateMode;
 $('dd-label-rotate-mode').onchange=e=>{state.labelRotateMode=e.target.value==='with'?'with':'keep';};
 $('dd-show-outside-check').onchange=e=>{state.showOutsideBounds=!!e.target.checked;updateTemplateUiState();requestPreview();};
 renderTemplateLibrary();
 // Remove exhausted source wrappers; keep remaining guidance in the Files tab.
 for(const child of [...root.children]){
   if(child===printer||child===workspace||child===dock)continue;
   if(child.classList.contains('dd-muted')&&child.textContent.trim())moved(child,pages.get('align'));
   else child.remove();
 }
 if(cropDialog){cropDialog.style.zIndex='1500';}
}

try{state.printView=localStorage.getItem('niimbot-studio:printview')!=='0';}catch(e){}
setupTabbedLayout();
if(window.ResizeObserver)new ResizeObserver(requestPreview).observe($('dd-editorwrap'));
function syncViewport(){document.documentElement.style.setProperty('--studio-height',(window.visualViewport?.height||window.innerHeight)+'px');requestPreview();}
window.visualViewport?.addEventListener('resize',syncViewport);window.addEventListener('orientationchange',()=>setTimeout(syncViewport,250));syncViewport();
loadTemplateStore();
wireTextEditor();wireAdditionalControls();renderFonts();renderTextControls();setImagePanel(null);setPreviewZoomUi();updateEditorViewport(null);updateHistoryControls();updateTemplateUiState();
(async()=>{
  await loadSavedFonts();
  try{ bluetoothHint(); for(let t=0;t<150 && !loaded();t++)await sleep(100); if(!loaded())throw Error('Druckermodelle wurden nicht geladen. Bitte prüfen, ob niimbot-demo.html, niimbot.js und registry.json im Hauptverzeichnis liegen.');
    await upstreamRegistry();
    for(const o of $('model').options)o.textContent=o.textContent.replace(/^Niimbot\s+/,'');
    committedSettings=readSettings();updatePrinterSummary();showQueue(); await showPreview();
    message(window.Niimbot?.isSupported?.()?'Bereit. Drucker verbinden, Etikettgröße wählen und Bild, PDF oder Text hinzufügen.':'Bereit zum Gestalten. Zum Drucken die Seite in Bluefy (iPhone) bzw. Chrome/Edge (Computer) öffnen.'); }
  catch(e){ message('Start: '+(e.message||e)+' Seite neu laden und Internetverbindung prüfen.',true); }
})();
