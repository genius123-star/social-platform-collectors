"use strict";
const statusNode=document.getElementById('status'),runs=document.getElementById('runs'),diagnosticStatus=document.getElementById('diagnosticStatus');
let launchPending=false,launchError='';
async function refresh(preferredRun='') {
  const all=await chrome.storage.local.get(null),selected=preferredRun||runs.value;
  const latest=Object.entries(all).filter(([key])=>key.startsWith('lp_fb_diagnostic_')).map(([,value])=>value).filter(value=>value?.metadata&&typeof value.metadata.collected_at_utc==='string').sort((a,b)=>b.metadata.collected_at_utc.localeCompare(a.metadata.collected_at_utc))[0];
  if(latest)diagnosticStatus.textContent=`最近结构诊断已保存：${latest.metadata.collected_at_utc}，${latest.metadata.node_count}个元素${latest.metadata.truncated?'，部分结构被截断':''}。与采集批次状态独立。`;
  runs.replaceChildren();
  for(const s of Object.entries(all).filter(([k])=>k.startsWith('lp_fb_run_')).map(([,v])=>v).filter(value=>value&&typeof value==='object'&&typeof value.run_id==='string'&&value.rows&&typeof value.rows==='object'&&!Array.isArray(value.rows)).sort((a,b)=>String(b.created_at_utc||'').localeCompare(String(a.created_at_utc||'')))) {
    const option=document.createElement('option');option.value=s.run_id;
    option.textContent=`${s.target?.name||Object.values(s.rows)[0]?.account_key||'旧批次'} · ${s.created_at_utc||'时间未记录'} · ${Object.keys(s.rows).length}条原始记录 / ${Object.values(s.rows).filter(row=>row.raw_detail_evidence_json).length}帖详情 · ${s.status}`;runs.append(option);
  }
  if([...runs.options].some(o=>o.value===selected))runs.value=selected;
  localPandaCheckpoint.render(document.getElementById('checkpointInfo'),all['lp_fb_run_'+runs.value]);
  if(launchPending||launchError)return; // Keep the clicked action's progress/error visible across storage updates.
  const chosen=all['lp_fb_run_'+runs.value];
  const binding=Object.entries(all).filter(([key,value])=>key.startsWith('lp_fb_supervisor_')&&value?.run_id===runs.value).map(([,value])=>value)[0];
  const stale=chosen&&['running','paused'].includes(chosen.status)&&Number.isFinite(chosen.heartbeat)&&Date.now()-chosen.heartbeat>30000;
  if(chosen?.manual_resume_status==='failed')statusNode.textContent='断点继续未启动：'+chosen.manual_resume_error+'；原批次数据保留。';
  else if(chosen?.manual_resume_status==='resuming_in_place')statusNode.textContent='保留当前主页和已加载位置，正在原地查找断点；不会刷新。';
  else if(chosen?.manual_resume_status==='returning_to_profile')statusNode.textContent='正在返回该批次目标主页，随后自动定位断点；已有数据保留，可以关闭扩展小窗。';
  else if(chosen&&binding?.enabled&&['frozen','discarded'].includes(binding.background_state))statusNode.textContent=`Chrome已${binding.background_state==='frozen'?'冻结':'停用'}采集页；原批次与位置保留，程序不会靠刷新解除该状态。请检查Chrome性能设置。`;
  else if(chosen&&binding?.enabled&&binding.phase==='returning_to_target')statusNode.textContent=`正在自动返回${binding.profile_url}目标主页并恢复原批次，已保留${Object.keys(chosen.rows).length}帖。`;
  else if(chosen&&binding&&!binding.enabled&&binding.phase!=='user_or_run_stopped')statusNode.textContent=`自动恢复已暂停：${binding.phase}；已保留${Object.keys(chosen.rows).length}帖，请检查提示后手动恢复。`;
  else if(chosen?.status==='running'&&chosen.resume_cursor)statusNode.textContent=`正在重新定位中断帖 ${chosen.resume_cursor.post_key}；原批次已保留${Object.keys(chosen.rows).length}帖，定位后继续。`;
  else if(chosen?.status==='running'&&chosen.background_feed_wait)statusNode.textContent=`后台暂未加载新帖，等待后重试；已保留${Object.keys(chosen.rows).length}帖，不会据此判定采集结束。恢复可见后会重新核验页面；停止按钮仍可使用。`;
  else if(stale&&binding?.enabled&&['running_background','running_unfocused'].includes(binding.background_state))statusNode.textContent=`后台暂未收到新心跳，未请求刷新；已保留${Object.keys(chosen.rows).length}条记录，最后步骤：${chosen.current_phase?.name||'等待页面'}。`;
  else if(stale)statusNode.textContent=`上次任务心跳已中断，可能因页面跳转或关闭；已保存${Object.keys(chosen.rows).length}帖。请返回该批次的目标主页，选择此批次恢复；原记录仍保留。`;
  else if(chosen)statusNode.textContent=['stopped','interrupted'].includes(chosen.status)
    ? `所选采集批次已停止：${chosen.created_at_utc}，保存${Object.keys(chosen.rows).length}条原始记录，详情已读取${Object.values(chosen.rows).filter(row=>row.raw_detail_evidence_json).length}帖，图片列表已读取${Object.values(chosen.rows).filter(row=>row.processing_status==='list_only_image_captured').length}帖；原因：${chosen.stop_reason||'未记录'}。可以导出CSV。`
    : `所选采集批次${chosen.status==='paused'?'已暂停':'运行中'}，已保存${Object.keys(chosen.rows).length}帖；请保留Facebook网页。`;
}
async function launch(mode) {
  if(launchPending)return;
  const selectedRun=runs.value;
  launchPending=true;launchError='';
  statusNode.textContent=mode==='dialog'?'正在检查当前帖子弹窗并启动读取，请保留Facebook页面…':'正在检查网页并启动任务…';
  statusNode.scrollIntoView({block:'nearest'});
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const url=new URL(tab?.url||'about:blank');
    if(url.origin!=='https://www.facebook.com')throw new Error('请打开Facebook网页。');
    const all=await chrome.storage.local.get(null),saved=all['lp_fb_run_'+selectedRun];
    let target=mode==='resume'||mode==='dialog'&& !localPandaTarget.parse(url.href)?localPandaTarget.fromState(saved):localPandaTarget.parse(url.href);
    if(!target)throw new Error('请打开目标账号的主页（不能从Facebook首页或视频页新建任务）。');
    if(mode==='resume'){
      const result=await chrome.runtime.sendMessage({type:'lp_fb_manual_resume',run_id:selectedRun,tab_id:tab.id});
      if(!result?.ok)throw new Error(result?.error||'断点恢复未能启动');
      launchPending=false;statusNode.textContent=result.message;return;
    }
    if(mode!=='dialog'&&!localPandaTarget.same(url.href,target))throw new Error('请返回所选批次主页：'+target.profile_url);
    // Dialog mode verifies the visible post and its author inside the page, not the background URL.
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['target.js','background_runtime.js','comment_reader.js','page_reader.js','publication_time.js','checkpoint.js','readable_export.js','export_csv.js','collector.js']});
    const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:(mode,id,version,target)=>{
      if(globalThis.localPandaCollector?.version!==version)return {ok:false,error:'page_script_version_mismatch：请先导出当前数据，再刷新目标主页以加载新版本。'};
      const headings=[...document.querySelectorAll('h1,[role=heading][aria-level="1"]')].filter(n=>!n.closest('[role=dialog],[role=article]')&&n.getBoundingClientRect().height>0);
      const names=[...new Set(headings.map(n=>n.innerText.trim()).filter(Boolean))];
      if(mode!=='resume'&&names.length===1)target.name=names[0];
      return localPandaCollector.launch(mode,id,{target});
    },args:[mode,selectedRun,'0.6.9',target]});
    if(!result?.result?.ok)throw new Error(result?.result?.error||'任务未启动');
    launchPending=false;statusNode.textContent=result.result.message;await refresh(result.result.run_id);
  } catch(error){launchError=String(error.message||error);statusNode.textContent='未能启动：'+launchError;statusNode.scrollIntoView({block:'nearest'});}
  finally{launchPending=false;}
}
for(const id of ['formal','start','start10','resume','dialog','profile'])document.getElementById(id).onclick=()=>launch(id);
document.getElementById('formalHere').onclick=()=>launch('formal_here');
document.getElementById('stopRun').onclick=async()=>{
  try{const result=await chrome.runtime.sendMessage({type:'lp_fb_stop_saved_run',run_id:runs.value});if(!result?.ok)throw new Error(result?.error||'stop_failed');await refresh();}
  catch(error){statusNode.textContent='停止失败：'+String(error.message||error);}
};
document.getElementById('togglePanel').onclick=async()=>{
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(new URL(tab?.url||'about:blank').hostname!=='www.facebook.com')throw new Error('请打开Facebook网页。');
    const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{
      const panel=document.getElementById('local-panda-collector-panel');
      if(!panel)return {found:false};panel.hidden=!panel.hidden;return {found:true,hidden:panel.hidden};
    }});
    statusNode.textContent=!result?.result?.found?'当前网页没有采集面板。':result.result.hidden?'网页面板已隐藏；任务状态和已存数据不变。':'网页面板已显示。';
  }catch(error){statusNode.textContent=String(error.message||error);}
};

document.getElementById('diagnose').onclick=async()=>{
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(new URL(tab?.url||'about:blank').hostname!=='www.facebook.com')throw new Error('请打开目标Facebook页面。');
    const all=await chrome.storage.local.get(null),allowedPostUrls=[];
    const target=localPandaTarget.parse(tab.url)||localPandaTarget.fromState(all['lp_fb_run_'+runs.value]);
    if(!target)throw new Error('请打开目标主页或选择对应批次。');
    for(const [key,state] of Object.entries(all))if(key.startsWith('lp_fb_run_')&&Object.values(state.rows||{}).every(row=>localPandaTarget.same(row.profile_url,target)))
      {
        for(const row of Object.values(state.rows||{}))if(localPandaTarget.same(row.profile_url,target)&&row.post_url)allowedPostUrls.push(row.post_url);
        for(const key of state.discovered||[])if(/^reel:\d+$/.test(key))allowedPostUrls.push('https://www.facebook.com/reel/'+key.split(':')[1]+'/');
      }
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['target.js','diagnostics.js']});
    const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:config=>localPandaDiagnostics.safeRun(config),args:[{allowedPostUrls,target}]});
    const report=result?.result;if(!report?.ok)throw new Error(report?.error_code?`${report.error_code} (${report.error_name})`:'diagnostic_script_result_missing');
    diagnosticStatus.textContent=`已发起结构CSV下载：${report.filename}；${report.nodes}个元素${report.truncated?'，达到快照上限':''}。${report.warning||''}请上传该文件，无需运行采集循环。`;
  }catch(error){diagnosticStatus.textContent='未保存结构诊断：'+String(error.message||error);}
};
async function exportRun(kind='posts'){
  try {
    const id=runs.value;if(!id){statusNode.textContent='暂无保存批次。';return;}
    const key='lp_fb_run_'+id;const state=(await chrome.storage.local.get(key))[key];
    if(!state){statusNode.textContent='所选批次已不存在，请重新选择本地批次。';return;}
    const all=await chrome.storage.local.get(null);
    state.supervisor_binding_at_export=Object.entries(all).filter(([k,b])=>k.startsWith('lp_fb_supervisor_')&&b?.run_id===id&&Number.isInteger(b.tab_id)).map(([,b])=>b);
    state.background_supervision=all['lp_fb_background_'+id]||[];
    if(kind==='raw'){localPandaRawExport(state);statusNode.textContent='已发起原始证据CSV下载，仅用于诊断与备份。';}
    else{const count=localPandaReadable.download(state,kind);statusNode.textContent='已导出'+count+'条'+(kind==='comments'?'评论':'帖子')+'，中文列名；缺失不补0。';}
  } catch(error){statusNode.textContent='导出失败，原记录未删除：'+String(error.message||error);}
};
document.getElementById('download').onclick=()=>exportRun('posts');
document.getElementById('downloadComments').onclick=()=>exportRun('comments');
document.getElementById('downloadRaw').onclick=()=>exportRun('raw');
runs.addEventListener('change',()=>refresh(runs.value).catch(error=>{statusNode.textContent=String(error.message||error);}));
document.getElementById('discoveryProbe').onclick=async()=>{
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!localPandaTarget.parse(tab?.url))throw new Error('请打开目标账号主页');
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['target.js','comment_reader.js','page_reader.js','discovery_probe.js']});
    const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>localPandaDiscoveryProbe()});
    if(!result?.result?.ok)throw new Error('识别诊断未完成');
    diagnosticStatus.textContent='已下载帖子识别诊断：'+result.result.filename+'。请发送此文件；本操作没有启动采集或滚动。';
  }catch(error){diagnosticStatus.textContent='帖子识别诊断失败：'+String(error.message||error);}
};
chrome.storage.onChanged.addListener(()=>refresh().catch(()=>{}));
localPandaTarget.migrateLegacyFrench().then(()=>refresh()).catch(error=>{statusNode.textContent='本地存储不可用：'+String(error.message||error);});
