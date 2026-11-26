const $ = id => document.getElementById(id);
const stage = $('stage'), image = $('image'), box = $('box'), status = $('status');
let history = [], index = -1, selection = null, start = null, selecting = false, busy = false;
function controls() {
  const ready = index >= 0 && !busy;
  for (const id of ['select','replace']) $(id).disabled = !ready;
  for (const id of ['ai','erase','overlay']) $(id).disabled = !ready || !selection;
  $('undo').disabled = !ready || index <= 0;
  $('redo').disabled = !ready || index >= history.length - 1;
  $('download').href = ready ? history[index] : '#';
}
function show(url, append) {
  if (append) { history = history.slice(0, index + 1); history.push(url); index++; }
  image.src = url; stage.classList.add('has-image'); selection = null; box.style.display = 'none'; selecting = false; stage.classList.remove('selecting'); controls();
}
$('upload').onchange = e => { const file = e.target.files[0]; if (file) { history = []; index = -1; show(URL.createObjectURL(file), true); status.textContent = '图片已加载，点击“框选修改”后拖动鼠标'; } };
$('select').onclick = () => { selecting = true; stage.classList.add('selecting'); status.textContent = '请在图片上拖动，选择需要修改的区域'; };
function point(e) { const r=stage.getBoundingClientRect(); return {x: Math.max(0, Math.min(r.width,e.clientX-r.left)), y:Math.max(0,Math.min(r.height,e.clientY-r.top))}; }
stage.onpointerdown = e => { if (!selecting) return; start=point(e); stage.setPointerCapture(e.pointerId); box.style.display='block'; };
stage.onpointermove = e => { if (!start) return; const p=point(e), x=Math.min(start.x,p.x), y=Math.min(start.y,p.y), w=Math.abs(start.x-p.x), h=Math.abs(start.y-p.y); selection={x:x/stage.clientWidth*image.naturalWidth,y:y/stage.clientHeight*image.naturalHeight,width:w/stage.clientWidth*image.naturalWidth,height:h/stage.clientHeight*image.naturalHeight,imageWidth:image.naturalWidth,imageHeight:image.naturalHeight}; Object.assign(box.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'}); };
stage.onpointerup = () => { if (!start) return; start=null; if (!selection || selection.width < 2 || selection.height < 2) {selection=null; box.style.display='none';} selecting=false; stage.classList.remove('selecting'); controls(); };
async function run(operation, patch) { if (busy) return; busy=true; controls(); status.textContent='正在处理，请稍候…'; try { const data=new FormData(); data.append('image',await (await fetch(history[index])).blob(),'image.png'); data.append('operation',operation); if(selection) data.append('selection',JSON.stringify(selection)); if(patch) data.append('patch',patch); data.append('instruction',$('instruction').value); const response=await fetch('/api/edit',{method:'POST',body:data}); if(!response.ok){ const error=await response.json(); throw new Error(error.error || '处理失败'); } show(URL.createObjectURL(await response.blob()),true); status.textContent='修改完成'; } catch(e){status.textContent=e.message;} finally {busy=false; controls();} }
$('ai').onclick=()=>run('ai_region_edit'); $('erase').onclick=()=>run('erase_region');
$('overlay').onchange=e=>{if(e.target.files[0])run('region_overlay',e.target.files[0]);e.target.value='';}; $('replace').onchange=e=>{if(e.target.files[0])run('replace_full',e.target.files[0]);e.target.value='';};
$('undo').onclick=()=>{if(index>0){index--;show(history[index],false);}}; $('redo').onclick=()=>{if(index<history.length-1){index++;show(history[index],false);}};
