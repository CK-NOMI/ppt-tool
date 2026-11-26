const $ = id => document.getElementById(id);
const stage = $('stage'), image = $('image'), box = $('box'), status = $('status');
let history = [], index = -1, selection = null, start = null, selecting = false, busy = false;
let database;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('region-edit-history', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function saveHistory() {
  return new Promise((resolve, reject) => {
    const tx = database.transaction('state', 'readwrite');
    tx.objectStore('state').put({history: history.map(({url, ...entry}) => entry), index}, 'current');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
function controls() {
  const ready = index >= 0 && !busy;
  for (const id of ['select','replace','upload']) $(id).disabled = busy || (id !== 'upload' && !ready);
  for (const id of ['ai','erase','overlay']) $(id).disabled = !ready || !selection;
  $('undo').disabled = !ready || index <= 0;
  $('redo').disabled = !ready || index >= history.length - 1;
  $('download').href = ready ? history[index].url : '#';
  renderHistory();
}
function renderHistory() {
  const container = $('history');
  container.replaceChildren();
  [...history].reverse().forEach((entry, reverseIndex) => {
    const n = history.length - reverseIndex - 1;
    const card = document.createElement('div');
    card.className = 'version' + (n === index ? ' current' : '');
    const thumb = document.createElement('img'); thumb.src = entry.url; thumb.alt = '版本预览';
    const title = document.createElement('p'); title.textContent = `v${n + 1} · ${entry.label}`;
    const info = document.createElement('p');
    info.textContent = new Date(entry.time).toLocaleString() + (entry.duration == null ? '' : ` · 耗时 ${(entry.duration / 1000).toFixed(1)} 秒`);
    const restore = document.createElement('button'); restore.textContent = n === index ? '当前版本' : '恢复'; restore.disabled = busy || n === index;
    restore.onclick = async () => { index = n; showCurrent(); await persist(); };
    const compare = document.createElement('button'); compare.textContent = '比较'; compare.disabled = busy || n === index;
    compare.onclick = () => { $('compare-old').src = entry.url; $('compare-current').src = history[index].url; $('comparison').showModal(); };
    card.append(thumb, title, info, restore, compare); container.append(card);
  });
}
$('close-compare').onclick = () => $('comparison').close();
async function persist() {
  try { await saveHistory(); } catch { status.textContent = '版本保存失败，请检查浏览器存储空间'; }
}
function showCurrent() {
  image.src = history[index].url; stage.classList.add('has-image'); selection = null;
  box.style.display = 'none'; selecting = false; stage.classList.remove('selecting'); controls();
}
async function addVersion(blob, label, duration) {
  history.push({blob, url: URL.createObjectURL(blob), label, time: Date.now(), duration});
  index = history.length - 1; showCurrent(); await persist();
}
$('upload').onchange = async e => {
  const file = e.target.files[0];
  if (file) { await addVersion(file, '上传图片', null); status.textContent = '图片已加载，点击“框选修改”后拖动鼠标'; }
  e.target.value = '';
};
$('select').onclick = () => { selecting = true; stage.classList.add('selecting'); status.textContent = '请在图片上拖动，选择需要修改的区域'; };
function point(e) { const r = stage.getBoundingClientRect(); return {x: Math.max(0, Math.min(r.width, e.clientX-r.left)), y: Math.max(0, Math.min(r.height, e.clientY-r.top))}; }
stage.onpointerdown = e => { if (!selecting) return; start = point(e); stage.setPointerCapture(e.pointerId); box.style.display = 'block'; };
stage.onpointermove = e => {
  if (!start) return;
  const p = point(e), x = Math.min(start.x,p.x), y = Math.min(start.y,p.y), w = Math.abs(start.x-p.x), h = Math.abs(start.y-p.y);
  selection = {x:x/stage.clientWidth*image.naturalWidth, y:y/stage.clientHeight*image.naturalHeight, width:w/stage.clientWidth*image.naturalWidth, height:h/stage.clientHeight*image.naturalHeight, imageWidth:image.naturalWidth, imageHeight:image.naturalHeight};
  Object.assign(box.style, {left:x+'px', top:y+'px', width:w+'px', height:h+'px'});
};
stage.onpointerup = () => { if (!start) return; start = null; if (!selection || selection.width < 2 || selection.height < 2) { selection = null; box.style.display = 'none'; } selecting = false; stage.classList.remove('selecting'); controls(); };
stage.onpointercancel = () => { start = null; selection = null; box.style.display = 'none'; selecting = false; stage.classList.remove('selecting'); controls(); };
async function run(operation, patch) {
  if (busy) return;
  busy = true; controls(); status.textContent = '正在处理，请稍候…'; const started = performance.now();
  try {
    const data = new FormData(); data.append('image', history[index].blob, 'image.png'); data.append('operation', operation);
    if (selection) data.append('selection', JSON.stringify(selection));
    if (patch) data.append('patch', patch);
    const instruction = $('instruction').value.trim(); data.append('instruction', instruction); data.append('mode', $('mode').value);
    const response = await fetch('/api/edit', {method:'POST', body:data});
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || '处理失败'); }
    const labels = {ai_region_edit:'AI 修改', erase_region:'模糊选区', region_overlay:'覆盖选区', replace_full:'整图替换'};
    const label = labels[operation] + (operation === 'ai_region_edit' ? '：' + instruction : '');
    await addVersion(await response.blob(), label, performance.now() - started); status.textContent = '修改完成';
  } catch(e) { status.textContent = e.message; } finally { busy = false; controls(); }
}
$('ai').onclick = () => run('ai_region_edit'); $('erase').onclick = () => run('erase_region');
$('overlay').onchange = e => { if (e.target.files[0]) run('region_overlay', e.target.files[0]); e.target.value = ''; };
$('replace').onchange = e => { if (e.target.files[0]) run('replace_full', e.target.files[0]); e.target.value = ''; };
$('undo').onclick = async () => { if (index > 0) { index--; showCurrent(); await persist(); } };
$('redo').onclick = async () => { if (index < history.length - 1) { index++; showCurrent(); await persist(); } };
(async () => {
  try {
    database = await openDatabase();
    const tx = database.transaction('state', 'readonly');
    const request = tx.objectStore('state').get('current');
    request.onsuccess = () => {
      const saved = request.result;
      if (saved && saved.history.length) {
        history = saved.history.map(entry => ({...entry, url: URL.createObjectURL(entry.blob)}));
        index = Math.min(saved.index, history.length - 1); showCurrent(); status.textContent = '已恢复上次的修改历史';
      } else controls();
    };
  } catch { status.textContent = '无法打开浏览器存储，请检查浏览器设置'; }
})();
