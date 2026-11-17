/* Event-driven, durable orchestration. A suspended worker resumes at a saved stage. */
importScripts('config.js','core.js');
const C=MediaCore,P=MEDIA_CONFIG.platform,PREFIX=`media_${P}_`,VERSION=C.VERSION,ENGINE_BUILD='0.6.5-capture-wire';
let chain=Promise.resolve();const timers=new Map(),memoryFailures=new Map();
const serial=work=>{const next=chain.then(work,work);chain=next.catch(()=>{});return next;};
const read=async key=>(await chrome.storage.local.get(PREFIX+key))[PREFIX+key];
const put=async(key,value)=>chrome.storage.local.set({[PREFIX+key]:value});
const runKey=id=>'run_'+id;
const now=()=>new Date().toISOString();
const clone=x=>JSON.parse(JSON.stringify(x));
function log(run,event,detail={}) {run.logs.push({at:now(),event,...detail});if(run.logs.length>500){run.logs.shift();run.omitted_log_events=(run.omitted_log_events||0)+1;}}
async function save(run) {
  run.updated_at=now();
  run.runtime_ms=(run.prior_runtime_ms||0)+Math.max(0,Date.now()-Date.parse(run.session_started_at));
  const index=(await read('index'))||[],entry={run_id:run.run_id,username:run.target.username,status:run.status,updated_at:run.updated_at};
  const next=[...index.filter(v=>v.run_id!==run.run_id),entry];
  try{await chrome.storage.local.set({[PREFIX+runKey(run.run_id)]:run,[PREFIX+'index']:next});}
  catch(error){run.status='paused';run.reason='storage_write_failed';run.memory_only=true;memoryFailures.set(run.run_id,clone(run));unschedule(run.run_id);
    try{await chrome.storage.session.set({[PREFIX+'failure_'+run.run_id]:true});}catch{}
    try{await panel(run);}catch{}
    throw Error('保存失败，任务已停止推进；请立即导出备份，未落盘数据仅暂存在内存');}
}
function unschedule(id){clearTimeout(timers.get(id));timers.delete(id);}
async function gate(run) {
  const control=await read('control_'+run.run_id);
  if(control?.action==='stop'||control?.action==='pause')return {status:control.action==='stop'?'stopped':'paused',reason:'user_'+control.action};
  if(!(await chrome.storage.session.get(PREFIX+run.run_id))[PREFIX+run.run_id])return {status:'paused',reason:'browser_restart_requires_manual_resume'};
  if(run.version!==VERSION)return {status:'paused',reason:'version_changed_export_before_resume'};
  if(Date.now()-Date.parse(run.session_started_at)>Number(run.config.hours)*3600000)return {status:'paused',reason:'session_time_budget_reached'};
  if(await read('owner_'+run.list_tab)!==run.run_id||await read('account_'+run.target.key)!==run.run_id)return {status:'paused',reason:'task_ownership_changed'};
  return null;
}
async function release(run) {
  if(await read('owner_'+run.list_tab)===run.run_id)await chrome.storage.local.remove(PREFIX+'owner_'+run.list_tab);
  if(await read('account_'+run.target.key)===run.run_id)await chrome.storage.local.remove(PREFIX+'account_'+run.target.key);
  if(run.detail_tab&&await read('detail_owner_'+run.detail_tab)===run.run_id)await chrome.storage.local.remove(PREFIX+'detail_owner_'+run.detail_tab);
}
async function halt(run,status,reason) {run.status=status;run.reason=reason;log(run,'halt',{reason});await save(run);await release(run);unschedule(run.run_id);await panel(run);}
function schedule(id,delay=2500) {
  unschedule(id);
  timers.set(id,setTimeout(()=>serial(()=>tick(id)).catch(()=>{}),delay));
}
async function invoke(tabId,method,args) {
  const tab=await chrome.tabs.get(tabId),u=new URL(tab.url||'about:blank');
  if(!MEDIA_CONFIG.hosts.includes(u.hostname))throw Error('page_left_platform');
  let captured=null;
  if(['profile','list','detail','openDetail'].includes(method)) {
    const capture=P==='tiktok'?'MediaTikTokCapture':'MediaXCapture';
    await chrome.scripting.executeScript({target:{tabId},world:'MAIN',files:[P==='tiktok'?'tiktok_capture.js':'x_capture.js']});
    const responses=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',args:[args[0].username,method==='detail'?args[1]:'',VERSION,capture,method],func:(username,id,version,capture,method)=>{
      if(globalThis[capture].version!==version)throw Error('capture_reader_version_mismatch_refresh_page');
      return JSON.stringify({wire:'media_capture_v1',version,payload:globalThis[capture].read(username,id,method)});
    }});
    let wire;try{wire=JSON.parse(responses?.[0]?.result);}catch{}
    if(wire?.wire!=='media_capture_v1'||wire.version!==VERSION||!wire.payload?.diagnostic||wire.payload.diagnostic.version!==VERSION) {
      const error=Error('capture_bridge_unavailable');error.capture={engine_build:ENGINE_BUILD,method,frames:(responses||[]).map(r=>({frame_id:r.frameId,result_type:typeof r.result,error:r.error?String(r.error):''}))};throw error;
    }
    captured=wire.payload;
  }
  await chrome.scripting.executeScript({target:{tabId},files:['config.js','core.js',...MEDIA_CONFIG.reader_files,'platform_reader.js','page_ui.js']});
  const [result]=await chrome.scripting.executeScript({target:{tabId},args:[method,args,VERSION,captured],func:async(method,args,version,captured)=>{
    if(MediaReader.version!==version)throw Error('reader_version_mismatch');
    if(method==='geometry'||method==='restore_scroll') {
      const first=document.querySelector(MEDIA_CONFIG.platform==='tiktok'?'a[href*="/video/"],a[href*="/photo/"]':'article');
      let node=first?.parentElement;
      while(node&&!(node.scrollHeight>node.clientHeight+20&&/auto|scroll/.test(getComputedStyle(node).overflowY)))node=node.parentElement;
      node=node||document.scrollingElement;
      if(method==='restore_scroll'){if(node)node.scrollTop=args[0]?.top||0;return true;}
      return {top:node?.scrollTop||0,height:node?.scrollHeight||0,viewport:node?.clientHeight||0,visible:document.visibilityState==='visible',focus:document.hasFocus(),discarded:document.wasDiscarded===true,page_token:MediaPageUI.token};
    }
    if(method==='scroll') {
      const first=document.querySelector(MEDIA_CONFIG.platform==='tiktok'?'a[href*="/video/"],a[href*="/photo/"]':'article');
      let node=first?.parentElement;
      while(node&&!(node.scrollHeight>node.clientHeight+20&&/auto|scroll/.test(getComputedStyle(node).overflowY)))node=node.parentElement;
      node=node||document.scrollingElement;if(!node)throw Error('scroll_container_missing');
      node.scrollTop+=Math.max(500,node.clientHeight*.85);return true;
    }
    if(method==='panel'){MediaPageUI.render(args[0]);return true;}
    if(method==='detail')return await MediaReader.detail(args[0],args[1],captured);
    if(method==='profile'||method==='list')return await MediaReader[method](args[0],captured);
    return await MediaReader[method](...args,captured);
  }});
  const value=result?.result;
  if(captured&&value&&typeof value==='object') {
    value.capture=captured.diagnostic;
    if(value.row)value.row.evidence={...value.row.evidence,capture:captured.diagnostic,engine_build:ENGINE_BUILD};
  }
  return value;
}
function summary(run){return {run_id:run.run_id,platform:run.platform,username:run.target.username,status:run.status,reason:run.reason,stage:run.stage,
  counts:C.counts(run),checkpoint:C.checkpoint(run),segment:run.segment,segments:run.segments.length,updated_at:run.updated_at,last_progress_at:run.last_progress_at||'',version:run.version,
  segments_info:P==='x'?run.segments.map(s=>({key:s.since+'_'+s.until,since:s.since,until:s.until,status:s.status})):[]};}
async function panel(run){if(run.config.panel!==false)try{await invoke(run.list_tab,'panel',[summary(run)]);}catch{/* panel errors do not invalidate saved data */}}
function queueLinks(run,links) {
  const segment=run.segments[run.segment],known=new Set(run.queue.map(q=>q.id)),excluded=new Set(run.excluded_above||[]);let fresh=0;
  for(const link of links) {
    const p=C.post(P,link.url,run.target.username);
    if(link.author?.toLowerCase()!==run.target.key)throw Error('discovery_author_mismatch');
    if(!segment.seen.includes(p.id))segment.seen.push(p.id);
    if(excluded.has(p.id)||known.has(p.id))continue;
    known.add(p.id);fresh++;
    const entry={...p,created_at:C.time(link.created_at),text:link.text||'',status:'pending',attempts:0,pinned:!!link.pinned,discovered_at:now()};
    run.queue.push(entry);
    C.observe(run,{...link,...p,author:run.target.username,collected_at:link.collected_at||now(),created_at:link.created_at||'',
      text:link.text||'',text_status:link.text_status||'missing',type:link.type||p.type,metrics:link.metrics||{},source:link.source||'list_link'});
  }
  return fresh;
}
async function navigate(run,tabId,url) {
  const stopped=await gate(run);if(stopped){await halt(run,stopped.status,stopped.reason);return false;}
  run.pending_action={tab_id:tabId,url,at:now()};await save(run);
  if(await gate(run))return false;
  await chrome.tabs.update(tabId,{url});return true;
}
function atList(run,url,expectedURL=run.segments[run.segment]?.url) {
  try {
    const actual=new URL(url),expected=new URL(expectedURL);
    if(!MEDIA_CONFIG.hosts.includes(actual.hostname)||C.target(P,url).key!==run.target.key)return false;
    return P==='tiktok'?actual.pathname.replace(/\/$/,'').toLowerCase()==='/@'+run.target.key:
      actual.pathname==='/search'&&actual.searchParams.get('q')===expected.searchParams.get('q')&&actual.searchParams.get('f')==='live';
  }catch{return false;}
}
async function failDetail(run,reason,evidence={}) {
  const entry=run.queue.find(q=>q.id===run.current_id);
  if(!entry)throw Error('current_queue_entry_missing');
  entry.last_error=reason;run.detail_attempts++;run.consecutive_failures++;
  run.last_id=entry.id;log(run,'detail_failed',{id:entry.id,reason,evidence});
  if(entry.attempts<2){entry.status='pending';run.stage='select';}else{entry.status=run.rows[entry.id]?'partial':'failed';run.stage='discover';}
  run.current_id='';run.pending_action=null;run.wait_rounds=0;
  if(run.return_state){run.stage='return_list';run.return_requested=false;}
  await save(run);
  if(run.consecutive_failures>=3){await halt(run,'paused','consecutive_detail_failures');return;}
  schedule(run.run_id);
}
async function tick(id) {
  const run=await read(runKey(id));if(!run||run.status!=='running'||memoryFailures.has(id))return;
  if((await chrome.storage.session.get(PREFIX+'failure_'+id))[PREFIX+'failure_'+id])return;
  const stopped=await gate(run);if(stopped){await halt(run,stopped.status,stopped.reason);return;}
  try {
    const list=await chrome.tabs.get(run.list_tab);
    if(list.frozen||list.discarded){await halt(run,'paused','list_frozen_or_discarded');return;}
    if(run.stage==='profile'||run.stage==='wait_profile') {
      const tab=run.list_tab;
      if(run.stage==='profile') {run.stage='wait_profile';run.wait_rounds=0;await save(run);schedule(id);return;}
      try {
        const p=await invoke(tab,'profile',[run.target]);
        if(p?.barrier){await halt(run,'paused',p.barrier);return;}
        if(p?.pending){if(++run.wait_rounds<6){await save(run);schedule(id);return;}await halt(run,'paused','profile_fields_not_ready');return;}
        if(p)C.addProfile(run,p);
        run.stage='discover';run.pending_action=null;run.wait_rounds=0;await save(run);schedule(id);return;
      }catch(error){if(/refresh_page|stable_account_id|capture_bridge/.test(String(error.message)))throw error;if(++run.wait_rounds<4){await save(run);schedule(id);return;}if(P==='x'){await halt(run,'paused','profile_fields_not_ready');return;}run.stage='discover';log(run,'profile_unavailable',{reason:String(error.message)});await save(run);schedule(id);return;}
    }
    const segment=run.segments[run.segment];
    if(!segment){await halt(run,'paused','all_segments_attempted_coverage_unverified');return;}
    if(run.stage==='discover') {
      const valid=atList(run,list.url);
      if(!valid) {
        if(P==='tiktok'){await halt(run,'paused','return_to_profile_required');return;}
        segment.route_attempts=(segment.route_attempts||0)+1;
        if(segment.route_attempts>3){await halt(run,'paused','list_route_recovery_budget');return;}
        log(run,'restore_list',{url:segment.url});await navigate(run,run.list_tab,segment.url);await save(run);schedule(id);return;
      }
      const result=await invoke(run.list_tab,'list',[run.target]);
      if(result?.barrier){await halt(run,'paused',result.barrier);return;}
      if(P==='x'&&result?.needs_latest) {
        segment.latest_attempts=(segment.latest_attempts||0)+1;if(segment.latest_attempts>3){await halt(run,'paused','x_latest_not_confirmed');return;}
        await save(run);if(await gate(run))return;await invoke(run.list_tab,'selectLatest',[run.target]);schedule(id);return;
      }
      segment.latest_attempts=0;
      if(!result||!Array.isArray(result.links))throw Error('invalid_discovery_result');
      run.last_discovery={...result,links:result.links.slice(0,5),at:now()};
      run.available_ids=result.links.map(link=>link.id);
      if(result.profile)C.addProfile(run,result.profile);
      const beforeSeen=segment.seen.length,fresh=queueLinks(run,result.links),g=await invoke(run.list_tab,'geometry',[]);
      if(run.from_here&&!run.start_position){run.start_position={url:list.url,geometry:g,first_id:result.links[0]?.id||'',at:now()};}
      const bottom=g.height>0&&g.top+g.viewport>=g.height-5;
      const stable=run.last_geometry?.height===g.height&&run.last_geometry?.top===g.top&&run.last_geometry?.page_token===g.page_token;
      segment.idle=fresh||segment.seen.length>beforeSeen||!g.visible?0:(bottom&&stable?segment.idle+1:0);
      segment.hidden_waits=!g.visible&&!fresh?(segment.hidden_waits||0)+1:0;
      run.last_geometry=g;
      if(result.candidates>0&&!result.links.length){run.rejected_scans=(run.rejected_scans||0)+1;if(run.rejected_scans>=3){await halt(run,'paused','visible_cards_all_rejected');return;}}
      else run.rejected_scans=0;
      if(segment.hidden_waits>=8){await halt(run,'paused','background_list_not_advancing');return;}
      run.stage_errors=0;run.stage='select';await save(run);await panel(run);schedule(id);return;
    }
    if(run.stage==='select') {
      const limit=run.config.mode==='sample3'?3:run.config.mode==='sample10'?10:null;
      if(limit&&run.queue.filter(q=>['done','partial','failed'].includes(q.status)).length-(run.sample_baseline||0)>=limit){await halt(run,'paused','sample_budget_reached');return;}
      const entry=run.queue.find(q=>q.status==='pending'&&run.available_ids?.includes(q.id));
      if(entry) {
        run.current_id=entry.id;entry.status='reading';entry.attempts++;run.stage='open_detail';run.wait_rounds=0;
        run.return_state={id:entry.id,url:list.url,geometry:await invoke(run.list_tab,'geometry',[])};run.return_requested=false;
        await save(run);schedule(id);return;
      }
      if(segment.idle>=8||run.last_discovery?.empty_confirmed) {
        segment.status=run.last_discovery?.empty_confirmed?'visible_empty_search':'stalled_unverified';
        segment.finished_at=now();
        if(P==='tiktok'){await halt(run,'paused','list_stalled_history_end_unverified');return;}
        if(segment.seen.length>=300) {
          const children=C.splitSegment(segment,run.target);
          if(children.length){segment.status='split_parent_unverified';run.segments.splice(run.segment+1,0,...children);log(run,'split_dense_segment',{since:segment.since,until:segment.until});}
        }
        run.segment++;run.stage='discover';await save(run);schedule(id);return;
      }
      run.stage='discover';segment.scrolls++;run.scrolls++;await save(run);
      if(await gate(run))return;
      await invoke(run.list_tab,'scroll',[]);schedule(id,run.last_geometry?.visible?2500:15000);return;
    }
    if(run.stage==='open_detail') {
      if(await gate(run))return;
      await invoke(run.list_tab,'openDetail',[run.target,run.current_id]);
      run.stage='wait_detail';run.wait_rounds=0;await save(run);schedule(id);return;
    }
    if(run.stage==='return_list') {
      if(atList(run,list.url,run.return_state?.url)) {
        if(run.return_state)await invoke(run.list_tab,'restore_scroll',[run.return_state.geometry]);
        run.return_state=null;run.return_requested=false;run.wait_rounds=0;run.stage='discover';await save(run);schedule(id);return;
      }
      if(!run.return_state){await halt(run,'paused','return_to_profile_required');return;}
      if(!run.return_requested) {
        run.return_requested=true;run.wait_rounds=0;await save(run);
        if(await gate(run))return;
        await invoke(run.list_tab,'returnList',[run.target,run.return_state.id,run.return_state.url]);
      } else if(++run.wait_rounds>=4){await halt(run,'paused','return_to_profile_required');return;}
      await save(run);schedule(id);return;
    }
    if(run.stage==='wait_detail') {
      const entry=run.queue.find(q=>q.id===run.current_id);if(!entry)throw Error('current_entry_missing');
      const result=await invoke(run.list_tab,'detail',[run.target,entry.id]);
      if(result?.barrier){await halt(run,'paused',result.barrier);return;}
      if(!result?.row){if(++run.wait_rounds<4){await save(run);schedule(id);return;}await failDetail(run,result?.reason||'detail_not_ready',result?.evidence);return;}
      if(result.row.source==='tiktok_visible_detail'&&++run.wait_rounds<4){C.observe(run,result.row);await save(run);schedule(id);return;}
      const row=C.observe(run,result.row);if(result.profile)C.addProfile(run,result.profile);
      const success=!!row.created_at&&['full','empty'].includes(row.text_status);
      entry.status=success?'done':'partial';entry.last_error=success?'':'required_fields_incomplete';run.detail_attempts++;
      run.consecutive_failures=success?0:run.consecutive_failures+1;
      run.last_id=entry.id;run.current_id='';run.pending_action=null;run.stage='select';run.wait_rounds=0;
      run.stage='return_list';run.return_requested=false;
      run.stage_errors=0;run.last_progress_at=now();await save(run);await panel(run);
      if(run.consecutive_failures>=3){await halt(run,'paused','consecutive_detail_failures');return;}schedule(id);return;
    }
    throw Error('unknown_stage');
  }catch(error) {
    if(memoryFailures.has(id))return;
    const message=String(error.message||error);
    log(run,'stage_error',{stage:run.stage,reason:message,...(error.capture?{capture:error.capture}:{})});
    if(/login|captcha|verification|restricted|private|stable_account_id|account_mismatch|detail_resource_changed|page_left_platform|refresh_page|capture_bridge/.test(message)){await halt(run,'paused',message);return;}
    if(run.stage==='wait_detail'){
      let loading=false;try{loading=(await chrome.tabs.get(run.list_tab)).status==='loading';}catch{}
      if(loading&&(run.wait_rounds||0)<6){run.wait_rounds=(run.wait_rounds||0)+1;await save(run);schedule(id);return;}
      await failDetail(run,message);return;
    }
    run.stage_errors=(run.stage_errors||0)+1;
    if(run.stage_errors>=3){await halt(run,'paused',message);return;}
    await save(run);schedule(id,5000);
  }
}
async function start(message) {
  const tab=await chrome.tabs.get(message.tab_id),reference=message.reference||tab.url,run=C.create(P,reference,message.config);
  if(!run.config.entity?.trim())throw Error('请填写主体名称，例如：中国新闻网');
  const owner=await read('owner_'+tab.id),accountOwner=await read('account_'+run.target.key);
  for(const id of [owner,accountOwner].filter(Boolean)){const other=await read(runKey(id));if(other?.status==='running')throw Error('该标签页或账号已有运行批次，请先暂停');}
  // Current-position starts are TikTok-only; X requires its date search segment.
  if(run.from_here&&P==='x')throw Error('X请使用日期分段任务，避免跳过未覆盖日期');
  if(P==='tiktok'&&(C.target(P,tab.url).key!==run.target.key||new URL(tab.url).pathname.replace(/\/$/,'').toLowerCase()!=='/@'+run.target.key))throw Error('请在目标TikTok账号主页启动，插件将在当前标签页采集');
  if(P==='x'&&C.target(P,tab.url).key!==run.target.key)throw Error('请在目标X账号主页或单账号日期搜索页启动');
  run.navigation_mode='current_tab';
  log(run,'runtime',{engine_build:ENGINE_BUILD,manifest:chrome.runtime.getManifest().version});
  run.list_tab=tab.id;run.status='running';run.reason='started';
  if(run.from_here) {
    if(C.target(P,tab.url).key!==run.target.key)throw Error('当前位置与目标账号不符');
    const initial=await invoke(tab.id,'list',[run.target]);
    const [position]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>[...document.querySelectorAll('a[href*="/video/"],a[href*="/photo/"]')].map(a=>({url:a.href,top:a.getBoundingClientRect().top,bottom:a.getBoundingClientRect().bottom})).filter(r=>r.bottom<0)});
    run.excluded_above=(position?.result||[]).flatMap(r=>{try{return [C.post(P,r.url,run.target.username).id];}catch{return [];}});
    run.start_position={url:tab.url,at:now(),above_excluded:run.excluded_above.length};
    if(initial?.barrier)throw Error(initial.barrier);
  }
  await put('owner_'+tab.id,run.run_id);await put('account_'+run.target.key,run.run_id);
  await put('control_'+run.run_id,{action:'run',at:now()});await chrome.storage.session.set({[PREFIX+run.run_id]:true});
  await save(run);await chrome.alarms.create('media_watchdog',{periodInMinutes:.5});schedule(run.run_id,0);return summary(run);
}
async function command(message) {
  if(message.type==='start')return start(message);
  if(message.type==='list')return await read('index')||[];
  if(message.type==='legacy') {
    const all=await chrome.storage.local.get(null),entries=Object.fromEntries(Object.entries(all).filter(([key])=>key==='tiktok_probe_v1_snapshots'||/^history_discovery_v1_(tiktok|x)_/.test(key)&&!key.endsWith('_stop')));
    return {schema:'legacy_media_storage_v1',exported_at:now(),entries};
  }
  if(message.type==='get'){let run=memoryFailures.get(message.run_id)||await read(runKey(message.run_id));if(!run)throw Error('批次不存在');
    if((await chrome.storage.session.get(PREFIX+'failure_'+run.run_id))[PREFIX+'failure_'+run.run_id])run={...run,status:'paused',reason:'storage_write_failed'};
    return message.full?run:summary(run);}
  if(message.type==='diagnose') {
    const tab=await chrome.tabs.get(message.tab_id),account=C.pageTarget(P,message.reference||tab.url);
    const report={schema:'media_diagnostic_v1',at:now(),engine:VERSION,engine_build:ENGINE_BUILD,manifest:chrome.runtime.getManifest().version,
      tab_id:tab.id,url:tab.url,target:account,owner:await read('owner_'+tab.id)||'',storage_bytes:await chrome.storage.local.getBytesInUse(null)};
    let own;try{own=C.post(P,tab.url,account.username);}catch{}
    try{report.reader=await invoke(tab.id,own?'detail':'list',own?[account,own.id]:[account]);}
    catch(error){report.error=String(error.message||error);if(error.capture)report.capture=error.capture;}
    return report;
  }
  if(message.type==='open_export'){await chrome.tabs.create({url:chrome.runtime.getURL('popup.html')+'?run='+encodeURIComponent(message.run_id),active:true});return true;}
  if(message.type==='import') {
    if(message.config?.mode==='here')throw Error('导入请选试采或正式模式；当前位置起采仅用于网页新任务');
    const fresh=C.create(P,message.reference,message.config);fresh.status='paused';fresh.reason='imported_backup';
    for(const group of message.groups||[]) {
      if(group.platform&&group.platform!==P)throw Error('不能跨平台导入');
      for(const row of group.rows||[]){C.observe(fresh,row);const own=C.post(P,row.url,fresh.target.username);if(!fresh.queue.some(q=>q.id===own.id))fresh.queue.push({...own,created_at:row.created_at,text:row.text,status:'partial',attempts:0});}
      for(const p of group.profiles||[])C.addProfile(fresh,p);
      for(const link of group.links||[]){const own=C.post(P,link.url,fresh.target.username);if(!fresh.queue.some(q=>q.id===own.id))fresh.queue.push({...own,status:'pending',attempts:0,created_at:link.created_at||'',text:link.text||''});}
    }
    for(const entry of fresh.queue){const row=fresh.rows[entry.id];if(row)entry.status=row.created_at&&['full','empty'].includes(row.text_status)?'done':'partial';}
    await save(fresh);return summary(fresh);
  }
  const run=memoryFailures.get(message.run_id)||await read(runKey(message.run_id));if(!run)throw Error('批次不存在');
  if(message.type==='pause'||message.type==='stop'){await halt(run,message.type==='stop'?'stopped':'paused','user_'+message.type);return summary(run);}
  if(message.type==='show_detail'){if(run.list_tab)await chrome.tabs.update(run.list_tab,{active:true});return summary(run);}
  if(['resume','retry','skip','retry_segment'].includes(message.type)) {
    if(run.version!==VERSION&&!(['0.6.0','0.6.1','0.6.2','0.6.3','0.6.4'].includes(run.version)&&run.schema===C.SCHEMA))throw Error('请先导出旧版本批次；需要明确迁移后再恢复');
    if(message.entity?.trim())run.config.entity=message.entity.trim();
    if(!run.config.entity?.trim())throw Error('请先补填主体名称，再恢复原批次');
    let tab=await chrome.tabs.get(message.tab_id);
    if(tab.url?.startsWith(chrome.runtime.getURL(''))&&run.list_tab)tab=await chrome.tabs.get(run.list_tab);
    if(!MEDIA_CONFIG.hosts.includes(new URL(tab.url).hostname))throw Error('请先打开当前平台的账号或搜索页');
    for(const key of ['owner_'+tab.id,'account_'+run.target.key]){const id=await read(key),other=id&&await read(runKey(id));if(id!==run.run_id&&other?.status==='running')throw Error('该标签页或账号由另一个批次占用');}
    const interrupted=run.queue.find(q=>q.id===run.current_id);if(interrupted?.status==='reading')interrupted.status='pending';
    const previousList=run.list_tab,previousDetail=run.detail_tab;run.list_tab=tab.id;
    if(message.type==='retry_segment') {
      const index=run.segments.findIndex(s=>s.since+'_'+s.until===message.segment_key);
      if(P!=='x'||index<0)throw Error('找不到所选日期段');
      run.segment=index;run.segments[index].status='pending';run.segments[index].idle=0;run.segments[index].hidden_waits=0;run.current_id='';run.stage='discover';
    } else if(message.type==='retry') {
      const entry=run.queue.find(q=>q.id===(message.content_id||C.checkpoint(run)?.id));if(!entry)throw Error('找不到重试作品');
      entry.status='pending';entry.attempts=0;run.queue=[entry,...run.queue.filter(q=>q.id!==entry.id)];run.current_id='';run.stage='select';
    } else if(message.type==='skip') {
      const skipId=run.current_id||C.checkpoint(run)?.id,entry=run.queue.find(q=>q.id===skipId);
      if(entry&&entry.status!=='done')entry.status='skipped';if(skipId)run.last_id=skipId;run.current_id='';run.stage='select';
    } else if(run.current_id) {const entry=run.queue.find(q=>q.id===run.current_id);if(entry)entry.status='pending';run.current_id='';run.stage='select';}
    {
      let onList=false;try{onList=C.target(P,tab.url).key===run.target.key;}catch{}
      if(!onList&&!run.return_state)throw Error('请先手动回到目标账号主页或日期搜索列表再恢复');
      if(!onList&&C.post(P,tab.url,run.target.username).id!==run.return_state.id)throw Error('当前作品与断点不符，请回到目标账号主页恢复');
      run.detail_tab=null;run.navigation_mode='current_tab';run.available_ids=[];run.stage=onList?'discover':'return_list';run.return_requested=false;
      if(P==='x'&&onList&&!run.profiles.some(p=>typeof p.bio==='string'&&typeof p.verified==='boolean'&&p.followers?.precision&&p.followers.precision!=='missing')) {
        if(new URL(tab.url).pathname.replace(/\/$/,'').toLowerCase()!=='/'+run.target.key)throw Error('账号资料尚未采到，请先回到目标X账号主页，再恢复原批次');
        run.stage='profile';run.wait_rounds=0;
      }
    }
    if(run.version!==VERSION){
      if(P==='tiktok')for(const entry of run.queue)if(entry.status==='partial'&&['detail_structure_unavailable','required_fields_incomplete'].includes(entry.last_error)){entry.status='pending';entry.attempts=0;}
      if(P==='x')for(const entry of run.queue){const row=run.rows[entry.id];if(entry.status==='done'&&row&&(row.metrics?.views?.precision==='missing'||row.type?.includes('视频')&&row.metrics?.plays?.precision==='missing'||row.tags?.some(t=>/[.,。！？!?]$/.test(t)))){entry.status='pending';entry.attempts=0;entry.last_error='upgrade_field_recheck';}}
      log(run,'migrated',{from:run.version,to:VERSION});run.version=VERSION;run.versions={engine:VERSION,reader:VERSION,exporter:VERSION};
    }
    run.sample_baseline=run.queue.filter(q=>['done','partial','failed'].includes(q.status)).length;
    run.consecutive_failures=0;run.stage_errors=0;run.prior_runtime_ms=run.runtime_ms||0;run.session_started_at=now();run.status='running';run.reason='resumed';
    if(!run.segments[run.segment]){run.segment=run.segments.findIndex(s=>s.status==='pending');if(run.segment<0){run.segment=run.segments.length-1;run.segments[run.segment].idle=0;run.segments[run.segment].status='pending';}run.stage='discover';}
    await release({...run,list_tab:previousList,detail_tab:previousDetail});
    await put('owner_'+tab.id,run.run_id);await put('account_'+run.target.key,run.run_id);
    await put('control_'+run.run_id,{action:'run',at:now()});await chrome.storage.session.set({[PREFIX+run.run_id]:true});
    memoryFailures.delete(run.run_id);await chrome.storage.session.remove(PREFIX+'failure_'+run.run_id);await save(run);await chrome.alarms.create('media_watchdog',{periodInMinutes:.5});schedule(run.run_id,0);return summary(run);
  }
  throw Error('未知命令');
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id)return false;
  // A stop flag is persisted outside the work queue, so an in-flight read cannot erase it.
  const control=['pause','stop'].includes(message.type)&&message.run_id?put('control_'+message.run_id,{action:message.type,at:now()}):Promise.resolve();
  control.then(()=>serial(()=>command(message))).then(value=>reply({ok:true,value})).catch(error=>reply({ok:false,error:String(error.message||error)}));return true;
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='media_watchdog')serial(async()=>{for(const entry of await read('index')||[])if(entry.status==='running')await tick(entry.run_id);}).catch(()=>{});});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==='complete')serial(async()=>{const id=await read('owner_'+tabId)||await read('detail_owner_'+tabId);if(id)await tick(id);}).catch(()=>{});});
chrome.tabs.onRemoved.addListener(tabId=>serial(async()=>{const id=await read('owner_'+tabId),run=id&&await read(runKey(id));if(run?.status==='running')await halt(run,'paused','list_tab_closed');}).catch(()=>{}));
chrome.runtime.onStartup.addListener(()=>serial(async()=>{for(const entry of await read('index')||[]){const run=await read(runKey(entry.run_id));if(run?.status==='running'){await put('control_'+run.run_id,{action:'pause',at:now()});await halt(run,'paused','browser_restart_requires_manual_resume');}}}).catch(()=>{}));
chrome.runtime.onInstalled.addListener(()=>serial(async()=>{for(const entry of await read('index')||[]){const run=await read(runKey(entry.run_id));if(run?.status==='running')await halt(run,'paused','extension_reloaded_requires_manual_resume');}}).catch(()=>{}));
chrome.alarms.get('media_watchdog').then(value=>{if(!value)return chrome.alarms.create('media_watchdog',{periodInMinutes:.5});}).catch(()=>{});
