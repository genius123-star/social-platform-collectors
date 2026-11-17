const db=instagramData,$=id=>document.getElementById(id),statusBox=$('status');
const selected=async()=>await db.get(db.PREFIX+$('runs').value) || await db.get(db.STATE);
async function showRun() {
  const all=await chrome.storage.local.get(null),previous=$('runs').value;
  const runs=Object.entries(all).filter(([k])=>k.startsWith(db.PREFIX)).map(([,r])=>r);
  const legacy=all[db.STATE];if(legacy && !runs.some(r=>r.run_id===legacy.run_id)) runs.push(legacy);
  $('runs').replaceChildren();
  for(const r of runs.sort((a,b)=>b.started_at.localeCompare(a.started_at))) {
    const option=document.createElement('option');option.value=r.run_id;
    option.textContent=`${r.username} · ${r.started_at} · ${r.done.length}帖 · ${r.status}`;$('runs').append(option);
  }
  if(runs.some(r=>r.run_id===previous)) $('runs').value=previous;
  const run=await selected(),c=run?.checkpoint;
  $('run-status').textContent=run ? `${run.username} · ${run.run_id}\n${run.mode==='formal'?'正式':'试采'} · ${run.status} · 保存 ${run.done.length}帖\n阶段 ${run.phase} · 最近进展 ${run.last_progress_at || run.heartbeat_at}\n停止原因 ${run.stop_reason || '无'}\n跳过 ${Object.keys(run.skipped || {}).length} · 延后 ${run.deferred.filter(code=>!run.skipped?.[code]).length} · 滚动 ${run.scrolls_used} · 展开 ${run.expansions_used}\n断点 ${c?.published_at || '日期待核验'}\n${c?.summary || ''}\n${c?.url || ''}\n${run.coverage_limitation || '历史覆盖尚未确认'}`:'尚无任务';
  $('capacity').textContent=`存储 ${(await chrome.storage.local.getBytesInUse(null)/1000000).toFixed(1)} / 200 MB；到达上限停止保存。`;
}
async function startAuto(mode) {
  const username=$('account').value,[tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const u=new URL(tab?.url || 'about:blank');
  if(u.protocol!=='https:' || !['www.instagram.com','instagram.com'].includes(u.hostname)) throw Error('请打开Instagram账号主页');
  const run=mode===true || mode==='next' || mode==='comments'?await selected():null;
  if((mode===true || mode==='next') && !run) throw Error('尚无可恢复任务');
  if(run && run.username!==username) throw Error('所选任务与账号不同');
  if(run?.status==='running' && Date.now()-Date.parse(run.heartbeat_at)<30000) throw Error('任务仍在运行，请先暂停');
  const checkpointCode=u.pathname.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/)?.[1];
  if(u.pathname.replace(/\/$/,'')!=='/'+username && !(mode===true && checkpointCode && checkpointCode===run?.current_code)) {
    if(mode!==true) throw Error('请先打开所选账号主页');
    await chrome.storage.local.set({instagram_auto_v1_stop_request:''});
    const result=await chrome.runtime.sendMessage({type:'ig_resume',run_id:run.run_id,tab_id:tab.id});
    if(!result?.ok) throw Error(result?.error || '恢复请求失败');
    statusBox.textContent='已请求返回任务主页并恢复；重新加载历史列表可能需要时间。';return;
  }
  const [{result:existing}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{
    const collector=globalThis.instagramAutoCollector;
    return collector?{version:collector.version,state:collector.status?.()}:null;
  }});
  if(existing && existing.version!=='0.4.2' && !(['0.4.0','0.4.1'].includes(existing.version) && existing.state?.loop_active===false && existing.state.status!=='running')) {
    throw Error('网页旧版采集器尚未确认停止，请先暂停；必要时导出证据再刷新Instagram网页，不要移除扩展');
  }
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['data.js','page_reader.js','collector.js']});
  await chrome.scripting.executeScript({target:{tabId:tab.id},args:[username,mode,run?.run_id || ''],func:(n,m,id)=>instagramAutoCollector.start(n,m,id)});
  $('runs').value='';await showRun();statusBox.textContent='已启动；可关闭弹窗。隐藏或冻结时不保证页面加载。';
}
async function stopAuto(disarm=true) {
  const run=await selected();if(!run) throw Error('尚无任务');
  if((await db.get(db.STATE))?.run_id!==run.run_id) throw Error('所选任务不是活动任务');
  await chrome.storage.local.set({instagram_auto_v1_stop_request:run.run_id});
  if(disarm) await chrome.runtime.sendMessage({type:'ig_disarm',run_id:run.run_id});
  statusBox.textContent='已请求暂停并保留断点；停止同时解除自动恢复。';await showRun();
}
async function capture() {
  const run=await db.get(db.STATE);
  if(run?.status==='running' && Date.now()-Date.parse(run.heartbeat_at)<30000) throw Error('请先暂停');
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!/^https:\/\/(www\.)?instagram\.com\//.test(tab?.url || '')) throw Error('请打开Instagram');
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['page_reader.js']});
  const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},args:[$('account').value],func:n=>readInstagramPage(n)});
  await db.saveSnapshot(result);statusBox.textContent='已保存手动证据；通过旧证据入口导出。';await showRun();
}
function download(rows,filename,columns) {
  if(!rows.length && !columns) return;
  columns ||= [...new Set(rows.flatMap(r=>Object.keys(r)))];
  const cell=v=>'"'+String(v ?? '').replaceAll('"','""')+'"';
  const raw=columns.includes('snapshot_json'),safe=v=>typeof v==='string' && /^[\s]*[=+\-@]/.test(v)?"'"+v:v;
  const csv='\uFEFF'+[columns,...rows.map(r=>columns.map(c=>raw?r[c]:safe(r[c])))].map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n';
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');
  a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function exportCsv(legacy=false) {
  const run=legacy?null:await selected();
  if(!legacy && (!run || run.username!==$('account').value)) throw Error('请选择对应账号任务');
  const rows=await db.snapshots(run?.run_id || '',$('account').value);
  if(!rows.length) throw Error('没有对应证据');
  const columns=['schema','username','page_url','collected_at_utc','snapshot_json'];
  let chunk=[],bytes=0,part=1;
  const emit=()=>{download(chunk,`instagram_${$('account').value}_${run?.run_id || 'legacy'}_part${part++}.csv`,columns);chunk=[];bytes=0;};
  rows.forEach((s,i)=>{
    const snapshot=i===rows.length-1 && run?{...s,run_state_at_export:run}:s;
    const row={schema:s.schema,username:s.username,page_url:s.page_url,collected_at_utc:s.collected_at_utc,snapshot_json:JSON.stringify(snapshot)};
    const size=new TextEncoder().encode(row.snapshot_json.replaceAll('"','""')).length+1000;
    if(size>19000000) throw Error('单条证据及任务元数据超过19MB，请先导出诊断并保留本机数据');
    if(chunk.length && (chunk.length>=200 || bytes+size>15000000)) emit();
    chunk.push(row);bytes+=size;
  });if(chunk.length) emit();
  statusBox.textContent='已请求分段导出，请确认全部下载完成；本机证据保留。';
}
async function exportTable(kind) {
  const run=await selected();if(!run || run.username!==$('account').value) throw Error('请选择对应账号任务');
  const rows=await db.snapshots(run.run_id,run.username),tables=db.tables(rows);
  const title={profiles:'账号资料',posts:'帖子',comments:'有ID评论',comment_observations:'评论观察',report:'运行报告'}[kind];
  const labels={run_id:'任务编号',username:'账号',content_id:'帖子短码',content_url:'帖子链接',identity_status:'身份核验',created_at_utc:'时间UTC',
    created_at_bjt:'发布时间北京时间',period_status:'研究期间分类',caption:'正文',caption_status:'正文状态',content_type:'内容类型',like_count:'点赞数',
    like_count_raw:'点赞原值',comment_count:'平台评论总数',share_count:'分享数',repost_count:'转发数',favorite_count:'收藏数',view_count:'浏览数',play_count:'播放数',
    comments_coverage:'评论覆盖状态',comments_complete:'评论完整',replies_complete:'回复完整',collected_at_utc:'采集时间UTC',comment_id:'评论ID',
    parent_comment_id:'父评论ID',author_username:'评论作者',body:'评论原文',relation_status:'关系状态',content_period_status:'所属帖子期间',
    source_locator:'证据位置',metrics_missing_reason:'指标缺失说明',profile_url:'账号主页',display_name:'显示名称',
    total_post_count_raw:'累计帖子原值',follower_count_raw:'粉丝原值',following_count_raw:'关注原值',count_precision:'数值精度'};
  const output=kind==='report'?[{账号:run.username,任务编号:run.run_id,模式:run.mode || 'test',唯一帖子:tables.posts.length,
    期间内:tables.posts.filter(p=>p.identity_status==='verified' && p.period_status==='in_range').length,
    待核验:tables.posts.filter(p=>p.period_status==='date_pending' || p.identity_status!=='verified').length,
    有ID唯一评论:tables.comments.length,评论观察:tables.comment_observations.length,停止原因:run.stop_reason,历史完整:false,
    覆盖限制:run.coverage_limitation || '未证明年度完整',断点链接:run.checkpoint?.url || '',快照:rows.length,
    跳过帖子数:Object.keys(run.skipped || {}).length,跳过记录:JSON.stringify(run.skipped || {}),延后帖子:run.deferred.filter(code=>!run.skipped?.[code]).join(' '),滚动次数:run.scrolls_used,恢复次数:run.resume_count,
    评论总数缺失:tables.posts.filter(p=>p.comment_count==='').length}]:tables[kind].map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[labels[k] || k,v])));
  download(output,`Instagram_${run.username}_${title}_${run.run_id}.csv`,output.length?null:['状态']);
  statusBox.textContent=`已请求导出${title}；评论观察可能重复，有ID表仅包含可可靠去重的评论。`;
}
async function diagnose() {
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!/^https:\/\/(www\.)?instagram\.com\//.test(tab?.url || '')) throw Error('请打开Instagram');
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['page_reader.js']});
  const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},args:[$('account').value],func:name=>{
    let fresh,running;try{fresh=readInstagramPage(name);}catch(e){fresh={error:e.message};}
    try{running=globalThis.instagramAutoCollector?.diagnose();}catch(e){running={error:e.message};}
    return {extension_version:'0.4.2',fresh,running};
  }});
  const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'})),a=document.createElement('a');
  a.href=url;a.download='instagram_diagnostic_'+new Date().toISOString().replaceAll(':','-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  statusBox.textContent='已导出读取器诊断，未启动采集或滚动。';
}
async function archive() {
  const run=await selected();
  if(!run || run.username!==$('account').value || !$('archive-confirm').checked) throw Error('先选择任务并核对全部导出文件，再勾选确认');
  if(run.status==='running') throw Error('先停止所选任务，再归档');
  await chrome.runtime.sendMessage({type:'ig_disarm',run_id:run.run_id});
  const all=await chrome.storage.local.get(null);
  const keys=Object.entries(all).filter(([k,v])=>k.startsWith('instagram_snapshot_') && v.collection?.run_id===run.run_id).map(([k])=>k);
  await chrome.storage.local.remove(keys);
  run.archived_at=new Date().toISOString();run.archived_snapshot_count=(run.archived_snapshot_count || 0)+keys.length;
  const active=await db.get(db.STATE);
  await chrome.storage.local.set({[db.PREFIX+run.run_id]:run,...(active?.run_id===run.run_id?{[db.STATE]:run}:{})});
  $('archive-confirm').checked=false;await showRun();statusBox.textContent='已清除所选任务的新格式快照；断点和旧格式证据保留，历史成果以已核对的导出文件为准。';
}
const handlers={start:()=>startAuto(false),formal:()=>startAuto('formal'),here:()=>startAuto('here'),next:()=>startAuto('next'),resume:()=>startAuto(true),
  supplement:()=>startAuto('comments'),pause:()=>stopAuto(false),stop:()=>stopAuto(true),refresh:showRun,capture,export:()=>exportCsv(),legacy:()=>exportCsv(true),
  profiles:()=>exportTable('profiles'),posts:()=>exportTable('posts'),comments:()=>exportTable('comments'),observations:()=>exportTable('comment_observations'),report:()=>exportTable('report'),diagnose,archive};
for(const [id,handler] of Object.entries(handlers)) $(id).addEventListener('click',async()=>{
  const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
  try{await handler();}catch(e){statusBox.textContent='未完成：'+e.message;}finally{buttons.forEach(b=>b.disabled=false);}
});
$('runs').addEventListener('change',showRun);showRun().catch(e=>statusBox.textContent=e.message);
