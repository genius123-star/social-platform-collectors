"use strict";
importScripts("target.js","comment_reader.js");
const postKey=localPandaCommentReader({}).postKey;
// Extension-scoped supervision survives destruction of a Facebook document.
const VERSION='0.6.9',PREFIX='lp_fb_supervisor_',locks=new Set();
const WATCHDOG='lp_fb_recovery_watchdog';
// Compare resource addresses, ignoring tracking and trailing slashes, retaining identity query keys.
const resourceAddress=url=>{try{const u=new URL(url);if(u.origin!=='https://www.facebook.com')return '';const q=new URLSearchParams();for(const k of ['story_fbid','id','fbid'])if(u.searchParams.has(k))q.set(k,u.searchParams.get(k));return u.pathname.replace(/\/+$/,'')+(q.size?'?'+q:'');}catch{return '';}};
async function armWatchdog(){if(!await chrome.alarms.get(WATCHDOG))await chrome.alarms.create(WATCHDOG,{periodInMinutes:0.5});}
const FILES=['target.js','background_runtime.js','comment_reader.js','page_reader.js','publication_time.js','checkpoint.js','readable_export.js','export_csv.js','collector.js'];
const read=async key=>(await chrome.storage.local.get(key))[key];
const MANUAL='lp_fb_manual_resume_',manualLocks=new Set();
async function resumeManual(tabId){
  if(manualLocks.has(tabId))return;manualLocks.add(tabId);
  let pending;
  try{
    pending=(await chrome.storage.session.get(MANUAL+tabId))[MANUAL+tabId];if(!pending)return;
    if(Date.now()-pending.created_ms>120000)throw new Error('续采启动等待超时，请再次点击从断点继续');
    const tab=await chrome.tabs.get(tabId);if(tab.status==='loading')return;
    const run=await read('lp_fb_run_'+pending.run_id),target=localPandaTarget.fromState(run);
    if(!isProfile(tab.url,target))throw new Error('当前页面不是该批次的目标主页');
    if(run.user_stop_requested||run.manual_resume_request!==pending.request_id)throw new Error('该次续采已被停止或替换');
    const current=await inspect(tabId);
    if(current?.restricted)throw new Error('请先完成登录或处理访问限制，再从断点继续');
    if(current?.busy){
      if(current.run_id===pending.run_id){await chrome.storage.session.remove(MANUAL+tabId);return;}
      throw new Error('当前标签页有其他采集任务运行');
    }
    await chrome.scripting.executeScript({target:{tabId},files:FILES});
    const stillPending=(await chrome.storage.session.get(MANUAL+tabId))[MANUAL+tabId];
    if(stillPending?.request_id!==pending.request_id)return;
    const [result]=await chrome.scripting.executeScript({target:{tabId},func:async(id,version,requestId,strategy)=>{
      if(globalThis.localPandaCollector?.version!==version)return {ok:false,error:'请刷新页面以加载新版脚本'};
      return localPandaCollector.launch('resume',id,{manualRequest:requestId,resumeStrategy:strategy});
    },args:[pending.run_id,VERSION,pending.request_id,pending.strategy]});
    if(!result?.result?.ok)throw new Error(result?.result?.error||'断点恢复启动失败');
    await chrome.storage.session.remove(MANUAL+tabId);
  }catch(error){
    await chrome.storage.session.remove(MANUAL+tabId);
    if(pending){
      const key='lp_fb_run_'+pending.run_id,run=await read(key);
      if(run){run.manual_resume_status='failed';run.manual_resume_error=String(error.message||error);await chrome.storage.local.set({[key]:run});}
    }
  }finally{manualLocks.delete(tabId);}
}
const isProfile=(url,target)=>localPandaTarget.same(url,target);
const onFacebook=url=>{try{return new URL(url).origin==='https://www.facebook.com';}catch{return false;}};
const isHome=url=>{try{return onFacebook(url)&&new URL(url).pathname==='/';}catch{return false;}};
const protectedRoute=url=>{try{return /\/login|\/checkpoint|\/challenge|\/two_step_verification/i.test(new URL(url).pathname);}catch{return true;}};
async function halt(binding,reason) {
  binding.enabled=false;binding.phase=reason;binding.updated_at_utc=new Date().toISOString();
  await chrome.storage.local.set({[PREFIX+binding.tab_id]:binding});
  if(binding.original_auto_discardable===true)try{await chrome.tabs.update(binding.tab_id,{autoDiscardable:true});}catch{}
  return {ok:false,error:reason};
}
async function backgroundNote(binding,status,detail={}){
  if(binding.background_state===status&&!Object.keys(detail).length)return;
  binding.background_state=status;binding.background_observed_at_utc=new Date().toISOString();
  const key='lp_fb_background_'+binding.run_id,events=await read(key)||[];
  events.push({at_utc:binding.background_observed_at_utc,status,tab_id:binding.tab_id,...detail});
  await chrome.storage.local.set({[key]:events.slice(-300),[PREFIX+binding.tab_id]:binding});
}
async function inspect(tabId) {
  const [result]=await chrome.scripting.executeScript({target:{tabId},func:()=>{
    const visible=n=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0;};
    const restricted=/access denied|verify you are human|security check|访问受限|安全验证/i.test(document.title)||
      [...document.querySelectorAll('input[type=password],iframe[src*="captcha"],iframe[title*="captcha" i],[id*="captcha"]')].some(visible)||
      [...document.querySelectorAll('[role="alert"]')].some(n=>visible(n)&&/temporarily blocked|try again later|暂时被封锁|操作过于频繁|访问受到限制/i.test(n.innerText));
    const runner=globalThis.localPandaCollector;
    return {restricted,busy:!!runner?.busy(),run_id:runner?.getState()?.run_id||'',url:location.href,has_runner:!!runner,visibility_state:document.visibilityState,has_focus:document.hasFocus(),was_discarded:document.wasDiscarded===true,interrupted:runner?.getState()?.status==='interrupted'};
  }});
  return result?.result;
}
async function supervise(tabId,{requested=false}={}) {
  if(locks.has(tabId))return {ok:true,pending:true};locks.add(tabId);
  try {
    const binding=await read(PREFIX+tabId);if(!binding?.enabled)return {ok:false,error:'supervisor_not_armed'};
    if(await read('lp_fb_active')!==binding.run_id||await read('lp_fb_supervisor_owner_'+binding.run_id)!==tabId)return halt(binding,'another_run_or_tab_is_active');
    const session=(await chrome.storage.session.get(PREFIX+tabId))[PREFIX+tabId];
    if(session!==binding.run_id)return halt(binding,'browser_restart_requires_manual_resume');
    const key='lp_fb_run_'+binding.run_id,run=await read(key);
    if(!run||run.config?.collection_scope!=='formal')return halt(binding,'saved_run_not_formal');
    const target=localPandaTarget.fromState(run),PROFILE=target.profile_url;
    if(!localPandaTarget.same(binding.profile_url,target))return halt(binding,'saved_target_binding_mismatch');
    if(run.user_stop_requested||run.status==='paused'||run.paused_before_navigation)return {ok:true,paused:true};
    if(Date.now()>=binding.deadline_ms)return halt(binding,'runtime_limit_reached');
    const terminal=/^(post_discovery_rejected_requires_review|post_discovery_target_binding_mismatch|detail_pipeline_unhealthy_requires_review|user_stopped|runtime_limit_reached|storage_write_failed|login_or_verification_required|access_restricted|access_or_verification_required|bounded_sample_limit_reached|date_window_start_boundary_confirmed|no_new_content_observed|feed_scroll_not_advancing|scroll_limit_reached|profile_snapshot_only|current_dialog_only)$/.test(run.stop_reason||'');
    if(terminal)return {ok:true,stopped:true};
    const recoverable=!terminal&&(!!run.last_interrupted_post||run.stop_reason==='navigation_left_target_profile'||run.stop_reason==='page_navigation_interrupted');
    if(!['running','interrupted','recovering'].includes(run.status)&&!requested&&!recoverable)return {ok:true,stopped:true};
    const tab=await chrome.tabs.get(tabId),url=tab.url;
    if(!onFacebook(url))return halt(binding,'recovery_permission_or_origin_unavailable');
    if(protectedRoute(url))return halt(binding,'login_or_verification_required');
    if(tab.frozen){await backgroundNote(binding,'frozen');return {ok:true,frozen:true};}
    if(tab.discarded){await backgroundNote(binding,'discarded');return {ok:true,discarded:true};}
    if(tab.status==='loading'){await backgroundNote(binding,'loading');return {ok:true,loading:true};}

    const address=resourceAddress(url);
    const known=!!address&&Object.values(run.rows||{}).some(row=>resourceAddress(row.post_url)===address);
    if(!isProfile(url,target)&&!isHome(url)&&!known)return halt(binding,'navigation_outside_bound_target');
    const current=await inspect(tabId);
    if(!current||current.restricted)return halt(binding,'login_or_access_restricted');
    if(current.busy&&current.run_id!==binding.run_id)return halt(binding,'another_run_owns_tab');
    await backgroundNote(binding,current.busy?(current.visibility_state==='hidden'?'running_background':current.has_focus?'running_visible':'running_unfocused'):
      current.has_runner?'runner_idle':'script_missing');
    if(current.busy)return {ok:true,already_running:true}; // Never interrupt a normal SPA detail.
    if(binding.phase!=='returning_to_target') {
      const progress=Number(run.safe_post_progress||0);
      binding.consecutive_recoveries=progress>(binding.last_progress||0)?1:(binding.consecutive_recoveries||0)+1;
      if(binding.consecutive_recoveries>3||(binding.recovery_count||0)>=30)return halt(binding,'repeated_recovery_requires_review');
      binding.last_progress=progress;binding.recovery_count=(binding.recovery_count||0)+1;
      run.supervisor_recovery_count=binding.recovery_count;
      const interrupted=run.current_post||run.last_interrupted_post||'';
      run.supervisor_skipped_keys=run.supervisor_skipped_keys||[];
      run.navigation_retry_counts=run.navigation_retry_counts||{};
      const retry=interrupted?(run.navigation_retry_counts[interrupted]||0)+1:0;
      if(interrupted)run.navigation_retry_counts[interrupted]=retry;
      const retryPost=!!interrupted&&retry<=1;
      const source=run.source_cursor;
      const interruptedRow=Object.values(run.rows||{}).find(row=>postKey(row.post_url)===interrupted);
      if(interrupted&&interruptedRow){
        run.resume_cursor={...(source?.post_key===interrupted?source:{}),post_key:interrupted,post_url:interruptedRow.post_url,profile_url:PROFILE,retry_post:retryPost};
        if(retryPost){run.supervisor_skipped_keys=run.supervisor_skipped_keys.filter(key=>key!==interrupted);run.attempts[interrupted]=Math.min(run.attempts[interrupted]||0,1);}
        else if(!run.supervisor_skipped_keys.includes(interrupted))run.supervisor_skipped_keys.push(interrupted);
      }
      if(interrupted&&!interruptedRow)return halt(binding,'interrupted_post_identity_unavailable');
      if(interrupted)run.completed=(run.completed||[]).filter(key=>key!==interrupted);
      for(const row of Object.values(run.rows||{}))if(interrupted&&postKey(row.post_url)===interrupted) {
        row.automatic_recovery_status=retryPost?'partial_preserved_pending_relocation_retry':'partial_preserved_skipped_after_navigation_retry';
        row.automatic_recovery_reason=run.stop_reason||'unexpected_document_navigation';
        row.automatic_recovery_previous_status=row.processing_status||'';
        row.processing_status=row.raw_detail_evidence_json?'partial_detail_return_error':'partial_navigation_error';
        row.collection_stop_reason=row.automatic_recovery_reason;
      }
      const navigate=!isProfile(url,target);
      const recoveryReason=navigate?'left_target_profile':current.has_runner?'stopped_reader_retry_in_place':current.was_discarded?'browser_discarded_document_restored':'target_document_script_missing';
      run.logs=run.logs||[];run.logs.push({at_utc:new Date().toISOString(),action:navigate?'supervisor_return_to_target':'supervisor_resume_in_place',detail:JSON.stringify({observed_url:url,target:PROFILE,interrupted_post:interrupted,recovery_count:binding.recovery_count,reason:recoveryReason})});
      run.status='recovering';run.owner='';run.current_post='';run.pending_action=null;
      run.recovery_started_clock=binding.started_clock;
      binding.transient_errors=0;binding.phase='returning_to_target';binding.updated_at_utc=new Date().toISOString();
      await chrome.storage.local.set({[key]:run,[PREFIX+tabId]:binding});
      await backgroundNote(binding,navigate?'navigation_recovery':'resume_in_place',{reason:recoveryReason,observed_url:url,target:PROFILE,interrupted_post:interrupted});
      if(navigate){await chrome.tabs.update(tabId,{url:PROFILE});return {ok:true,returning_to_target:true};}
      // An idle/missing reader on the correct page is restarted without reloading that page.
    }
    if(!isProfile(url,target))return halt(binding,'target_profile_not_restored');
    await chrome.scripting.executeScript({target:{tabId},files:FILES});
    const [launched]=await chrome.scripting.executeScript({target:{tabId},func:async(id,version)=>{
      if(globalThis.localPandaCollector?.version!==version)return {ok:false,error:'recovery_script_version_mismatch'};
      return localPandaCollector.launch('resume',id,{automaticRecovery:true});
    },args:[binding.run_id,VERSION]});
    if(!launched?.result?.ok)return halt(binding,launched?.result?.error||'automatic_resume_failed');
    // Registration from the new content script owns the latest binding.
    return {ok:true,resumed:true};
  } catch(error) {
    const binding=await read(PREFIX+tabId);
    if(binding?.enabled){
      binding.transient_errors=(binding.transient_errors||0)+1;
      binding.last_error=String(error.message||error);binding.updated_at_utc=new Date().toISOString();
      // Navigation can destroy a frame between tabs.get and executeScript. Retry on the next independent alarm.
      if(binding.transient_errors>=3)await halt(binding,'recovery_failed:'+binding.last_error);
      else await chrome.storage.local.set({[PREFIX+tabId]:binding});
    }
    return {ok:false,error:String(error.message||error)};
  } finally {locks.delete(tabId);}
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(!message||!['lp_fb_manual_resume','lp_fb_wait','lp_fb_register_run','lp_fb_recover','lp_fb_disarm','lp_fb_stop_saved_run'].includes(message.type))return;
  (async()=>{
    if(message.type==='lp_fb_manual_resume'){
      if(!sender.url?.startsWith(chrome.runtime.getURL(''))||!Number.isInteger(message.tab_id))return {ok:false,error:'manual_resume_requires_extension_popup'};
      const tab=await chrome.tabs.get(message.tab_id);if(!onFacebook(tab.url))return {ok:false,error:'请先打开Facebook网页'};
      const run=await read('lp_fb_run_'+message.run_id);if(!run)return {ok:false,error:'所选批次不存在'};
      const target=localPandaTarget.fromState(run),current=await inspect(message.tab_id);
      if(current?.restricted)return {ok:false,error:'请先完成登录或处理访问限制'};
      if(current?.busy)return {ok:false,error:'请先停止当前标签页的任务，再从断点继续'};
      const active=await read('lp_fb_active'),other=active&&await read('lp_fb_run_'+active);
      if(other&&['running','paused'].includes(other.status)&&Date.now()-other.heartbeat<15000)return {ok:false,error:'仍有采集任务运行，请先停止'};
      const binding=await read(PREFIX+message.tab_id);if(binding?.enabled)await halt(binding,'manual_checkpoint_resume_requested');
      const inPlace=isProfile(tab.url,target)&&isProfile(current?.url,target);
      const strategy=inPlace?'in_place':'return_to_profile';
      const request_id=crypto.randomUUID();run.manual_resume_request=request_id;run.manual_resume_status=inPlace?'resuming_in_place':'returning_to_profile';run.manual_resume_error='';run.user_stop_requested=false;
      run.manual_resume_strategy=strategy;
      await chrome.storage.local.set({['lp_fb_run_'+message.run_id]:run});
      await chrome.storage.session.set({[MANUAL+message.tab_id]:{run_id:message.run_id,created_ms:Date.now(),request_id,strategy}});
      await armWatchdog();
      try{
        if(inPlace)await resumeManual(message.tab_id);
        else await chrome.tabs.update(message.tab_id,{url:target.profile_url});
      }
      catch(error){await chrome.storage.session.remove(MANUAL+message.tab_id);throw error;}
      const updated=await read('lp_fb_run_'+message.run_id);
      if(updated?.manual_resume_status==='failed')return {ok:false,error:updated.manual_resume_error};
      return {ok:true,pending:true,message:inPlace?'保留当前页面和加载位置，正在原地查找断点；不会刷新，可以关闭扩展小窗。':'当前页面已偏离目标主页，正在返回 '+target.profile_url+' 后定位断点；可以关闭扩展小窗。'};
    }
    if(message.type==='lp_fb_wait'){
      if(!Number.isInteger(sender.tab?.id)||!onFacebook(sender.url||sender.tab.url)||
        !Number.isFinite(message.delay_ms)||message.delay_ms<1||message.delay_ms>1000||
        await read('lp_fb_active')!==message.run_id)return {ok:false,error:'invalid_background_wait'};
      await new Promise(resolve=>setTimeout(resolve,message.delay_ms));return {ok:true};
    }
    if(message.type==='lp_fb_stop_saved_run') {
      if(!sender.url?.startsWith(chrome.runtime.getURL('')))return {ok:false,error:'stop_requires_extension_popup'};
      const all=await chrome.storage.local.get(null);
      const sessions=await chrome.storage.session.get(null);
      for(const [key,value]of Object.entries(sessions))if(key.startsWith(MANUAL)&&value?.run_id===message.run_id)await chrome.storage.session.remove(key);
      for(const [key,binding] of Object.entries(all))if(key.startsWith(PREFIX)&&binding?.run_id===message.run_id) {
        await halt(binding,'user_or_run_stopped');
        try {await chrome.scripting.executeScript({target:{tabId:binding.tab_id},func:async id=>{if(globalThis.localPandaCollector?.getState()?.run_id===id)await localPandaCollector.stop();},args:[message.run_id]});}catch{}
      }
      const key='lp_fb_run_'+message.run_id,run=await read(key);
      if(run){run.user_stop_requested=true;run.status='stopped';run.stop_reason='user_stopped';await chrome.storage.local.set({[key]:run});}
      return {ok:true};
    }
    const tabId=sender.tab?.id;if(!Number.isInteger(tabId))return {ok:false,error:'no_bound_tab'};
    const key=PREFIX+tabId,previous=await read(key);
    if(message.type==='lp_fb_disarm') {
      if(previous&&previous.run_id===message.run_id)await halt(previous,'user_or_run_stopped');
      return {ok:true};
    }
    if(message.type==='lp_fb_recover') {
      if(previous?.run_id!==message.run_id)return {ok:false,error:'run_binding_mismatch'};
      return supervise(tabId,{requested:true});
    }
    await armWatchdog();
    const run=await read('lp_fb_run_'+message.run_id);
    if(!run||run.config?.collection_scope!=='formal')return {ok:false,error:'saved_run_not_formal'};
    const target=localPandaTarget.fromState(run),PROFILE=target.profile_url;
    if(!isProfile(sender.url||sender.tab.url,target))return {ok:false,error:'registration_requires_target_profile'};
    const reused=message.automatic_recovery&&previous?.run_id===message.run_id;
    const originalTab=await chrome.tabs.get(tabId);
    const binding={...(reused?previous:{}),tab_id:tabId,run_id:message.run_id,profile_url:PROFILE,enabled:true,phase:'watching',transient_errors:0,
      original_auto_discardable:reused&&typeof previous.original_auto_discardable==='boolean'?previous.original_auto_discardable:originalTab.autoDiscardable,
      started_clock:run.started_clock,deadline_ms:run.started_clock+run.config.max_runtime_ms,
      recovery_count:reused?previous.recovery_count:0,consecutive_recoveries:reused?previous.consecutive_recoveries:0,last_progress:Number(run.safe_post_progress||0)};
    try{await chrome.tabs.update(tabId,{autoDiscardable:false});binding.discard_protection='enabled';}catch(error){binding.discard_protection='unavailable';binding.discard_protection_error=String(error.message||error);}
    await chrome.storage.local.set({[key]:binding,['lp_fb_supervisor_owner_'+message.run_id]:tabId});await chrome.storage.session.set({[key]:message.run_id});return {ok:true};
  })().then(reply,error=>reply({ok:false,error:String(error.message||error)}));
  return true;
});
chrome.tabs.onUpdated.addListener((tabId,change)=>{
  if(change.status==='complete')resumeManual(tabId).catch(()=>{});
  if(change.status==='complete'||(change.url&&change.status!=='loading'))supervise(tabId).catch(()=>{});
});
chrome.tabs.onRemoved.addListener(tabId=>{chrome.storage.local.remove(PREFIX+tabId).catch(()=>{});chrome.storage.session.remove([PREFIX+tabId,MANUAL+tabId]).catch(()=>{});});

chrome.alarms.onAlarm.addListener(async alarm=>{
  if(alarm.name!==WATCHDOG)return;
  const all=await chrome.storage.local.get(null);
  const sessions=await chrome.storage.session.get(null);
  for(const key of Object.keys(sessions))if(key.startsWith(MANUAL)){const tabId=Number(key.slice(MANUAL.length));if(Number.isInteger(tabId))await resumeManual(tabId);}
  for(const [key,binding] of Object.entries(all))if(key===PREFIX+binding?.tab_id&&binding.enabled)await supervise(binding.tab_id);
});
// Recreate a lost alarm after worker restart, without activating disabled or old-session runs.
chrome.storage.local.get(null).then(all=>{if(Object.entries(all).some(([key,b])=>key===PREFIX+b?.tab_id&&b.enabled))return armWatchdog();}).catch(()=>{});

chrome.storage.session.get(null).then(all=>{if(Object.keys(all).some(key=>key.startsWith(MANUAL)))return armWatchdog();}).catch(()=>{});
