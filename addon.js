const $ = id => document.getElementById(id);
const state = {
  queue: [], pdfJs: null, registry: null, selected: -1,
  printing: false, stop: false, previewVersion: 0, fonts: [], textSelectedId: null, activeImageId: "image", cropState: null,
  editor: { pointers: new Map(), mode: null, start: null, crop: null, sizeInfo: null, entry: null },
  viewZoom: 1, showOutsideBounds: false, savedTemplates: []
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
function copyLayoutForTarget(layout,sx,sy,s){if(!layout)return null;return {...layout,tx:(Number(layout.tx)||0)*sx,ty:(Number(layout.ty)||0)*sy,scale:(Number(layout.scale)||1)*s,baseScale:(Number(layout.baseScale)||1)*s};}
function adaptEntryToCurrentSize(entry,record){
 let baseInfo;try{baseInfo=readSize();}catch(e){return entry;}
 const sourceSize=sizeByKey(record?.sizeKey);if(!sourceSize)return entry;
 const sourceEntry={pageRotation:record?.pageRotation===90?90:0};
 const sourceEffective=effectiveSizeInfo(sourceEntry,{...baseInfo,size:{...sourceSize},sizeKey:record.sizeKey});
 const targetEffective=effectiveSizeInfo(entry,baseInfo);
 const sx=targetEffective.size.w_px/sourceEffective.size.w_px,sy=targetEffective.size.h_px/sourceEffective.size.h_px,s=Math.min(sx,sy);
 if(!isFinite(sx)||!isFinite(sy)||sx<=0||sy<=0)return entry;
 for(const t of (entry.texts||[])){
   t.x=(Number(t.x)||0)*sx;t.y=(Number(t.y)||0)*sy;t.size=Math.max(4,(Number(t.size)||32)*s);
   if(t.boxW)t.boxW=(Number(t.boxW)||0)*sx;if(t.boxH)t.boxH=(Number(t.boxH)||0)*sy;
   if(t.curveRadius)t.curveRadius=(Number(t.curveRadius)||0)*s;
 }
 const sourceKey=record.sizeKey+(record?.pageRotation===90?"|r90":"");
 const targetKey=baseInfo.sizeKey+orientationSuffix(entry);
 const remapLayouts=obj=>{if(!obj)return;const all=obj.layouts||{};const src=all[sourceKey]||all[record.sizeKey]||Object.values(all)[0]||null;obj.layouts={};if(src)obj.layouts[targetKey]=copyLayoutForTarget(src,sx,sy,s);};
 remapLayouts(entry);for(const layer of (entry.images||[]))remapLayouts(layer);
 return entry;
}
async function makeTemplateThumbnail(entry,info){
 const full=await renderLabelCanvas(entry,info);const t=document.createElement('canvas');const factor=Math.min(1,240/Math.max(full.width,full.height));t.width=Math.max(1,Math.round(full.width*factor));t.height=Math.max(1,Math.round(full.height*factor));t.getContext('2d').drawImage(full,0,0,t.width,t.height);full.width=full.height=0;
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
function templateSourceInfo(record){
 let base=readSize();const size=record.sizeMeta||sizeByKey(record.sizeKey);
 if(!size)throw Error('Die Original-Etikettengröße ist unbekannt. Vorlage als editierbare Ebenen öffnen.');
 return {...base,size:{...size},sizeKey:record.sizeKey||base.sizeKey};
}
function sameTemplateSize(record,info){const source=record.sizeMeta||sizeByKey(record.sizeKey);return !!source&&Number(source.w_px)===Number(info.size.w_px)&&Number(source.h_px)===Number(info.size.h_px)&&(!record.modelDpi||Number(record.modelDpi)===Number(info.model?.dpi||info.size.dpi||201));}
async function flattenEntryForResizing(entry,sourceInfo,name){
 const full=await renderLabelCanvas(entry,sourceInfo);const blob=await new Promise((resolve,reject)=>full.toBlob(b=>b?resolve(b):reject(Error('Etikett konnte nicht in ein Bild umgewandelt werden')),'image/png'));
 full.width=full.height=0;
 return {kind:'image',blob,name:name+' (angepasst)',importDpi:'original',layouts:{},texts:[],images:[],layers:['image'],crop:{x:0,y:0,w:1,h:1,shape:'rect',preset:'free'},pageRotation:0,templateFlattened:true};
}
async function prepareTemplateEntry(record,mode='edit'){
 await restoreTemplateFonts(record);const currentInfo=readSize();let entry=snapshotClone(record.entry);delete entry.editorId;const isSame=sameTemplateSize(record,currentInfo);
 if(!isSame)entry=await flattenEntryForResizing(entry,templateSourceInfo(record),record.name);
 else {
  const oldKey=record.sizeKey+orientationSuffix(entry),newKey=currentInfo.sizeKey+orientationSuffix(entry);
  if(oldKey!==newKey)for(const layer of [entry,...(entry.images||[])]){if(layer.layouts?.[oldKey])layer.layouts[newKey]=snapshotClone(layer.layouts[oldKey]);}
  entry.templateSourceSizeKey=currentInfo.sizeKey;entry.templateSourceSizeMeta={...currentInfo.size};
 }
 if(mode==='edit'&&isSame)entry.templateId=record.id;else delete entry.templateId;
 entry.templateName=record.name;entry.templateFolder=record.folder||'Meine Vorlagen';entry.pageRotation=isSame?(record.pageRotation===90?90:0):0;
 return {entry,isSame};
}
async function openTemplateRecord(record,{mode='edit'}={}){
 if(isBusy())return;state.templateBusy=true;refreshBusyUi();
 try{
  const {entry,isSame}=await prepareTemplateEntry(record,mode);
  beginHistory('Vorlage '+(mode==='queue'?'in Warteschlange':'öffnen'));
  state.queue.push(entry);state.selected=state.queue.length-1;state.textSelectedId=null;state.activeImageId='image';showQueue();renderTextControls();setImagePanel(activeImageLayer(entry));requestPreview();scheduleHistoryCommit(100);
  if(mode!=='queue')window.NiimbotStudioUI?.selectTab(isSame?'text':'align');
  message(mode==='queue'?'Vorlage zur Warteschlange hinzugefügt: '+record.name:isSame?'Vorlage '+(mode==='copy'?'als Kopie':'zum Bearbeiten')+' geöffnet.':'Vorlage auf '+($('size')?.selectedOptions?.[0]?.textContent?.trim()||'neue Größe')+' als frei verschiebbares Gesamtbild geladen. Original bleibt gespeichert.');
 }catch(e){message('Vorlage konnte nicht geöffnet werden: '+(e.message||e),true);}finally{state.templateBusy=false;refreshBusyUi();}
}
async function printSavedTemplate(record){return runPrintJob(async()=>[(await prepareTemplateEntry(record,'queue')).entry],1);}
async function handleSizeChange(){
 if(!loaded()||history.restoring)return;
 const now=readSettings();if(!committedSettings){committedSettings=now;return;}
 if(now.model===committedSettings.model&&now.size===committedSettings.size&&now.density===committedSettings.density)return;
 if(isBusy()){restoreSettings(committedSettings);return;}
 clearHistoryTimer();commitHistory();beginHistory('Druckeinstellungen wechseln');history.hold=true;state.resizingTemplate=true;refreshBusyUi();
 try{
  const newInfo=readSize();
  const replacements=[];
  for(let i=0;i<state.queue.length;i++){
   const entry=state.queue[i];if(!entry.templateSourceSizeKey||entry.templateFlattened)continue;
   const record={sizeMeta:entry.templateSourceSizeMeta,sizeKey:entry.templateSourceSizeKey};
   if(sameTemplateSize(record,newInfo)){
    const oldKey=entry.templateSourceSizeKey+orientationSuffix(entry),newKey=newInfo.sizeKey+orientationSuffix(entry);
    for(const layer of [entry,...(entry.images||[])])if(layer.layouts?.[oldKey])layer.layouts[newKey]=snapshotClone(layer.layouts[oldKey]);
    entry.templateSourceSizeKey=newInfo.sizeKey;continue;
   }
   const source={...newInfo,size:{...entry.templateSourceSizeMeta},sizeKey:entry.templateSourceSizeKey};
   replacements.push([i,await flattenEntryForResizing(snapshotClone(entry),source,entry.templateName||entry.name)]);
  }
  for(const [i,entry] of replacements)state.queue[i]=entry;
  committedSettings=now;if(replacements.length)message('Neue Rollengröße: '+replacements.length+' gespeicherte Vorlage(n) als Gesamtbild übernommen.');
 }catch(e){restoreSettings(committedSettings);message('Größenwechsel fehlgeschlagen: '+e.message,true);}
 finally{history.hold=false;state.resizingTemplate=false;commitHistory();refreshBusyUi();showQueue();renderTextControls();setImagePanel(activeImageLayer(state.queue[state.selected]));requestPreview();}
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
function updateTemplateUiState(){const hasCurrent=!!state.queue[state.selected];for(const id of ["dd-template-save-browser","dd-template-save-as","dd-template-export-file"]){if($(id))$(id).disabled=!hasCurrent||isBusy();}if($("dd-label-rotation-status"))$("dd-label-rotation-status").textContent=state.queue[state.selected]?.pageRotation===90?"90° Hochkant":"0° Querformat";if($("dd-preview-overflow-toggle")){$("dd-preview-overflow-toggle").textContent=state.showOutsideBounds?"Außen ausblenden":"Außen zeigen";$("dd-preview-overflow-toggle").setAttribute("aria-pressed",String(state.showOutsideBounds));}if($("dd-show-outside-check"))$("dd-show-outside-check").checked=!!state.showOutsideBounds;}
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
 beginHistory('Druckbereich 90° drehen');
 const oldW=current.sizeInfo.size.w_px,oldH=current.sizeInfo.size.h_px;
 const newW=oldH,newH=oldW;
 for(const t of (entry.texts||[])){t.x=(Number(t.x)||0)-oldW/2+newW/2;t.y=(Number(t.y)||0)-oldH/2+newH/2;}
 const oldKey=current.sizeInfo.sizeKey;
 entry.pageRotation=entry.pageRotation===90?0:90;
 const newKey=readSize().sizeKey+orientationSuffix(entry);
 for(const layer of allImages(entry).map(x=>x.layer)){
  const prev=layer.layouts?.[oldKey];if(prev){layer.layouts||={};layer.layouts[newKey]=snapshotClone(prev);}
 }
 requestPreview();showQueue();scheduleHistoryCommit(120);
 message(entry.pageRotation===90?'Druckbereich 90° hochkant. Der physische Druck bleibt an die eingelegte Rolle angepasst.':'Druckbereich wieder quer.');
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
function loadScript(url){return new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=url;script.async=true;script.onload=resolve;script.onerror=()=>reject(Error('PDF-Bibliothek nicht geladen. Den vollständigen vendor-Ordner mit hochladen.'));document.head.appendChild(script);});}
async function pdfLib(){ if(state.pdfJs)return state.pdfJs; if(!window.pdfjsLib)await loadScript(PDF_URL); if(!window.pdfjsLib)throw Error('PDF.js ist nicht verfügbar.'); window.pdfjsLib.GlobalWorkerOptions.workerSrc=PDF_WORKER; state.pdfJs=window.pdfjsLib; return state.pdfJs; }
function swap(i,j){ [state.queue[i],state.queue[j]]=[state.queue[j],state.queue[i]]; if(state.selected===i)state.selected=j; else if(state.selected===j)state.selected=i; showQueue(); }
function showQueue(){
  for(const item of state.queue)if(item!==state.queue[state.selected])releaseDecodedImages(item);
  const root=$('dd-queue'); root.replaceChildren(); const total=state.queue.length; const copies=copyCount();
  $('dd-count').textContent=total+' Seite(n) · '+(total*copies)+' Etikett(en) inkl. Kopien';
  state.queue.forEach((entry,i)=>{
    const row=document.createElement('div'); row.className='dd-queueitem'; if(state.selected===i)row.style.borderColor='#155bb0';
    const im=document.createElement('div'); im.className='dd-thumb'; im.textContent=(entry.kind==='pdf'?'PDF':'IMG'); im.style.cssText+='display:grid;place-items:center;font-size:.65rem;font-weight:750;color:#64748b';
    const details=document.createElement('div');
    const title=document.createElement('div'); title.className='dd-title'; title.textContent=entry.name+(entry.pageRotation===90?' · 90°':'');
    const sub=document.createElement('div'); sub.className='dd-muted'; sub.textContent='Import: '+(entry.importDpi==='original'?'Original':entry.importDpi+' dpi')+(entry.templateName?' · Vorlage: '+entry.templateName:'');
    details.append(title,sub);
    const buttons=document.createElement('div'); buttons.className='dd-inline';
    const ops=[['Vorschau',()=>{state.selected=i;state.textSelectedId=null;state.activeImageId="image";showQueue();renderTextControls();setImagePanel(activeImageLayer(state.queue[i]));showPreview()},false],['↑',()=>swap(i,i-1),i===0],['↓',()=>swap(i,i+1),i===total-1],['×',()=>{revokeEntry(state.queue[i]);state.queue.splice(i,1);if(i<state.selected)state.selected--;else if(state.selected>=state.queue.length)state.selected=state.queue.length-1;state.textSelectedId=null;state.activeImageId="image";showQueue();renderTextControls();showPreview()},false]];
    for(const [label,action,disabled] of ops){const btn=document.createElement('button');btn.type='button';btn.textContent=label;btn.disabled=isBusy()||disabled;btn.onclick=action;buttons.append(btn);}    
    row.append(im,details,buttons); root.append(row);
  }); buttonState(); syncTemplateFields();renderTemplateLibrary();
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
  const dpi = importMode==='original' ? 144 : Number(importMode)||201;
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
async function addFiles(files,asLayersOverride=null){
 const input=Array.from(files||[]);if(!input.length||isBusy())return;
 const asLayers=asLayersOverride===null?$('dd-import-mode').value==='layers':Boolean(asLayersOverride);
 let target=state.queue[state.selected]||null;
 if(asLayers&&!target){message('Bitte zuerst ein Etikett erstellen.',true);return;}
 clearHistoryTimer();commitHistory();beginHistory('Dateien importieren');history.hold=true;state.importingFiles=true;refreshBusyUi();
 let added=0,skipped=0;const importMode=$('dd-importdpi').value,autoCrop=$('dd-crop-onimport').checked;
 const capacity=()=>asLayers?100-allImages(target).length:MAX_PAGES-state.queue.length;
 const addBlob=async(blob,name,kind)=>{
  let layer;if(capacity()<=0)throw Error('Maximal 100 Etiketten bzw. Bildebenen.');
  if(asLayers){target.images||=[];layer=createImageLayer(blob,name,importMode);target.images.push(layer);layerOrder(target);state.activeImageId=layer.id;}
  else{target={kind,blob,name,importDpi:importMode,layouts:{},texts:[],images:[],crop:{x:0,y:0,w:1,h:1,shape:'rect',preset:'free'}};state.queue.push(target);state.selected=state.queue.length-1;layer=target;state.activeImageId='image';}
  state.textSelectedId=null;added++;showQueue();renderTextControls();setImagePanel(layer);await showPreview();if(autoCrop)await openCropEditor(layer);
 };
 try{
  for(const file of input){
   if(capacity()<=0){skipped++;continue;}
   if(file.size>FILE_LIMIT){skipped++;message('Datei zu groß (max. 40 MB): '+file.name,true);continue;}
   const ext=(file.name.split('.').pop()||'').toLowerCase();
   try{
    if(file.type==='application/pdf'||ext==='pdf'){
     const lib=await pdfLib(),task=lib.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,useSystemFonts:false,standardFontDataUrl:'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/',cMapUrl:'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',cMapPacked:true});
     let doc;try{doc=await task.promise;const max=Math.min(doc.numPages,capacity());if(max<doc.numPages)skipped+=doc.numPages-max;
      for(let n=1;n<=max;n++){const page=await doc.getPage(n);try{await addBlob(await rasterizePdfPage(page,importMode),file.name+' – Seite '+n,'pdf');}finally{page.cleanup();}}
     }finally{await task.destroy();}
    }else if(['png','jpg','jpeg'].includes(ext)||['image/png','image/jpeg'].includes(file.type)){await decodeBlob(file);await addBlob(file,file.name,'image');}
    else{skipped++;message('Dateityp nicht unterstützt: '+file.name,true);}
   }catch(e){skipped++;message('Datei konnte nicht verarbeitet werden: '+file.name+' – '+(e.message||e),true);}
  }
 }finally{history.hold=false;state.importingFiles=false;commitHistory();refreshBusyUi();showQueue();renderTextControls();setImagePanel(activeImageLayer(state.queue[state.selected]));requestPreview();}
 message(added+' Bilddatei(en)/PDF-Seite(n) hinzugefügt'+(skipped?' · '+skipped+' Datei(en)/Seite(n) übersprungen.':'.'),!!skipped);
}
function normalizedCrop(layer){return validNormalizedCrop(layer?.crop||{});}

function refSize(entry,img,size){
 const c=normalizedCrop(entry),w=img.naturalWidth*c.w,h=img.naturalHeight*c.h;
 if(entry.importDpi==='300'||entry.importDpi==='201'){
  const dpi=Number(entry.importDpi);return {w:w*((size.dpi||201)/dpi),h:h*((size.dpi||201)/dpi)};
 }
 return {w,h};
}

function initLayout(entry,sizeInfo,img,mode){
  const ref=refSize(entry,img,sizeInfo.size); const fit=mode || $('dd-fit').value; let scale=(fit==='cover'?Math.max(sizeInfo.size.w_px/ref.w,sizeInfo.size.h_px/ref.h):Math.min(sizeInfo.size.w_px/ref.w,sizeInfo.size.h_px/ref.h));
  if(!isFinite(scale)||scale<=0)scale=1; entry.layouts ||= {}; entry.layouts[sizeInfo.sizeKey]={tx:0,ty:0,scale,baseScale:scale,rotation:0,refW:ref.w,refH:ref.h}; return entry.layouts[sizeInfo.sizeKey];
}
async function getLayout(entry,sizeInfo,modeIfInit){ const img=await ensureImage(entry); let layout=entry.layouts?.[sizeInfo.sizeKey]; const ref=refSize(entry,img,sizeInfo.size); if(!layout || Math.abs(layout.refW-ref.w)>.001 || Math.abs(layout.refH-ref.h)>.001) layout=initLayout(entry,sizeInfo,img,modeIfInit); return {img,layout}; }
// The image and text are rasterized by the SAME function for screen and printer.
function clampScale(v){ return Math.max(.015,Math.min(50,Number(v)||1)); }
function normalizeAngle(a){ return (((Number(a)||0)+180)%360+360)%360-180; }
function degrees(angle){ return (Number(angle)||0)*Math.PI/180; }
function updateEditorViewport(size){
 const canvas=$('dd-editor'),wrap=$('dd-editorwrap');if(!canvas||!wrap)return;
 if($('dd-workspace')){canvas.style.height=Math.max(120,Math.round(wrap.clientHeight||240))+'px';return;}
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
 const pad=Math.max(24,Math.round(Math.min(cssW,cssH)*.09));
 const fit=Math.max(.0001,Math.min(Math.max(1,cssW-2*pad)/size.w_px,Math.max(1,cssH-2*pad)/size.h_px));
 const previewScale=fit*.91*Math.max(.2,Math.min(2.5,Number(viewZoom)||1));
 const w=size.w_px*previewScale,h=size.h_px*previewScale;
 return {x:(cssW-w)/2,y:(cssH-h)/2,w,h,scale:previewScale};
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
}
function moveLayer(id,position){
 const entry=state.queue[state.selected];if(!entry||layerLocked(entry,id))return;const order=layerOrder(entry),i=order.indexOf(id);if(i<0)return;
 order.splice(i,1);const target=position==='front'?order.length:position==='back'?0:Math.max(0,Math.min(order.length,i+position));order.splice(target,0,id);renderTextControls();requestPreview();
}
function removeImageLayer(id){
 const entry=state.queue[state.selected];if(!entry||state.printing||layerLocked(entry,id))return;
 if(id==='image'){
   if(entry.objectUrl)URL.revokeObjectURL(entry.objectUrl);entry.objectUrl='';entry.kind='blank';entry.img=null;entry.imgPromise=null;entry.layouts={};
 }else{const idx=(entry.images||[]).findIndex(im=>im.id===id);if(idx<0)return;revokeEntry(entry.images[idx]);entry.images.splice(idx,1);}
 entry.layers=(entry.layers||[]).filter(x=>x!==id);
 if(state.activeImageId===id)state.activeImageId=allImages(entry).at(-1)?.id||'image';
 renderTextControls();setImagePanel(activeImageLayer(entry));requestPreview();
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
  const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.title='Bildebene entfernen';remove.disabled=locked;remove.onclick=()=>removeImageLayer(id);row.append(remove);}
  root.append(row);
 });
 const active=activeImageLayer(entry);if($('dd-active-image'))$('dd-active-image').textContent=state.textSelectedId?'Aktiv: Textfeld':active?'Aktives Bild: '+(active.name||entry.name)+' · Bild- und Beschnittwerte gelten nur für diese Ebene':'Kein Bild ausgewählt';
 if($('dd-crop-image'))$('dd-crop-image').disabled=!active||state.printing||!!active.locked;
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
const ADJUST_DEFAULTS={exposure:0,contrast:0,blacks:0,whites:0,brightness:0,saturation:0,gamma:1,threshold:160,mode:'default'};
const ADJUST_KEYS=['exposure','contrast','blacks','whites','brightness','saturation','gamma','threshold'];
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
 for(const key of ADJUST_KEYS){
   syncAdjustControl(key, values[key] ?? ADJUST_DEFAULTS[key]);
   // No-op editing on an empty queue is confusing, so deactivate inputs until a label exists.
   for(const el of [$('dd-'+key),$('dd-'+key+'-number'),$('dd-'+key+'-minus'),$('dd-'+key+'-plus')])el.disabled=!entry;
   if(entry)syncAdjustControl(key, values[key] ?? ADJUST_DEFAULTS[key]);
 }
 $('dd-bw').value=values.mode||'default';
 const disabled=!entry||!!entry.locked;
 $('dd-bw').disabled=disabled;$('dd-adjust-reset').disabled=disabled;
 for(const key of ADJUST_KEYS){for(const suffix of ['', '-number','-minus','-plus'])$('dd-'+key+suffix).disabled=disabled;if(!disabled)syncAdjustControl(key,values[key]??ADJUST_DEFAULTS[key]);}

}
function clamp01(v){return Math.max(0,Math.min(1,v));}
function applyAdjustments(ctx,w,h,a){
 const img=ctx.getImageData(0,0,w,h),px=img.data;
 const brightness=(Number(a.brightness)||0)/100, exposure=Math.pow(2,(Number(a.exposure)||0)/45),contrast=(Number(a.contrast)||0)/100;
 const black=(Number(a.blacks)||0)/100,white=(Number(a.whites)||0)/100,sat=1+(Number(a.saturation)||0)/100,gamma=Number(a.gamma)||1;
 const gray=a.mode==='gray',hard=a.mode==='bw',threshold=Number(a.threshold??160);
 for(let i=0;i<px.length;i+=4){if(!px[i+3])continue;
   let r=px[i]/255,g=px[i+1]/255,b=px[i+2]/255;
   const l=.2126*r+.7152*g+.0722*b;
   r=clamp01(l+(r-l)*sat);g=clamp01(l+(g-l)*sat);b=clamp01(l+(b-l)*sat);
   if(gray||hard){const v=.2126*r+.7152*g+.0722*b;r=g=b=v;}
   const adj=v=>{v=clamp01(v*exposure+brightness);
     v=clamp01(.5+(v-.5)*(contrast>=0?1+contrast*2:1/(1-contrast*2)));
     v=clamp01(v-black*Math.pow(1-v,2)*.75+white*Math.pow(v,2)*.75);
     return clamp01(Math.pow(v,1/gamma));};
   r=adj(r);g=adj(g);b=adj(b);
   if(hard){r=g=b=(.2126*r+.7152*g+.0722*b)*255<threshold?0:1;}
   px[i]=Math.round(r*255);px[i+1]=Math.round(g*255);px[i+2]=Math.round(b*255);
 }
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
async function renderLabelCanvas(entry,baseSizeInfo,{physical=false}={}){
 const sizeInfo=effectiveSizeInfo(entry,baseSizeInfo),{size}=sizeInfo;validateSize(size);const canvas=document.createElement('canvas');canvas.width=Math.round(size.w_px);canvas.height=Math.round(size.h_px);
 if(canvas.width*canvas.height>12_000_000)throw Error('Etikett ist zu groß (max. 12 Millionen Pixel)');
 const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
 for(const id of layerOrder(entry)){
   const layer=imageForId(entry,id);
   if(layer){const {img,layout}=await getLayout(layer,sizeInfo);const raster=rasterizeImageLayer(layer,sizeInfo,img,layout);ctx.drawImage(raster,0,0);raster.width=raster.height=0;}
   else{const t=(entry.texts||[]).find(t=>t.id===id);if(t)drawTextItem(ctx,t,canvas.width);}
 }
 if(!physical || entry.pageRotation!==90)return canvas;
 const out=document.createElement('canvas');out.width=Math.round(baseSizeInfo.size.w_px);out.height=Math.round(baseSizeInfo.size.h_px);
 const octx=out.getContext('2d',{alpha:false});octx.fillStyle='#fff';octx.fillRect(0,0,out.width,out.height);octx.save();octx.translate(out.width/2,out.height/2);octx.rotate(Math.PI/2);octx.drawImage(canvas,-canvas.width/2,-canvas.height/2);octx.restore();canvas.width=canvas.height=0;return out;
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
 if(!entry){updateEditorViewport(null);const {ctx,cssW,cssH}=editorSize();ctx.fillStyle='#e9eef5';ctx.fillRect(0,0,cssW,cssH);ctx.fillStyle='#64748b';ctx.font='15px sans-serif';ctx.textAlign='center';ctx.fillText('Datei oder leeres Etikett hinzufügen',cssW/2,cssH/2);$('dd-preview-title').textContent='Ausschnitt & Druckvorschau';state.editor.crop=null;state.editor.entry=null;state.editor.imageHandle=null;state.editor.textHandles=null;return;}
 $('dd-preview-title').textContent='Ausschnitt & Druckvorschau: '+entry.name+(entry.pageRotation===90?' · 90°':'');
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
    for(const id of layerOrder(entry)){
      const layer=imageForId(entry,id);
      if(layer){const {img,layout}=await getLayout(layer,sizeInfo);drawImageOutsidePrintArea(ctx,img,layout,crop,layer);}
      else {const t=(entry.texts||[]).find(t=>t.id===id);if(t){ctx.save();ctx.translate(crop.x,crop.y);ctx.scale(crop.scale,crop.scale);drawTextItem(ctx,t,sizeInfo.size.w_px);ctx.restore();}}
    }
  }else{
    const label=await renderLabelCanvas(entry,baseSizeInfo);
    if(version!==state.previewVersion){label.width=label.height=0;return;}
    ctx.drawImage(label,crop.x,crop.y,crop.w,crop.h);label.width=label.height=0;
  }
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
  setRotationField(activeResult?.layout||{scale:1,baseScale:1,rotation:0});setZoomField(activeResult?.layout||{scale:1,baseScale:1,rotation:0});setPreviewZoomUi();
 }catch(e){if(version!==state.previewVersion)return;message('Vorschau nicht verfügbar: '+(e.message||e),true);}
}

async function learnRollAfterPrint(size,sizeKey){ if(!window.labelMemory||!window.Niimbot?.printer)return; try{ const result=await Niimbot.getStatus(); const rfid=result?.decoded?.rfid; if(!rfid?.tagPresent||!rfid.barCode)return; const prev=window.labelMemory.recall(rfid.barCode)||{}; const mm=Number(size.w_mm)>0&&Number(size.h_mm)>0; const rec={...prev,...(mm?{w_mm:size.w_mm,h_mm:size.h_mm}:{size:sizeKey})}; if(mm)delete rec.size; else{delete rec.w_mm;delete rec.h_mm;} window.labelMemory.remember(rfid.barCode,rec); }catch(e){ console.log('[dragdrop] RFID nach Druck nicht abrufbar:',e.message||e);} }
async function printAll(){if(!state.queue.length)return;return runPrintJob(async()=>snapshotClone(state.queue),copyCount());}
async function runPrintJob(entriesForJob,copies){
 if(isBusy()||state.cropState)return;clearHistoryTimer();commitHistory();
 state.printing=true;state.stop=false;$('dd-progress').value=0;refreshBusyUi();showQueue();
 try{
  await upstreamRegistry();const sizeInfo=snapshotClone(readSize()),{model,size,density,sizeKey}=sizeInfo;
  if(!Niimbot.isSupported())throw Error('Dieser Browser stellt kein Web Bluetooth bereit.');
  if(!Niimbot.printer)throw Error('Bitte zuerst oben den Drucker verbinden.');
  if(Number(Niimbot.printer.modelId)!==Number(model.id))throw Error('Verbundenes Modell passt nicht zur Auswahl.');
  const entries=await entriesForJob(),total=entries.length*copies;let completed=0;
  for(const entry of entries){
   if(state.stop)break;const canvas=await renderLabelCanvas(entry,sizeInfo,{physical:true});const url=canvas.toDataURL('image/png');canvas.width=canvas.height=0;releaseDecodedImages(entry);
   for(let n=0;n<copies;n++){
    if(state.stop)break;message('Drucke '+(completed+1)+' von '+total+' …');
    await Niimbot.printImage(url,{model,size,density,onProgress:s=>{if(s!=='ok')$('dd-state').textContent='Druckstatus: '+String(s);}});
    completed++;$('dd-progress').value=100*completed/total;
   }
  }
  if(state.stop)message('Druck angehalten: '+completed+' von '+total+' Etiketten bestätigt.');
  else{await learnRollAfterPrint(size,sizeKey);message('Fertig: '+completed+' Etikett(en) bestätigt.');}
 }catch(e){message('Druckfehler: '+(e.message||e)+' · Bitte Papier prüfen; ein Etikett kann bereits ausgegeben worden sein.',true);}
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
 try{const c=document.createElement('canvas');c.width=c.height=2;const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,2,2);
 const blob=await new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(Error('Leeres Etikett konnte nicht erstellt werden')),'image/png'));
 state.queue.push({kind:'blank',blob,name:'Leeres Etikett '+(state.queue.length+1),importDpi:'original',layouts:{},texts:[],images:[],pageRotation:0});state.selected=state.queue.length-1;state.textSelectedId=null;state.activeImageId='image';
 }catch(e){message(e.message,true);}finally{history.hold=false;state.creatingLabel=false;commitHistory();refreshBusyUi();showQueue();setImagePanel(activeImageLayer(state.queue[state.selected]));requestPreview();renderTextControls();}
}
function duplicateText(){const t=selectedText(),entry=state.queue[state.selected];if(!t||t.locked)return;const copy={...t,id:newText().id,x:t.x+10,y:t.y+10};entry.texts.push(copy);layerOrder(entry);state.textSelectedId=copy.id;renderTextControls();requestPreview();}
function removeText(){const entry=state.queue[state.selected],id=state.textSelectedId;if(!entry||layerLocked(entry,id))return;entry.texts=entry.texts.filter(t=>t.id!==id);layerOrder(entry);state.textSelectedId=entry.texts.at(-1)?.id||null;renderTextControls();requestPreview();}
function wireTextEditor(){const textfields={'dd-textcontent':'text','dd-font':'font','dd-fontsize':'size','dd-textalign':'align','dd-textwidth':'widthPct','dd-boxwidth':'boxW','dd-boxheight':'boxH','dd-textvertical':'vertical','dd-textwrap':'wrap','dd-textx':'x','dd-texty':'y','dd-letterspace':'letterSpace','dd-lineheight':'lineHeight','dd-textrotation':'rotation','dd-textscaling':'autoFit'};
 for(const [id,key] of Object.entries(textfields))$(id).addEventListener(id==='dd-font'||id==='dd-textscaling'||id==='dd-textalign'?'change':'input',e=>{const t=selectedText();if(!t||t.locked)return;let val=e.target.value;if(key==='autoFit')val=val==='fit';else if(['size','widthPct','boxW','boxH','x','y','letterSpace','lineHeight','rotation'].includes(key)){if(val===''||!Number.isFinite(Number(val)))return;val=Number(val);if(e.target.min!=='')val=Math.max(Number(e.target.min),val);if(e.target.max!=='')val=Math.min(Number(e.target.max),val);}t[key]=val;if(key==='boxW'){t.boxW=Math.max(20,val/textScale(t));const cur=currentEntryAndLayout();if(cur)t.widthPct=Math.round(val*100/cur.sizeInfo.size.w_px);}
  if(key==='boxH')t.boxH=Math.max(20,val/textScale(t));
  if(key==='rotation'){t.rotation=normalizeAngle(val);syncTextTransformFields(t);}
  if(key==='widthPct'){const cur=currentEntryAndLayout();if(cur)t.boxW=Math.round(cur.sizeInfo.size.w_px*val/(100*textScale(t)));}requestPreview();if(key==='text')renderTextListOnly();});
 for(const [id,key] of [['dd-textbold','bold'],['dd-textitalic','italic'],['dd-textunderline','underline'],['dd-textstrike','strike']])$(id).onclick=()=>{const t=selectedText();if(!t||t.locked)return;t[key]=!t[key];renderTextControls();requestPreview();};
 $('dd-textinverse').onchange=e=>{const t=selectedText();if(t&&!t.locked){t.inverse=e.target.checked;requestPreview();}};
 function setTextFlow(flow){const t=selectedText();if(!t||t.locked)return;t.flow=flow;if(flow==='curve'){t.curveDeg=Math.abs(normalizeCurveDeg(t.curveDeg));t.curvePlacement=curvePlacement(t);t.curveFacing=curveFacing(t);t.curveRadius=Math.max(0,Number(t.curveRadius)||0);if(!t.boxW)t.boxW=220;if(!t.boxH||t.boxH<t.boxW*.7)t.boxH=Math.max(Math.min(4000,t.boxW),t.boxH||0);}renderTextControls();requestPreview();}
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
 $('dd-bw').addEventListener('change',e=>{const layer=activeImageLayer(state.queue[state.selected]);if(layer&&!layer.locked)imageAdjustments(layer).mode=e.target.value;requestPreview();});
 $('dd-adjust-reset').onclick=()=>{const layer=activeImageLayer(state.queue[state.selected]);if(!layer||layer.locked)return;layer.adjustments={...ADJUST_DEFAULTS};setImagePanel(layer);requestPreview();};
}
function renderTextListOnly(){const sel=state.textSelectedId;const entries=state.queue[state.selected]?.texts||[];const root=$('dd-textlist');root.replaceChildren();entries.forEach((t,i)=>{const b=document.createElement('button');b.type='button';b.textContent=`${i+1}: `+t.text.replace(/\s+/g,' ').slice(0,22);b.setAttribute('aria-pressed',t.id===sel?'true':'false');b.disabled=!!t.locked;b.onclick=()=>{if(t.locked)return;state.textSelectedId=t.id;renderTextControls();requestPreview();};root.append(b);});}
// Compact viewport zoom scales ONLY the canvas presentation, never the printed label.
for(const [id,direction] of [['dd-viewzoom-plus',1],['dd-viewzoom-minus',-1]]){
 $(id).addEventListener('click',()=>{state.viewZoom=Math.max(.2,Math.min(2.5,state.viewZoom+direction*.1));$('dd-viewzoom').value=String(Math.round(state.viewZoom*100));setPreviewZoomUi();requestPreview();});
}
$('dd-add-layer').addEventListener('click',()=>{if(state.queue[state.selected])$('dd-layer-files').click();else message('Zuerst ein Etikett erstellen oder eine Datei normal importieren.',true);});
$('dd-layer-files').addEventListener('change',e=>{const f=[...e.target.files];e.target.value='';addFiles(f,true);});
$('dd-crop-image').addEventListener('click',()=>{const layer=activeImageLayer(state.queue[state.selected]);if(layer)openCropEditor(layer);});

$('dd-picker').addEventListener('click',e=>{e.stopPropagation();$('dd-files').click()});
$('dd-drop').addEventListener('click',e=>{if(e.target.id!=='dd-picker')$('dd-files').click()});
$('dd-drop').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('dd-files').click()}});
$('dd-drop').addEventListener('dragover',e=>{e.preventDefault();$('dd-drop').classList.add('drag')});
$('dd-drop').addEventListener('dragleave',()=>{$('dd-drop').classList.remove('drag')});
$('dd-drop').addEventListener('drop',e=>{e.preventDefault();$('dd-drop').classList.remove('drag');addFiles(e.dataTransfer.files)});
$('dd-files').addEventListener('change',e=>{const files=Array.from(e.target.files);e.target.value='';addFiles(files)});
$('dd-clear').addEventListener('click',()=>{if(isBusy())return;beginHistory('Warteschlange leeren'); state.queue.forEach(revokeEntry); state.queue.length=0; state.selected=-1; state.textSelectedId=null;state.activeImageId="image"; showQueue(); renderTextControls(); showPreview(); $('dd-progress').value=0; commitHistory();message('Warteschlange geleert.')});
$('dd-print').addEventListener('click',printAll); $('dd-stop').addEventListener('click',()=>{state.stop=true; message('Stopp angefordert. Das laufende Etikett wird noch beendet.')});
$('dd-fit').addEventListener('change',()=>doReset($('dd-fit').value));

$('dd-copies').addEventListener('change',showQueue);
$('dd-viewzoom').addEventListener('input',e=>{state.viewZoom=Math.max(.2,Math.min(2.5,Number(e.target.value||100)/100));setPreviewZoomUi();requestPreview();});
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
const editorCanvas=$('dd-editor');editorCanvas.addEventListener('pointerdown',startGesture);editorCanvas.addEventListener('pointermove',moveGesture);editorCanvas.addEventListener('pointerup',endGesture);editorCanvas.addEventListener('pointercancel',endGesture);editorCanvas.addEventListener('lostpointercapture',endGesture);
window.addEventListener('resize',requestPreview);
setInterval(()=>{if(loaded()&&!isBusy())handleSizeChange();},1100);

/* V13 user interface: existing original control nodes are moved, never cloned.
   Original Bluetooth listeners, roll storage, printer, and event handlers are preserved. */
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
 const printer=make('header','dd-printerbar'); printer.id='dd-printerbar';
 const brand=make('div','dd-printerbar-head');brand.innerHTML='<strong>🏷️ Niimbot Druckstudio <small style="font-weight:500;color:#5c7698">V15</small></strong><span style="font-size:.74rem;color:#637c99">iPhone / Web Bluetooth</span>';
 printer.appendChild(brand);
 const selects=make('div','dd-printer-controls');
 for(const [id,name] of [['model','Drucker'],['size','Etikett'],['density','Dichte']]){const control=labelOf(id);if(control){if(control.tagName==='LABEL'&&control.firstChild?.nodeType===3)control.firstChild.textContent=name+': ';selects.appendChild(control);}}
 printer.appendChild(selects);
 const actions=make('div','dd-printer-actions');
 for(const id of ['identify','disconnect']){const btn=$(id);if(btn){btn.textContent=id==='identify'?'🔗 Drucker verbinden':'Trennen';actions.appendChild(btn);}}
 printer.appendChild(actions);
 if($('status')){const status=make('div','dd-printer-info'); moved($('status'),status);printer.appendChild(status);}
 if($('dd-blehint'))moved($('dd-blehint'),printer);
 root.insertBefore(printer,root.firstChild);
 const oldTitle=root.querySelector(':scope > h2');if(oldTitle)oldTitle.remove();
 const oldDescription=root.querySelector(':scope > p.dd-muted');if(oldDescription)oldDescription.remove();
 const workspace=make('div','dd-workspace');workspace.id='dd-workspace';root.appendChild(workspace);
 const preview=make('section','dd-preview-area');preview.id='dd-preview-area';preview.setAttribute('aria-label','Ständige Druckvorschau');
 const previewHead=make('div','dd-preview-head');previewHead.appendChild(make('span','dd-preview-name','Vorschau'));
 const outerButton=make('button','dd-mobile-action','Außen zeigen');outerButton.type='button';outerButton.id='dd-preview-overflow-toggle';outerButton.title='Elemente außerhalb des Druckbereichs ein- oder ausblenden';outerButton.onclick=()=>{state.showOutsideBounds=!state.showOutsideBounds;updateTemplateUiState();requestPreview();};previewHead.appendChild(outerButton);
 if($('dd-undo'))moved($('dd-undo').closest('.dd-historybar'),previewHead);
 preview.appendChild(previewHead);
 moved($('dd-preview-title'),preview);
 moved($('dd-editor')?.closest('.dd-editorstage'),preview);
 workspace.appendChild(preview);
 const tools=make('section','dd-toolshell');tools.id='dd-toolshell';tools.setAttribute('aria-label','Bearbeitungswerkzeuge');
 const grip=make('div','dd-gripbar');grip.id='dd-gripbar';grip.setAttribute('role','separator');grip.setAttribute('aria-label','Höhe der Werkzeugleiste verschieben');grip.setAttribute('aria-orientation','horizontal');
 const indicator=make('span','dd-draghandle');grip.appendChild(indicator);
 const sizes=make('div','dd-toolsizes');
 for(const [label,size] of [['Klein',174],['Mittel',290],['Groß',470]]){
   const b=make('button','',label);b.type='button';b.title='Werkzeugbereich '+label.toLowerCase();b.addEventListener('click',()=>setPanelHeight(size));sizes.appendChild(b);
 }
 grip.appendChild(sizes);tools.appendChild(grip);
 const tabs=make('div','dd-tabstrip');tabs.id='dd-tabstrip';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Bearbeitungsbereiche');tools.appendChild(tabs);
 const contents=make('div','dd-tabcontent');contents.id='dd-tabcontent';contents.setAttribute('role','tabpanel');tools.appendChild(contents);workspace.appendChild(tools);
 const tabDefinitions=[['dateien','📁 Dateien'],['vorlagen','💾 Vorlagen'],['text','✏️ Text'],['rund','◠ Rundtext'],['bild','🎛️ Bild'],['align','⌖ Ausrichten'],['ebenen','▤ Ebenen'],['fonts','Aa Fonts']];
 const pages=new Map();
 for(const [key,label] of tabDefinitions){
   const page=make('div','dd-tab-page');page.id='dd-panel-'+key;page.setAttribute('role','tabpanel');page.setAttribute('aria-labelledby','dd-tab-'+key);page.dataset.tab=key;page.hidden=true;pages.set(key,page);contents.appendChild(page);
   const button=make('button','',label);button.type='button';button.dataset.tab=key;button.id='dd-tab-'+key;button.setAttribute('role','tab');button.setAttribute('aria-controls','dd-panel-'+key);button.tabIndex=-1;button.setAttribute('aria-selected','false');
   button.addEventListener('click',()=>switchTab(key));tabs.appendChild(button);
 }
 tabs.addEventListener('keydown',e=>{const buttons=[...tabs.querySelectorAll('button')],i=buttons.indexOf(e.target);if(i<0)return;const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:e.key==='ArrowRight'?(i+1)%buttons.length:e.key==='ArrowLeft'?(i+buttons.length-1)%buttons.length:-1;if(next<0)return;e.preventDefault();switchTab(buttons[next].dataset.tab);buttons[next].focus();});
 let selectedTab='dateien';
 function switchTab(key){
   if(!pages.has(key))return;selectedTab=key;
   for(const [name,page] of pages){page.hidden=(name!==key);}
   contents.scrollTop=0;
   for(const b of tabs.querySelectorAll('button')){b.setAttribute('aria-selected',b.dataset.tab===key?'true':'false');b.tabIndex=b.dataset.tab===key?0:-1;}
   const active=tabs.querySelector('[aria-selected="true"]');if(active){const left=active.offsetLeft+active.offsetWidth/2-tabs.clientWidth/2;tabs.scrollLeft=Math.max(0,left);}
   try{sessionStorage.setItem('niimbot-v13:tab',key);}catch(e){}
   requestAnimationFrame(()=>requestPreview());
 }
 window.NiimbotStudioUI={selectTab:switchTab,get selectedTab(){return selectedTab;}};
 // Files: import controls and label queue.
 const files=pages.get('dateien');files.appendChild(make('p','dd-tab-lead','Bilder / PDFs importieren'));
 moved($('dd-drop'),files);moved($('dd-files'),files);
 moved(rowOf('dd-import-mode'),files);
 moved(rowOf('dd-importdpi'),files);
 const sourceToolbar=toolbarOf('dd-clear');
 if(sourceToolbar)moved(sourceToolbar,files);
 moved($('dd-queue'),files);
 if($('dd-clear'))$('dd-clear').textContent='🗑️ Warteschlange leeren';
 const templates=pages.get('vorlagen');templates.appendChild(make('p','dd-tab-lead','Etiketten speichern · wiederverwenden · in anderer Größe drucken'));
 const currentInfo=make('p','dd-muted');currentInfo.id='dd-template-current';templates.appendChild(currentInfo);
 const nameLine=make('div','dd-row');nameLine.innerHTML='<label>Vorlagenname<input id="dd-template-name" type="text" placeholder="Mein Etikett"></label><label>Ordner<input id="dd-template-folder" type="text" value="Meine Vorlagen"></label>';templates.appendChild(nameLine);
 const toolbar=make('div','dd-toolbar');toolbar.innerHTML='<button id="dd-template-save-browser" type="button" class="primary">💾 Speichern</button><button id="dd-template-save-as" type="button">Speichern unter …</button><button id="dd-template-export-file" type="button">↓ Als Datei</button><button id="dd-template-import-btn" type="button">↑ Datei öffnen</button><input id="dd-template-import-file" type="file" accept=".json,.niimbot-label.json,application/json" hidden>';templates.appendChild(toolbar);
 const searchLine=make('div','dd-row');searchLine.innerHTML='<label>Vorlagen durchsuchen<input id="dd-template-search" type="search" placeholder="Name oder Ordner suchen"></label>';templates.appendChild(searchLine);
 const note=make('div','dd-muted');note.textContent='Gespeicherte Vorlagen bleiben auf dieser Website im Browser (IndexedDB) erhalten. Andere Browserprofile oder Website-Domains haben einen getrennten Speicher; Pfade derselben Domain teilen ihn. Für Gerätewechsel als Datei exportieren.';templates.appendChild(note);
 const templateList=make('div','dd-template-gallery');templateList.id='dd-template-list';templates.appendChild(templateList);
 // Image: only image-specific sliders and grayscale settings.
 const image=pages.get('bild');image.appendChild(make('p','dd-tab-lead','Ausgewähltes Bild bearbeiten'));
 moved($('dd-active-image'),image);
 moved(rowOf('dd-bw'),image);
 moved($('dd-image-panel'),image);
 // Text: core text editor with its untouched inputs and formatting callbacks.
 const text=pages.get('text');text.appendChild(make('p','dd-tab-lead','Text einfügen und formatieren'));
 const textPanel=$('dd-text-panel');const textCtrls=$('dd-text-controls');
 if(textPanel){
   moved(textPanel.querySelector('h3'),text);
   moved(toolbarOf('dd-add-text'),text);
   moved($('dd-textlist'),text);
 }
 const textMain=make('div','dd-text-main');text.appendChild(textMain);
 if(textCtrls){
   // Transfer the groups except arc controls & layer-only controls to Text.
   const curveTitle=$('dd-flow-horizontal')?.closest('.dd-flow-buttons')?.previousElementSibling;
   const flowButtons=$('dd-flow-horizontal')?.closest('.dd-flow-buttons');
   const curveBlock=$('dd-curve-controls');
   const layerButtons=toolbarOf('dd-select-image');
   const layerList=$('dd-layers');
   const layerCaption=layerList?.previousElementSibling;
   const arc=pages.get('rund');arc.appendChild(make('p','dd-tab-lead','Gerader, vertikaler oder runder Text'));
   if(curveTitle)moved(curveTitle,arc);
   if(flowButtons)moved(flowButtons,arc);
   if(curveBlock)moved(curveBlock,arc);
   // Remaining form nodes go to Text, preserving their existing id/event bindings.
   while(textCtrls.firstChild){
     const node=textCtrls.firstChild;
     if(node===layerButtons||node===layerCaption||node===layerList){node.remove();continue;}
     textMain.appendChild(node);
   }
   const layers=pages.get('ebenen');layers.appendChild(make('p','dd-tab-lead','Bilder und Texte · vorne / hinten / sperren'));
   if(layerButtons)moved(layerButtons,layers);
   if(layerCaption)moved(layerCaption,layers);
   if(layerList)moved(layerList,layers);
   textCtrls.appendChild(textMain);moved(textCtrls,text);
 }
 // Fonts use the original details node, without changing IndexedDB storage.
 const fonts=pages.get('fonts');fonts.appendChild(make('p','dd-tab-lead','Schriftarten wählen und lokal speichern'));
 if($('dd-font')){
   const fontRow=rowOf('dd-font');
   // Don't clone native select (the Text tab retains selection). Shortcut switches to Text tab.
   const shortcut=make('button','dd-mobile-action','Schrift im Text-Tab auswählen ↗');shortcut.type='button';shortcut.onclick=()=>switchTab('text');fonts.appendChild(shortcut);
 }
 const customFonts=$('dd-fontfile')?.closest('details');if(customFonts){customFonts.open=true;moved(customFonts,fonts);}
 // Align and rotate also apply to the active text/image selection.
 const align=pages.get('align');align.appendChild(make('p','dd-tab-lead','Position, Drehung und Größe'));
 moved(panelOf('dd-rotation'),align);
 const labelPanel=make('div','dd-panel');labelPanel.innerHTML='<h3>Etikett / Druckbereich</h3><div class="dd-toolbar"><button id="dd-rotate-label" type="button">↻ Roten Druckrahmen 90° drehen</button><span id="dd-label-rotation-status" class="dd-muted">0° Querformat</span></div><label class="dd-check"><input id="dd-show-outside-check" type="checkbox"> Alle Ebenen außerhalb der roten Markierung anzeigen</label><p class="dd-muted">Die rote gestrichelte Markierung ist der einzige bedruckte Bereich. Bilder und Text außerhalb bleiben beim Bearbeiten sichtbar, werden aber abgeschnitten.</p>';align.appendChild(labelPanel);
 const alignZoom=make('div','dd-row');moved(labelOf('dd-zoom'),alignZoom);align.appendChild(alignZoom);
 moved(rowOf('dd-align-left'),align);
 moved(toolbarOf('dd-text-tofront'),pages.get('ebenen'));// possibly already transferred
 const zoomQuick=make('div','dd-toolbar');
 for(const id of ['dd-fit-reset','dd-cover-reset','dd-zoom-apply']) if($(id))moved($(id),zoomQuick);
 align.appendChild(zoomQuick);
 // The crop buttons, independent image layers & hints.
 const layers=pages.get('ebenen');moved($('dd-add-layer')?.closest('.dd-layer-files'),layers);
 moved(root.querySelector(':scope > .dd-layer-hint'),layers);
 // If a layer list was detached from the previous parent, restore it explicitly.
 if($('dd-layers')&&!layers.contains($('dd-layers')))moved($('dd-layers'),layers);
 // The short global status and bottom dock.
 const dock=make('footer','dd-globaldock');dock.id='dd-globaldock';
 const dockMain=make('div','dd-dockmain');
 const save=make('button','dd-docksave','💾 Speichern');save.id='dd-dock-save';save.type='button';save.onclick=()=>switchTab('vorlagen');dockMain.appendChild(save);
 const print=$('dd-print');if(print){print.classList.add('dd-dockprint');print.textContent='🖨️ Drucken';moved(print,dockMain);}
 const rolls=make('button','dd-dockrolls','🏷 Rollen');rolls.id='dd-dockrolls';rolls.type='button';rolls.setAttribute('aria-expanded','false');dockMain.appendChild(rolls);
 const more=make('button','dd-dockjobs','⋯');more.id='dd-dockjobs';more.type='button';more.title='Aufträge und Druckstatus';more.setAttribute('aria-expanded','false');dockMain.appendChild(more);
 dock.appendChild(dockMain);
 const dockMeta=make('div','dd-dockmeta');moved($('dd-count'),dockMeta);moved($('dd-progress'),dockMeta);moved($('dd-state'),dockMeta);dock.appendChild(dockMeta);
 const drawer=make('div','dd-dockdrawer');drawer.id='dd-dockdrawer';drawer.hidden=true;
 const printSettings=make('section','dd-docksettings');
 printSettings.appendChild(make('p','dd-tab-lead','Druckauftrag'));
 const copiesLabel=labelOf('dd-copies');if(copiesLabel)moved(copiesLabel,printSettings);
 const stop=moved($('dd-stop'),dockMain);stop.classList.add('dd-dockstop');
 const statusButton=$('readstatus');if(statusButton){statusButton.textContent='Druckerstatus lesen';statusButton.style.display='inline-flex';moved(statusButton,printSettings);}
 const warn=root.querySelector(':scope > .dd-warning');if(warn)moved(warn,printSettings);
 const rollbox=$('rollbox');if(rollbox)moved(rollbox,drawer);
 const logbox=$('logbox');if(logbox)moved(logbox,drawer);
 drawer.appendChild(printSettings);dock.appendChild(drawer);root.appendChild(dock);
 function drawerOpen(kind){
   const show=drawer.hidden||drawer.dataset.view!==kind;
   drawer.hidden=!show;drawer.dataset.view=show?kind:'';
   rolls.setAttribute('aria-expanded',show&&kind==='rolls'?'true':'false');
   more.setAttribute('aria-expanded',show&&kind==='more'?'true':'false');
   if(rollbox){rollbox.style.display=(!show||kind==='rolls')?'':'none';if(show&&kind==='rolls')rollbox.open=true;}
   if(logbox)logbox.style.display=(show&&kind==='more')?'':'none';
   printSettings.style.display=(show&&kind==='more')?'':'none';
 }
 rolls.onclick=()=>drawerOpen('rolls');more.onclick=()=>drawerOpen('more');
 // Resizing the bottom tool drawer changes its height, while preview stays visible.
 let panelPx=0;
 function limits(){
   const total=workspace.clientHeight||550;
   const max=Math.max(158,total-155);
   return {min:Math.min(158,max),max};
 }
 function setPanelHeight(px,persist=true){
   const {min,max}=limits();panelPx=Math.min(max,Math.max(min,Math.round(px)));
   tools.style.flexBasis=panelPx+'px';tools.style.height=panelPx+'px';
   grip.setAttribute('aria-valuenow',String(panelPx));
   if(persist){try{localStorage.setItem('niimbot-v13:panel-height',String(panelPx));}catch(e){}}
   requestAnimationFrame(()=>requestPreview());
 }
 window.NiimbotStudioUI.setPanelHeight=setPanelHeight;
 grip.setAttribute('aria-valuemin','158');grip.setAttribute('aria-valuemax','500');
 let drag=null;
 grip.addEventListener('pointerdown',e=>{
   if(e.target.closest('button'))return;
   drag={pointerId:e.pointerId,y:e.clientY,height:tools.getBoundingClientRect().height};
   grip.setPointerCapture(e.pointerId);
 });
 grip.addEventListener('pointermove',e=>{
   if(!drag||drag.pointerId!==e.pointerId)return;
   setPanelHeight(drag.height+(drag.y-e.clientY),false);
 });
 const endDrag=e=>{
   if(!drag||drag.pointerId!==e.pointerId)return;
   drag=null;setPanelHeight(tools.getBoundingClientRect().height,true);
 };
 grip.addEventListener('pointerup',endDrag);grip.addEventListener('pointercancel',endDrag);
 grip.addEventListener('keydown',e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();setPanelHeight(panelPx+(e.key==='ArrowUp'?25:-25));}});
 grip.tabIndex=0;
 window.addEventListener('resize',()=>{
   setPanelHeight(panelPx||260,false);
 });
 let initialHeight=270;
 try{initialHeight=Number(localStorage.getItem('niimbot-v13:panel-height'))||270;}catch(e){}
 setPanelHeight(initialHeight,false);
 try{selectedTab=sessionStorage.getItem('niimbot-v13:tab')||'dateien';}catch(e){}
 switchTab(pages.has(selectedTab)?selectedTab:'dateien');
 $('dd-template-save-browser').onclick=async()=>{try{await saveCurrentTemplateToBrowser();}catch(e){message('Vorlage konnte nicht gespeichert werden: '+(e.message||e),true);}};
 $('dd-template-save-as').onclick=async()=>{try{await saveCurrentTemplateToBrowser({saveAs:true});}catch(e){message('Speichern unter fehlgeschlagen: '+(e.message||e),true);}};
 $('dd-template-export-file').onclick=()=>exportCurrentTemplateFile().catch(e=>message('Export fehlgeschlagen: '+(e.message||e),true));
 $('dd-template-import-btn').onclick=()=>$('dd-template-import-file').click();
 $('dd-template-import-file').onchange=async event=>{const file=event.target.files?.[0];if(!file)return;try{await importTemplateFile(file);}catch(e){message('Vorlage konnte nicht importiert werden: '+(e.message||e),true);}event.target.value='';};
 $('dd-template-search').oninput=renderTemplateLibrary;
 for(const [id,key] of [['dd-template-name','templateName'],['dd-template-folder','templateFolder']])$(id).addEventListener('input',()=>{const entry=state.queue[state.selected];if(entry)entry[key]=$(id).value;});
 $('dd-rotate-label').onclick=toggleLabelRotation;
 $('dd-show-outside-check').onchange=e=>{state.showOutsideBounds=!!e.target.checked;updateTemplateUiState();requestPreview();};
 renderTemplateLibrary();
 // Remove exhausted source wrappers and relocate the guidance below the relevant tool tab.
 for(const child of [...root.children]){
   if(child===printer||child===workspace||child===dock)continue;
   if(child.classList.contains('dd-muted'))moved(child,pages.get('dateien'));
   else if(child.id==='dd-text-panel'||(child.classList.contains('dd-row')&&!child.querySelector('input,select,textarea,button')))child.remove();
 }
 if(cropDialog){cropDialog.style.zIndex='1500';}
}

setupTabbedLayout();
if(window.ResizeObserver)new ResizeObserver(requestPreview).observe($('dd-editorwrap'));
function syncViewport(){document.documentElement.style.setProperty('--studio-height',(window.visualViewport?.height||window.innerHeight)+'px');requestPreview();}
window.visualViewport?.addEventListener('resize',syncViewport);syncViewport();
loadTemplateStore();
wireTextEditor();wireAdditionalControls();renderFonts();renderTextControls();setImagePanel(null);setPreviewZoomUi();updateEditorViewport(null);updateHistoryControls();
(async()=>{
  await loadSavedFonts();
  try{ bluetoothHint(); for(let t=0;t<150 && !loaded();t++)await sleep(100); if(!loaded())throw Error('Druckermodelle wurden nicht geladen. Vollständigen vendor-Ordner und Website-Verbindung prüfen.'); await upstreamRegistry(); committedSettings=readSettings();showQueue(); await showPreview(); message('Bereit. Drucker oben verbinden, Rolle wählen und PDF/Bild hinzufügen. Text und Rotation sind in der Vorschau bearbeitbar.'); }
  catch(e){ message('Initialisierung: '+(e.message||e)+'\nDrucker-/Rollen-Auswahl fehlt? Webseite neu laden und Internetverbindung prüfen.',true); }
})();
