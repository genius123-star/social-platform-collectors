"use strict";
importScripts("core.js");
const C=VKProbeCore;
let busy=false;
let hoverWrites=Promise.resolve();
function saveHover(message,sender){
  const action=hoverWrites.then(async()=>{
    const binding=(await chrome.storage.local.get(C.PREFIX+'hover_binding'))[C.PREFIX+'hover_binding'];
    if(!binding||binding.run_id!==message.run_id||binding.tab_id!==sender.tab?.id||Date.now()>binding.deadline||binding.epoch!==message.epoch)
      throw new Error('时间提示记录已过期或批次不匹配。');
    const o=message.observation,r=C.resource(o?.resource_url),tab=await chrome.tabs.get(binding.tab_id);
    if(C.target(tab.url)?.entry_url!==binding.entry_url||!r||r.key!==o?.resource_key||!binding.keys.includes(r.key)||
      typeof o.text!=='string'||o.text.length>240||!Number.isFinite(Date.parse(o.collected_at))||
      o.association_status!=='hover_lifecycle_confirmed'||o.stable_samples<2||o.disappeared_after_leave!==true)
      throw new Error('时间提示资源或生命周期证据不完整。');
    const key=C.PREFIX+'snapshot_'+binding.run_id,snapshot=C.validate((await chrome.storage.local.get(key))[key]);
    snapshot.hover_observations=snapshot.hover_observations||[];
    if(snapshot.hover_observations.length>=2000)throw new Error('storage_tooltip_budget_export_required');
    snapshot.hover_observations.push({resource_key:r.key,resource_url:r.url,text:o.text,
      association_status:o.association_status,stable_samples:o.stable_samples,disappeared_after_leave:true,
      started_at:o.started_at,collected_at:o.collected_at,
      source:binding.automatic?'extension_mouse_event_public_tooltip':'user_hover_public_tooltip'});
    if(!snapshot.auto_run)snapshot.status='hover_recorded_time_policy_applied_on_export';C.validate(snapshot);
    await chrome.storage.local.set({[key]:snapshot});return {saved:true,count:snapshot.hover_observations.length};
  });
  hoverWrites=action.catch(()=>{});return action;
}
function commitAuto(message,sender){
  const action=hoverWrites.then(async()=>{
    const binding=(await chrome.storage.local.get(C.PREFIX+'auto_binding'))[C.PREFIX+'auto_binding'];
    if(!binding||binding.run_id!==message.run_id||binding.tab_id!==sender.tab?.id||binding.epoch!==message.epoch)throw new Error('自动试采批次归属不匹配。');
    if(!['paused','stopped'].includes(message.phase)&&C.target((await chrome.tabs.get(binding.tab_id)).url)?.entry_url!==binding.entry_url)throw new Error('target_page_changed');
    const key=C.PREFIX+'snapshot_'+binding.run_id,snapshot=C.validate((await chrome.storage.local.get(key))[key]);
    if(snapshot.version!==C.VERSION)throw new Error('自动试采版本已变化，请停止并导出旧批次。');
    const auto=snapshot.auto_run;
    const terminal=['stopped','paused','trial_finished'];
    if(auto.stop_requested&&!terminal.includes(message.phase)&&message.phase!=='post_processed')throw new Error('user_stopped');
    if(!terminal.includes(message.phase)&&Date.now()>binding.deadline)throw new Error('time_budget_exhausted');
    if(message.discovered){
      if(auto.mode!=='history'||!Array.isArray(message.discovered)||message.discovered.length>12)throw new Error('invalid_discovery');
      for(const c of message.discovered){
        const r=C.resource(c.resource?.url);
        if(!r||r.type!=='wall'||r.owner_id!=='-42692593'||r.key!==c.resource.key||
          !new RegExp(`^(?:post|wall)?${r.owner_id}_${r.id}$`).test(c.public_id_attribute||'')||
          !c.fields?.header_links?.length||!c.fields.header_links.every(h=>C.target(h.url)?.entry_url===binding.entry_url))throw new Error('discovery_identity_failed');
        if(!binding.keys.includes(r.key)){
          if(snapshot.candidates.length>=1000)throw new Error('storage_post_budget_export_required');
          binding.keys.push(r.key);auto.keys.push(r.key);snapshot.candidates.push(c);
        }
      }
    }
    if(message.current_key&&!binding.keys.includes(message.current_key))throw new Error('自动试采资源键不匹配。');
    if(message.candidate){
      const c=message.candidate,r=C.resource(c.resource?.url);
      if(!r||r.key!==message.current_key||r.owner_id!=='-42692593'||!c.fields?.header_links?.length||
        !c.fields.header_links.every(h=>C.target(h.url)?.entry_url===binding.entry_url))throw new Error('自动试采帖子证据不匹配。');
      const index=snapshot.candidates.findIndex(x=>x.resource.key===r.key);
      if(index<0)throw new Error('自动试采资源不在固定队列。');
      const previous=snapshot.candidates[index];
      if(previous.fields?.comments){
        const merged=new Map((previous.fields.comments.items||[]).map(v=>[v.id,v]));
        for(const v of c.fields.comments?.items||[])merged.set(v.id,v);
        c.fields.comments={...(c.fields.comments||previous.fields.comments),items:[...merged.values()]};
      }
      if(!c.fields.body?.text&&previous.fields?.body?.text)c.fields.body=previous.fields.body;
      if((c.fields.body?.truncated||c.fields.body?.show_more_present)&&previous.fields?.body?.text?.length>c.fields.body.text.length)c.fields.body=previous.fields.body;
      snapshot.candidates[index]=c;
    }
    auto.phase=auto.stop_requested&&message.phase==='trial_finished'?'stopped':String(message.phase||'unknown').slice(0,80);auto.current_key=message.current_key||null;
    auto.heartbeat_at=new Date().toISOString();
    if(message.cursor&&Number.isFinite(message.cursor.scroll_y))auto.cursor={scroll_y:Math.max(0,message.cursor.scroll_y),at:auto.heartbeat_at};
    if(message.discovery_state)auto.discovery_state=message.discovery_state;
    if(message.result){
      auto.results[message.current_key]=message.result;
      if(!auto.processed_keys.includes(message.current_key))auto.processed_keys.push(message.current_key);
    }
    if(message.stop_reason)auto.stop_reason=auto.stop_requested?'user_stopped':String(message.stop_reason).slice(0,200);
    auto.events.push({phase:auto.phase,key:auto.current_key,at:auto.heartbeat_at});
    if(auto.events.length>80)auto.events.shift();
    if(terminal.includes(auto.phase)){auto.finished_at=auto.heartbeat_at;snapshot.status=auto.phase;}
    else snapshot.status='automatic_trial_running';
    C.validate(snapshot);
    const hoverBinding={...binding,keys:[...binding.keys]};
    await chrome.storage.local.set({[key]:snapshot,[C.PREFIX+'auto_binding']:binding,[C.PREFIX+'hover_binding']:hoverBinding});
    return {saved:true,keys:binding.keys};
  });
  hoverWrites=action.catch(()=>{});return action;
}
async function handle(message) {
  if(message.type==='vk_probe_auto_resume'){
    if(busy)throw new Error('正在启动，请勿重复操作。');busy=true;
    const action=hoverWrites.then(async()=>{
      if(!/^\d{8}T\d{6}_[-\w]{8,}$/.test(message.run_id||''))throw new Error('批次编号无效。');
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      const key=C.PREFIX+'snapshot_'+message.run_id,snapshot=C.validate((await chrome.storage.local.get(key))[key]);
      if(snapshot.version!==C.VERSION||!snapshot.auto_run)throw new Error('旧版本批次请保留导出，使用新版新建采集。');
      if(C.target(tab?.url)?.entry_url!==snapshot.entry_url)throw new Error('请先打开本批目标主页。');
      const active=(await chrome.storage.local.get(C.PREFIX+'auto_binding'))[C.PREFIX+'auto_binding'];
      if(active&&Date.now()<active.deadline){
        const running=(await chrome.storage.local.get(C.PREFIX+'snapshot_'+active.run_id))[C.PREFIX+'snapshot_'+active.run_id];
        if(running?.auto_run&&!['trial_finished','paused','stopped'].includes(running.auto_run.phase)){
          const state=await chrome.scripting.executeScript({target:{tabId:active.tab_id},func:()=>globalThis.VKProbeCollector?.status()});
          if(state[0]?.result?.running)throw new Error('原任务仍在运行，请先暂停。');
        }
      }
      const auto=snapshot.auto_run;
      auto.phase='created';auto.stop_requested=false;auto.stop_reason='';auto.finished_at=null;
      auto.deadline=Date.now()+30*60*1000;auto.resume_count=(auto.resume_count||0)+1;
      const binding={run_id:snapshot.run_id,entry_url:snapshot.entry_url,keys:[...auto.keys],tab_id:tab.id,deadline:auto.deadline,
        automatic:true,mode:auto.mode,epoch:crypto.randomUUID(),processed_keys:auto.processed_keys.filter(k=>auto.results[k]?.status!=='partial'),
        cursor:message.from_current?null:auto.cursor,from_current:!!message.from_current};
      await chrome.storage.local.set({[key]:snapshot,[C.PREFIX+'auto_binding']:binding,[C.PREFIX+'hover_binding']:binding});
      await launch(tab.id,binding);return {run_id:snapshot.run_id,resumed:true};
    });hoverWrites=action.catch(()=>{});
    try{return await action;}finally{busy=false;}
  }
  if(message.type==='vk_probe_auto_stop'){
    if(!/^\d{8}T\d{6}_[-\w]{8,}$/.test(message.run_id||''))throw new Error('批次编号无效。');
    const binding=(await chrome.storage.local.get(C.PREFIX+'auto_binding'))[C.PREFIX+'auto_binding'];
    if(!binding||binding.run_id!==message.run_id)throw new Error('所选批次没有当前试采任务。');
    // Stop intent shares the same write queue as observations, so a pending save cannot erase it.
    const action=hoverWrites.then(async()=>{
      const key=C.PREFIX+'snapshot_'+binding.run_id,snapshot=C.validate((await chrome.storage.local.get(key))[key]);
      if(['trial_finished','paused','stopped'].includes(snapshot.auto_run.phase))return {already_finished:true};
      snapshot.auto_run.stop_requested=true;snapshot.auto_run.phase='stop_requested';
      await chrome.storage.local.set({[key]:snapshot});
    });hoverWrites=action.catch(()=>{});const state=await action;if(state?.already_finished)return state;
    try{await chrome.scripting.executeScript({target:{tabId:binding.tab_id},func:()=>VKProbeCollector?.stop()});}
    catch{
      const action=hoverWrites.then(async()=>{const key=C.PREFIX+'snapshot_'+binding.run_id,s=(await chrome.storage.local.get(key))[key];
        s.auto_run.phase='stopped';s.auto_run.stop_reason='user_stopped_page_unavailable';s.status='stopped';await chrome.storage.local.set({[key]:s});});
      hoverWrites=action.catch(()=>{});await action;
    }
    return {stop_requested:true};
  }
  if(message.type==="vk_probe_list") {
    const all=await chrome.storage.local.get(null);
    return Object.entries(all).filter(([key])=>key.startsWith(C.PREFIX+"snapshot_"))
      .map(([,v])=>({run_id:v.run_id,collected_at:v.collected_at,entry_url:v.entry_url,status:v.status,count:v.candidates.length,
        auto_phase:v.auto_run?.phase,processed:v.auto_run?.processed_keys.length||0,hover_count:v.hover_observations?.length||0}))
      .sort((a,b)=>b.collected_at.localeCompare(a.collected_at));
  }
  if(message.type==="vk_probe_get") {
    if(!/^\d{8}T\d{6}_[-\w]{8,}$/.test(message.run_id||""))throw new Error("批次编号无效。");
    const key=C.PREFIX+"snapshot_"+message.run_id;
    const result=(await chrome.storage.local.get(key))[key];
    if(!result)throw new Error("没有找到所选批次。");
    return C.validate(result);
  }
  if(!['vk_probe_capture','vk_probe_arm_hover','vk_probe_auto_start','vk_probe_history_start'].includes(message.type))throw new Error("不支持的操作。");
  if(busy)throw new Error("正在读取结构，请勿重复启动。");
  busy=true;
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const target=tab&&C.target(tab.url);
    if(!target)throw new Error("请先打开俄文中国网VK主页，再点此按钮。");
    const bytes=await chrome.storage.local.getBytesInUse(null);
    if(bytes>8*1024*1024)throw new Error("存储已超过8MB，请先导出；不会自动删除旧数据。");
    const active=(await chrome.storage.local.get(C.PREFIX+'auto_binding'))[C.PREFIX+'auto_binding'];
    if(active&&Date.now()<active.deadline){
      const old=(await chrome.storage.local.get(C.PREFIX+'snapshot_'+active.run_id))[C.PREFIX+'snapshot_'+active.run_id];
      if(old?.auto_run&&!['trial_finished','paused','stopped'].includes(old.auto_run.phase))throw new Error('原试采仍在运行，请先停止原批次。');
    }
    const tabId=tab.id;
    await chrome.scripting.executeScript({target:{tabId},files:["core.js","diagnostics.js"]});
    const results=await chrome.scripting.executeScript({target:{tabId},func:()=>VKProbeDiagnostics()});
    const snapshot=C.validate(results[0]?.result);
    if(snapshot.version!==C.VERSION)throw new Error("页面读取器版本不一致，请刷新目标页后再试。");
    const current=await chrome.tabs.get(tabId);
    if(C.target(current.url)?.entry_url!==target.entry_url||snapshot.entry_url!==target.entry_url)
      throw new Error("读取期间页面目标发生变化，本次未保存。");
    snapshot.run_id=new Date().toISOString().replace(/[-:]/g,"").slice(0,15)+"_"+crypto.randomUUID();
    const automatic=['vk_probe_auto_start','vk_probe_history_start'].includes(message.type),history=message.type==='vk_probe_history_start';
    if(automatic){
      snapshot.candidates=snapshot.candidates.filter(c=>c.resource.owner_id==='-42692593'&&
        c.fields?.header_links?.length&&c.fields.header_links.every(h=>C.target(h.url)?.entry_url===target.entry_url)).slice(0,history?12:3);
      if(!snapshot.candidates.length)throw new Error('未找到已核验正文和作者的目标帖子。');
      snapshot.initial_candidates=structuredClone(snapshot.candidates);
      snapshot.auto_run={mode:history?'history':'three_loaded_post_trial',phase:'created',deadline:Date.now()+(history?30*60*1000:180000),
        scan_origin:history?(message.from_current?'current_position_upper_wall_uncovered':'top_requested_not_history_completeness_proof'):'loaded_posts',
        keys:snapshot.candidates.map(c=>c.resource.key),processed_keys:[],results:{},events:[],stop_requested:false};
      snapshot.status='automatic_trial_created';C.validate(snapshot);
    }
    const key=C.PREFIX+"snapshot_"+snapshot.run_id;
    await chrome.storage.local.set({[key]:snapshot});
    if(message.type==='vk_probe_arm_hover'||automatic){
      const keys=snapshot.candidates.filter(c=>c.resource.owner_id==='-42692593'&&c.fields?.header_links?.length&&
        c.fields.header_links.every(h=>C.target(h.url)?.entry_url===target.entry_url)).map(c=>c.resource.key);
      if(!keys.length)throw new Error('未找到可绑定的目标帖子，诊断已保存；暂不能记录时间提示。');
      const binding={run_id:snapshot.run_id,entry_url:target.entry_url,keys,tab_id:tabId,
        deadline:automatic?snapshot.auto_run.deadline:Date.now()+10*60*1000,automatic,
        mode:snapshot.auto_run?.mode,from_current:!!message.from_current};
      await chrome.storage.local.set({[C.PREFIX+'hover_binding']:binding});
      if(automatic)await chrome.storage.local.set({[C.PREFIX+'auto_binding']:binding});
      await launch(tabId,binding);
    }
    return {run_id:snapshot.run_id,count:snapshot.candidates.length,status:snapshot.status,
      body_count:snapshot.candidates.filter(c=>c.fields?.body?.status==='visible_text_only'&&c.fields.body.text).length};
  } finally {busy=false;}
}
async function launch(tabId,binding){
  const state=await chrome.scripting.executeScript({target:{tabId},func:()=>globalThis.VKProbeCollector?.running===true});
  if(state[0]?.result===true)throw new Error('原任务仍在结束，请稍后继续。');
  await chrome.scripting.executeScript({target:{tabId},files:['core.js','samples.js','diagnostics.js','comments.js','hover_reader.js']});
  await chrome.scripting.executeScript({target:{tabId},func:binding=>VKProbeHover.start(binding),args:[binding]});
  if(binding.automatic){
    await chrome.scripting.executeScript({target:{tabId},files:['collector.js']});
    await chrome.scripting.executeScript({target:{tabId},func:binding=>VKProbeCollector.launch(binding),args:[binding]});
  }
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  // No external messages and no host-page message bridge.
  if(sender.id!==chrome.runtime.id)return false;
  (message.type==='vk_probe_hover_observation'?saveHover(message,sender):
    message.type==='vk_probe_auto_commit'?commitAuto(message,sender):handle(message))
    .then(value=>sendResponse({ok:true,value})).catch(error=>sendResponse({ok:false,
      error:/quota|QUOTA_BYTES/i.test(error.message)?'storage_quota_exceeded_export_required':error.message}));
  return true;
});
