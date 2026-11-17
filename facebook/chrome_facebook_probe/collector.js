"use strict";
// Runs in the isolated content-script world. No popup lifetime dependency.
if (!globalThis.localPandaCollector) globalThis.localPandaCollector = (() => {
  const ACTIVE='lp_fb_active',prefix='lp_fb_run_',owner=crypto.randomUUID();
  const presets=[{start_date_bjt:'2025-10-17',end_date_bjt:'2026-10-17',max_posts:3,max_scrolls:5,max_runtime_ms:900000},
    {start_date_bjt:'2025-10-17',end_date_bjt:'2026-10-17',max_posts:10,max_scrolls:20,max_runtime_ms:900000},
    {start_date_bjt:'2025-10-17',end_date_bjt:'2026-10-17',max_posts:null,max_scrolls:null,max_runtime_ms:21600000,
      collection_scope:'formal',display_timezone_policy:'user_assumed_Asia_Shanghai',comment_expansion_limit:50}];
  let config=presets[0];
  const legacyFormal={...presets[2]};
  presets[2]={...legacyFormal,date_boundary_policy:'five_old_two_growth_v1'};presets.push(legacyFormal);
  let state=null,busy=false,launching=false,paused=false,stop=false,interruptedByNavigation=false,writeAt=0,panelStatus,panelCheckpoint,writes=Promise.resolve(),storageError='',currentRow=null,baselineRow=null;
  const now=()=>new Date().toISOString();
  const delay=ms=>globalThis.localPandaTiming?.delay(ms)??new Promise(resolve=>setTimeout(resolve,ms));
  async function timedPhase(row,name,work){
    const wall=performance.now(),active=globalThis.localPandaTiming?.clock()??wall;
    state.current_phase={name,post_key:state.current_post||'',started_at_utc:now()};
    try{return await work();}finally{
      const phases=JSON.parse(row.phase_timing_json||'[]');
      phases.push({name,wall_ms:Math.round(performance.now()-wall),active_wait_ms:Math.round((globalThis.localPandaTiming?.clock()??performance.now())-active),
        visibility:document.visibilityState,ended_at_utc:now()});
      row.phase_timing_json=JSON.stringify(phases);state.last_phase=state.current_phase;state.current_phase=null;
    }
  }
  function recordLifecycle(event,save=true){
    if(!state||!busy)return;
    state.lifecycle_snapshot={...(globalThis.localPandaTiming?.snapshot()||{}),event,at_utc:now(),post_key:state.current_post||'',phase:state.current_phase?.name||''};
    state.lifecycle_events=state.lifecycle_events||[];state.lifecycle_events.push(state.lifecycle_snapshot);
    state.lifecycle_events=state.lifecycle_events.slice(-200);
    log('page_lifecycle',JSON.stringify(state.lifecycle_snapshot));if(save)persist(false).catch(()=>{});
  }
  for(const event of ['visibilitychange','freeze','resume'])document.addEventListener(event,()=>recordLifecycle(event));
  for(const event of ['focus','blur','pageshow'])addEventListener(event,()=>recordLifecycle(event));
  async function supervisorMessage(type,extra={}) {
    if(config.collection_scope!=='formal'||typeof chrome.runtime?.sendMessage!=='function')return {ok:false,error:'supervisor_unavailable'};
    try{return await chrome.runtime.sendMessage({type,run_id:state.run_id,...extra});}
    catch(error){return {ok:false,error:String(error.message||error)};}
  }
  function requestStop() {
    stop=true;
    if(state){state.user_stop_requested=true;supervisorMessage('lp_fb_disarm');return persist().catch(()=>{});}
  }
  const classifyPublicationTime=(row,settings=config)=>localPandaPublicationTime(row,settings);
  function observeBoundary(row,key) {
    if(!config.date_boundary_policy)return;
    const fact=classifyPublicationTime(row);row.date_window_evidence_json=JSON.stringify(fact);
    const boundary=state.date_boundary;
    if(boundary.seen.includes(key))return;
    boundary.seen.push(key);
    const pinned=row.pinned_post_observed===true||row.pinned_post_observed==='true';
    if(pinned){log('date_boundary_ignored_pinned',key);return;}
    if(fact.range==='in_range')boundary.in_range_seen=true;
    if(fact.range!=='before_start'||!boundary.in_range_seen||(boundary.last_old_ms!==null&&fact.timestamp_ms>boundary.last_old_ms)) {
      boundary.old_keys=[];boundary.confirmed_growths=0;boundary.last_old_ms=null;
    }
    if(fact.range==='before_start'&&boundary.in_range_seen) {boundary.old_keys.push(key);boundary.last_old_ms=fact.timestamp_ms;}
    log('date_window_classified',JSON.stringify({post_key:key,...fact,old_streak:boundary.old_keys.length,confirmed_growths:boundary.confirmed_growths}));
  }
  const log=(action,detail='')=>state.logs.push({at_utc:now(),action,detail});
  const status=message=>{if(panelStatus)panelStatus.textContent=message;if(panelCheckpoint&&state)localPandaCheckpoint.render(panelCheckpoint,state);};
  function preserveObservation() {
    if(!currentRow)return;
    const row=currentRow,old=baselineRow;
    const keepOld=old?.raw_detail_evidence_json&&(!row.raw_detail_evidence_json||
      (old.comment_sort_status==='all_comments_visible_selected'&&row.comment_sort_status!=='all_comments_visible_selected')||
      (Number(old.visible_comment_records_saved||0)>Number(row.visible_comment_records_saved||0)&&row.comment_sort_status!=='all_comments_visible_selected'));
    state.rows[row.post_url]=keepOld?{...old,latest_attempt_status:row.processing_status,
      latest_attempt_stop_reason:row.collection_stop_reason||'',
      latest_attempt_evidence_json:JSON.stringify({...row,previous_attempt_evidence_json:undefined})}:row;
  }
  async function persist(force=true) {
    preserveObservation();
    if(storageError)throw new Error(storageError);
    if(!force&&Date.now()-writeAt<1000)return;
    state.checkpoint_summary=localPandaCheckpoint.summary(state);
    if(panelCheckpoint)localPandaCheckpoint.render(panelCheckpoint,state);
    state.heartbeat=Date.now();state.updated_at_utc=now();
    state.lifecycle_snapshot={...(globalThis.localPandaTiming?.snapshot()||{}),at_utc:now(),post_key:state.current_post||'',phase:state.current_phase?.name||''};
    const data={[prefix+state.run_id]:JSON.parse(JSON.stringify(state)),[ACTIVE]:state.run_id};
    try {writes=writes.catch(()=>{}).then(()=>{if(storageError)throw new Error(storageError);return chrome.storage.local.set(data);});await writes;writeAt=Date.now();}
    catch(error){storageError='storage_write_failed';status('本地保存失败，已停止；请用网页面板导出内存中的数据。');throw new Error(storageError);}
  }
  async function gate() {
    const check=()=>{
      const reason=page.restriction();if(reason)throw new Error(reason);
      if(storageError)throw new Error(storageError);
      if(interruptedByNavigation)throw new Error('page_navigation_interrupted');
      if(stop)throw new Error('user_stopped');
      if(Date.now()-state.started_clock>config.max_runtime_ms)throw new Error('runtime_limit_reached');
    };
    check();
    while(paused) {
      await delay(250);check();await persist(false);
    }
  }
  const createPage=()=>localPandaPageReader({gate,commentExpansionLimit:()=>config.comment_expansion_limit||5,checkpoint:async(row,{force=false}={})=>{
    currentRow=row;
    if(force&&state.source_cursor)state.source_cursor.scroll_top=scrollY;
    if(force&&row.comment_entry_before_click_json)state.pending_action={action:'open_comment_detail',post_url:row.post_url,at_utc:now()};
    await persist(force);
  }});
  let page=createPage();
  addEventListener('pagehide',()=>{
    if(!busy||!state)return;
    interruptedByNavigation=true;state.paused_before_navigation=paused;state.status=paused?'paused':'interrupted';state.stop_reason='page_navigation_interrupted';
    state.navigation_evidence=page.navigationEvidence();log('page_navigation_interrupted',state.current_post||'');
    // Best effort only; the forced pre-click checkpoint is the durable fallback.
    persist().catch(()=>{});
  });
  async function download(kind='posts') {
    if(!state){status('暂无已保存批次。');return;}
    let evidence={};try{const all=await chrome.storage.local.get(null);evidence={supervisor_binding_at_export:Object.entries(all).filter(([k,b])=>k==='lp_fb_supervisor_'+b?.tab_id&&b.run_id===state.run_id).map(([,b])=>b),background_supervision:all['lp_fb_background_'+state.run_id]||[]};}catch{}
    if(kind==='raw')localPandaRawExport({...state,...evidence});else localPandaReadable.download({...state,...evidence},kind);
  }
  function panel() {
    document.getElementById('local-panda-collector-panel')?.remove();
    const box=document.createElement('section');box.id='local-panda-collector-panel';
    box.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483647;width:300px;background:white;color:#172b3a;padding:16px;border:2px solid #26765c;border-radius:10px;font:14px/1.5 system-ui;box-shadow:0 4px 24px #0004';
    const title=document.createElement('strong');title.textContent='Facebook 自适应采集 v0.6.9 · '+state.target.name;box.append(title);
    const hide=document.createElement('button');hide.type='button';hide.textContent='×';
    hide.setAttribute('aria-label','隐藏采集面板（不停止任务）');hide.title='隐藏面板，不停止任务；可在扩展中重新显示';
    hide.style.cssText='float:right;font-size:20px;cursor:pointer';hide.onclick=()=>{box.hidden=true;};box.append(hide);
    panelStatus=document.createElement('p');panelStatus.textContent=config.collection_scope==='formal'?`正式采集：北京时间${config.start_date_bjt}至${config.end_date_bjt}（含首尾）；确认越过起始日后停止。每次最长6小时，可恢复。`:`最多${config.max_posts}帖；最多${config.max_scrolls}次滚动，不代表完整期间覆盖。`;box.append(panelStatus);
    panelCheckpoint=document.createElement('section');panelCheckpoint.style.cssText='padding:8px 0;border-top:1px solid #ccc;font-size:13px';
    localPandaCheckpoint.render(panelCheckpoint,state);box.append(panelCheckpoint);
    for(const [label,action] of [['暂停/继续',()=>{if(!busy)return;paused=!paused;state.status=paused?'paused':'running';persist().catch(()=>{});status(paused?'已暂停，可导出已存数据。':'继续采集…');}],
      ['停止',()=>{if(!busy){supervisorMessage('lp_fb_disarm');status('任务已停止，可导出CSV或隐藏面板。');return;}requestStop();status('正在停止并保留已有数据…');}],['导出帖子表',()=>download('posts')],['导出评论表',()=>download('comments')],['原始证据',()=>download('raw')]]) {
      const b=document.createElement('button');b.textContent=label;b.style.marginRight='8px';b.onclick=()=>Promise.resolve().then(action).catch(error=>status('操作失败，已存数据保留：'+String(error.message||error)));box.append(b);
    }
    document.body.append(box);
  }
  async function execute(mode) {
    let reason='bounded_sample_limit_reached';
    try {
      await gate();
      if(mode!=='dialog'&&state.manual_resume_strategy==='in_place'&&state.resume_cursor&&page.dialogs().length){
        const open=page.currentDialogItem();
        if(!open||open.key!==state.resume_cursor.post_key)throw new Error('请先关闭当前详情或其他弹窗，再原地继续；原批次和断点已保留');
        page.bindDetail(open);
        const confirmed=page.matchingDialog(open);
        if(!confirmed)throw new Error('当前弹窗归属未能确认，请手动关闭后继续');
        await page.close(confirmed);
        log('manual_resume_closed_checkpoint_dialog',open.key);
      }
      if(mode!=='dialog'&&page.dialogs().length)throw new Error('close_existing_dialog_before_start');
      if(mode==='profile'){state.profile=await page.readProfile();await persist();reason='profile_snapshot_only';return;}
      state.profile=state.profile||{};
      if(mode!=='dialog'&&page.dialogs().length)throw new Error('close_existing_dialog_before_start');
      let performed=0,empty=0,emptyEpoch=null,rejectedScans=0,adaptiveRebuilds=0;const attemptedThisRun=new Set();
      // Recovery walks the lazy-loaded feed to the saved resource ID; pixels are only a hint.
      if(state.resume_cursor){
        const cursor=state.resume_cursor,index=state.discovered.indexOf(cursor.post_key);
        if(index>=0)for(const key of state.discovered.slice(0,index))attemptedThisRun.add(key);
        log('resume_relocation_started',JSON.stringify({...cursor,start_scroll_top:scrollY,strategy:state.manual_resume_strategy||'automatic'}));await persist();
      }
      while(config.max_posts===null||performed<config.max_posts) {
        await gate();
        if(mode!=='dialog'&&!page.isProfile())throw new Error('profile_not_restored_before_next_post');
        const openItem=mode==='dialog'?page.currentDialogItem():null;
        let found=mode==='dialog'?{error:'',items:openItem?[openItem]:[]}:page.discover();
        if(mode!=='dialog'){
          const mismatch=!localPandaTarget.same(page.getTarget()?.profile_url,state.target);
          const rejected=!found.items.length&&(found.evidence?.rendered_message_cards>0||found.error==='posts_section_not_found');
          if((mismatch||rejected)&&adaptiveRebuilds<2&&localPandaTarget.same(location.href,state.target)&&!page.dialogs().length){
            const before=found.evidence;status('正在自适应识别帖子：等待结构加载并重建读取器…');
            await persist();await delay(1200);await gate();
            if(!page.dialogs().length&&localPandaTarget.same(location.href,state.target)){
              page=createPage();page.setTarget(state.target);found=page.discover();adaptiveRebuilds++;
              const event={action:'rebuild_reader',attempt:adaptiveRebuilds,at_utc:now(),
                before,after:found.evidence,recovered:found.items.length>0};
              state.adaptive_recovery_events=[...(state.adaptive_recovery_events||[]),event].slice(-20);
              log('adaptive_discovery_recovery',JSON.stringify(event));
            }
          }
          state.last_discovery_evidence={...found.evidence,at_utc:now()};
          if(!localPandaTarget.same(page.getTarget()?.profile_url,state.target))throw new Error('post_discovery_target_binding_mismatch');
          rejectedScans=!found.items.length&&(found.evidence?.rendered_message_cards>0||found.error==='posts_section_not_found')?rejectedScans+1:0;
          if(rejectedScans>=3){log('post_discovery_rejected',JSON.stringify(state.last_discovery_evidence));throw new Error('post_discovery_rejected_requires_review');}
          state.adaptive_discovery=state.adaptive_discovery||{revision:'bounded_header_strategies_v1',strategies:{},seen_keys:[]};
          for(const candidate of found.items)if(!state.adaptive_discovery.seen_keys.includes(candidate.key)){
            const strategy=candidate.discovery_strategy||'article_header';
            state.adaptive_discovery.strategies[strategy]=(state.adaptive_discovery.strategies[strategy]||0)+1;
            state.adaptive_discovery.seen_keys.push(candidate.key);
          }
        }
        for(const item of found.items)if(!state.discovered.includes(item.key))state.discovered.push(item.key);
        let item;
        if(mode==='dialog') {
          const matches=found.items.filter(x=>page.matchingDialog(x));
          if(matches.length!==1)throw new Error('current_dialog_identity_not_uniquely_confirmed');
          item=matches[0];
        } else if(state.resume_cursor){
          const cursor=state.resume_cursor,target=found.items.find(x=>x.key===cursor.post_key);
          if(target){
            for(const earlier of found.items.slice(0,found.items.indexOf(target)))attemptedThisRun.add(earlier.key);
            target.node.scrollIntoView({block:'center',behavior:'instant'});
            log('resume_post_relocated',JSON.stringify({post_key:target.key,observed_scroll_top:scrollY,saved_scroll_top:cursor.scroll_top}));
            state.resume_cursor=null;await persist();
            item=eligible(target)?target:found.items.find(eligible);
          } else status(`正在重新定位中断帖 ${cursor.post_key}；已保存${Object.keys(state.rows).length}帖…`);
        } else item=found.items.find(eligible);
        function eligible(x){return !(state.position_excluded_keys||[]).includes(x.key)&&!attemptedThisRun.has(x.key)&&!state.completed.includes(x.key)&&!(state.supervisor_skipped_keys||[]).includes(x.key)&&(state.attempts[x.key]||0)<2&&
          !!(config.max_posts===null||state.rows[x.url]||Object.keys(state.rows).length<config.max_posts);}
        if(config.date_boundary_policy&&!state.resume_cursor)for(const saved of found.items) {
          if(eligible(saved)||!state.rows[saved.url])break;
          observeBoundary(state.rows[saved.url],saved.key);
        }
        if(!item) {
          if(!state.resume_cursor&&config.date_boundary_policy&&state.date_boundary.old_keys.length>=5&&state.date_boundary.confirmed_growths>=2) {reason='date_window_start_boundary_confirmed';break;}
          if(config.max_scrolls!==null&&state.scrolls-(state.execution_scroll_start||0)>=config.max_scrolls){reason=found.error||'scroll_limit_reached';break;}
          if(config.max_posts!==null&&Object.keys(state.rows).length>=config.max_posts){reason='bounded_sample_limit_reached';break;}
          const known=[...state.discovered];
          status(state.resume_cursor?`正在重新定位中断帖 ${state.resume_cursor.post_key}；滚动加载第${state.scrolls+1}次…`:`等待加载下一批帖子；已保存${Object.keys(state.rows).length}帖，滚动${state.scrolls+1}/${config.max_scrolls??'不限'}次…`);
          const geometry=()=>{const el=document.scrollingElement||document.documentElement;return {top:el.scrollTop,height:el.scrollHeight,viewport:el.clientHeight||innerHeight};};
          const before=geometry();
          window.scrollBy({left:0,top:Math.max(600,innerHeight*0.8),behavior:'instant'});state.scrolls++;log('scroll_feed',String(state.scrolls));
          const growth=await page.waitForFeedGrowth(known);
          const after=growth.items||[];
          if(config.date_boundary_policy&&state.date_boundary.old_keys.length>=5&&after.some(next=>!known.includes(next.key)))state.date_boundary.confirmed_growths++;
          for(const next of after)if(!state.discovered.includes(next.key))state.discovered.push(next.key);
          const progressed=growth.status==='new_post_ids'||(!state.resume_cursor&&after.some(eligible));
          const position=geometry(),moved=position.top>before.top+2;
          const atBottom=position.top+position.viewport>=position.height-4;
          const layoutChanged=Math.abs(position.height-before.height)>4;
          log('feed_growth',JSON.stringify({status:growth.status,visible_post_keys:after.map(x=>x.key),
            before_scroll:before,after_scroll:position,moved,at_bottom:atBottom,layout_changed:layoutChanged,
            feed_observation:growth.feed_observation}));
          // An unchanged hidden feed is not evidence of exhaustion. Keep the run
          // alive, with stop/pause/deadline gates, without spending sample scrolls.
          const observation=growth.feed_observation;
          if(!progressed&&!moved&&!layoutChanged&&observation?.can_confirm_end!==true){
            empty=0;emptyEpoch=null;state.scrolls=Math.max(0,state.scrolls-1);
            if(!state.background_feed_wait){
              state.background_feed_wait={started_at_utc:now(),reason:'feed_not_loaded_while_hidden_or_suspended',
                source_post:state.source_cursor?.post_key||'',observation};
              log('background_feed_wait_started',JSON.stringify(state.background_feed_wait));
            }
            status(`后台暂未加载新帖，已保留${Object.keys(state.rows).length}帖；等待后重试，不判定采集结束。`);
            await persist();
            const until=Date.now()+15000,epoch=globalThis.localPandaTiming?.snapshot().lifecycle_epoch;
            while(Date.now()<until){
              await delay(1000);await gate();
              if(document.visibilityState==='visible'&&globalThis.localPandaTiming?.snapshot().lifecycle_epoch!==epoch)break;
            }
            continue;
          }
          if(state.background_feed_wait){
            log('background_feed_wait_finished',JSON.stringify({started_at_utc:state.background_feed_wait.started_at_utc,
              ended_at_utc:now(),progressed,moved,layoutChanged,visible:document.visibilityState}));
            state.background_feed_wait=null;
          }
          // Unchanged IDs while travelling through already-loaded tall posts do
          // not establish exhaustion. Count only stationary, stable attempts.
          const epoch=observation?.final?.lifecycle_epoch;
          if(emptyEpoch!==epoch)empty=0;
          empty=progressed||moved||layoutChanged||observation?.can_confirm_end!==true?0:empty+1;
          emptyEpoch=epoch;await persist();
          if(empty>=(config.collection_scope==='formal'?6:2)){
            const boundaryReached=!state.resume_cursor&&config.date_boundary_policy&&state.date_boundary.old_keys.length>=5&&atBottom&&!found.error;
            if(boundaryReached)state.date_boundary.stable_feed_end_observed=true;
            reason=state.resume_cursor?'resume_post_not_relocated':boundaryReached?'date_window_start_boundary_confirmed':found.error||(atBottom?'no_new_content_observed':'feed_scroll_not_advancing');break;
          }continue;
        }
        empty=0;emptyEpoch=null;
        if(state.background_feed_wait){
          log('background_feed_wait_finished',JSON.stringify({ended_at_utc:now(),reason:'post_available',post_key:item.key}));
          state.background_feed_wait=null;
        }
        performed++;attemptedThisRun.add(item.key);state.attempts[item.key]=(state.attempts[item.key]||0)+1;
        baselineRow=state.rows[item.url]?JSON.parse(JSON.stringify(state.rows[item.url])):null;
        if(baselineRow&&!state.observations.some(old=>old.post_url===baselineRow.post_url&&old.collected_at_utc===baselineRow.collected_at_utc&&old.version===baselineRow.version))
          state.observations.push(baselineRow);
        const row=page.snapshot(item.node,item,baselineRow?.sample_index||Object.keys(state.rows).length+1),position=scrollY;
        if(Object.keys(state.profile).length)row.raw_profile_evidence_json=JSON.stringify(state.profile);row.run_id=state.run_id;
        row.collection_mode=mode==='dialog'?'current_open_dialog':'detail_cycle';
        if(mode==='dialog')row.manual_dialog_identity_source=item.identity_source;
        if(config.display_timezone_policy)row.publication_time_timezone_policy=config.display_timezone_policy;
        if(baselineRow)row.previous_attempt_evidence_json=JSON.stringify(baselineRow);
        row.processing_status='discovered';currentRow=row;state.current_post=item.key;
        state.source_cursor={post_key:item.key,post_url:item.url,profile_url:state.target.profile_url,scroll_top:position,sample_index:row.sample_index,at_utc:now()};
        status(`正在处理第${row.sample_index}帖；已保存${Object.keys(state.rows).length}帖，正在读取日期与详情…`);
        log('begin_post',item.key);await persist();
        let dialog=null;
        try {
          if(mode!=='dialog')try {await timedPhase(row,'list_publication_time',()=>page.readPublicationTime(item.node,row,item));}
          catch(error) {
            if(error.message!=='publication_time_resource_changed')throw error;
            await gate();row.publication_time_read_status='resource_changed_before_time_read';
            log('publication_time_unavailable_recheck_detail_identity',item.key);await persist();
            // open() rediscovers the expected ID before any click. A missing
            // date does not itself justify dropping an otherwise verified post.
          }
          dialog=mode==='dialog'?page.matchingDialog(item):await timedPhase(row,'open_detail',()=>page.open(item,row));
          if(mode==='dialog')page.bindDetail(item);
          row.processing_status='detail_opened';state.pending_action=null;await persist();
          await timedPhase(row,'read_detail',()=>page.readDetail(dialog,row,item));await gate();
          state.consecutive_detail_failures=0;
          row.processing_status=row.comment_collection_warning?'partial_sort_unconfirmed':'detail_captured';
          row.collection_stop_reason='';await persist(); // Save BEFORE closing.
          if(mode!=='dialog') {await timedPhase(row,'close_detail',()=>page.close(dialog));window.scrollTo({left:0,top:position,behavior:'instant'});}
          if(!row.comment_collection_warning&&row.dialog_comment_expansion_status!=='expansion_limit_reached_incomplete')state.completed.push(item.key);
          row.return_to_profile_status=mode==='dialog'?'not_requested_diagnostic_mode':'confirmed';
          state.safe_post_progress=(state.safe_post_progress||0)+1;
          log('saved_post',item.key);await persist();
        } catch(error) {
          row.navigation_evidence_json=JSON.stringify(page.navigationEvidence());
          row.processing_status='partial_error';row.collection_stop_reason=String(error.message||error);log('post_error',row.collection_stop_reason);await persist();
          if(mode!=='dialog'&&!row.raw_detail_evidence_json&&!(row.post_content_kind==='image'&&/^(comment_detail_entry_not_identified|post_detail_dialog_not_opened)$/.test(error.message||''))){
            state.consecutive_detail_failures=(state.consecutive_detail_failures||0)+1;
            await persist();
            if(state.consecutive_detail_failures>=3){
              log('detail_pipeline_unhealthy',JSON.stringify({consecutive_failures:state.consecutive_detail_failures,last_error:row.collection_stop_reason,post_key:item.key}));
              throw new Error('detail_pipeline_unhealthy_requires_review');
            }
          }
          // Cancelling site navigation may leave its router in a failed transition.
          // Reload and relocate instead of sending every subsequent post through that document.
          if(error.message==='comment_entry_full_navigation_blocked')throw error;
          // Never click behind unknown dialogs, after a safety gate or on a changed page.
          if(page.restriction()||stop||storageError||error.message==='runtime_limit_reached'||mode==='dialog')throw error;
          if(!dialog) {
            if(page.dialogs().length||!page.isProfile())throw error;
            row.return_to_profile_status='profile_confirmed_detail_not_opened';
            if(error.message==='comment_entry_opened_viewer_restored_profile') {
              row.return_to_profile_status='confirmed_after_viewer_return';window.scrollTo({left:0,top:position,behavior:'instant'});
            }
            if(row.post_content_kind==='image'&&/^(comment_detail_entry_not_identified|post_detail_dialog_not_opened)$/.test(error.message||'')) {
              await page.readListImage(item,row);await gate();
              row.processing_status='list_only_image_captured';row.collection_mode='image_post_list_fallback';
              row.detail_access_status='unavailable_after_comment_entry_attempt';
              row.comment_access_status='unavailable_no_confirmed_detail';
              row.comment_sort_status='not_reached_no_confirmed_detail';
              state.completed.push(item.key);log('saved_image_post_list_fallback',item.key);await persist();
            }
            // A failed entry can indicate broken page state. Rebuild the document
            // and retry the resource before considering a skip, for formal runs.
            if(config.collection_scope==='formal'&&row.processing_status!=='list_only_image_captured'){
              row.detail_access_status='pending_profile_restore_and_retry';
              log('recover_unopened_detail_before_next_post',item.key);await persist();throw error;
            }
            log('skip_unopened_detail',item.key);await persist();
          } else {
            if(error.message==='publication_time_resource_changed') {
              const confirmed=page.matchingDialog(item);if(!confirmed)throw error;
              row.publication_time_read_status='resource_changed_in_detail_partial_preserved';
              row.processing_status='partial_time_unavailable';await persist();
              await page.close(confirmed);window.scrollTo({left:0,top:position,behavior:'instant'});
              row.return_to_profile_status='confirmed_after_time_failure';
              log('skip_unavailable_detail_date_continue_batch',item.key);await persist();
            } else {
              if(!/sort|content/.test(error.message||''))throw error;
              await page.close(dialog);
            }
          }
        }
        if(mode!=='dialog'&&page.isProfile()&&!page.dialogs().length)state.pending_action=null;
        preserveObservation();
        if(config.date_boundary_policy)observeBoundary(state.rows[item.url]||row,item.key);
        currentRow=null;baselineRow=null;state.current_post='';await persist();
        if(mode==='dialog'){reason='current_dialog_only';break;}
      }
    } catch(error){reason=String(error.message||error);state.navigation_evidence=page.navigationEvidence();}
    finally {
      state.last_interrupted_post=state.current_post||'';
      state.status='stopped';state.stop_reason=reason;state.coverage='completeness_not_established';state.current_post='';
      state.feed_position_at_stop=scrollY;
      state.pending_post_keys=state.discovered.filter(key=>!state.completed.includes(key));
      state.date_window_stop_status=reason==='date_window_start_boundary_confirmed'?'boundary_observed_not_proof_of_all_posts_or_comments':'boundary_not_confirmed';
      log('run_stopped',reason);try{await persist();}catch{}
      const details=Object.values(state.rows).filter(row=>row.raw_detail_evidence_json).length;
      const images=Object.values(state.rows).filter(row=>row.processing_status==='list_only_image_captured').length;
      currentRow=null;baselineRow=null;busy=false;globalThis.localPandaTiming?.deactivate();
      const stopLabel=reason==='post_discovery_rejected_requires_review'?'连续3轮未能确认帖子结构，自动适配后仍失败；请保存帖子识别诊断，不能视为采集完成':reason==='detail_pipeline_unhealthy_requires_review'?'连续3次未取得详情，已停止并保留原批次，不能视为采集完成':reason==='date_window_start_boundary_confirmed'?`已确认越过${config.start_date_bjt}零点（北京时间）；${reason}`:reason;
      status(storageError?`内存保留 ${Object.keys(state.rows).length} 条记录；停止：${reason}。最新数据尚未全部落盘，请使用此网页面板的“导出CSV”。`:
        `已保存 ${Object.keys(state.rows).length} 条原始记录；详情已读取 ${details} 帖；图片列表已读取 ${images} 帖；停止：${stopLabel}。可导出CSV。`);
      const terminal=/^(post_discovery_rejected_requires_review|post_discovery_target_binding_mismatch|detail_pipeline_unhealthy_requires_review|user_stopped|runtime_limit_reached|storage_write_failed|login_or_verification_required|access_restricted|access_or_verification_required|bounded_sample_limit_reached|date_window_start_boundary_confirmed|no_new_content_observed|feed_scroll_not_advancing|scroll_limit_reached|profile_snapshot_only|current_dialog_only)$/.test(reason);
      const recoverable=!terminal&&(!!state.last_interrupted_post||reason==='navigation_left_target_profile'||reason==='page_navigation_interrupted');
      if(config.collection_scope==='formal'&&recoverable&&!stop&&!storageError&&!paused)supervisorMessage('lp_fb_recover');
      else supervisorMessage('lp_fb_disarm');
    }
  }
  async function launch(mode='start',selectedRun='',options={}) {
    const {automaticRecovery=false}=options;
    if(busy||launching)return {ok:false,error:'current_tab_already_running'};
    if(!['formal','formal_here','start','start10','resume','dialog','profile'].includes(mode))return {ok:false,error:'unsupported_collection_mode'};
    launching=true;
    try {
    const activeId=(await chrome.storage.local.get(ACTIVE))[ACTIVE];
    const active=activeId?(await chrome.storage.local.get(prefix+activeId))[prefix+activeId]:null;
    if(active&&['running','paused'].includes(active.status)&&active.owner!==owner&&Date.now()-active.heartbeat<15000)
      return {ok:false,error:'another_tab_may_be_running_wait_15_seconds_after_closing_it'};
    const id=mode==='resume'&&selectedRun?selectedRun:activeId;
    const previous=id?(await chrome.storage.local.get(prefix+id))[prefix+id]:null;
    if(previous&&['running','paused'].includes(previous.status)&&previous.owner!==owner&&Date.now()-previous.heartbeat<15000)
      return {ok:false,error:'another_tab_may_be_running_wait_15_seconds_after_closing_it'};
    if(mode==='resume'&&!previous)return {ok:false,error:'no_saved_run'};
    if(mode==='resume'&&options.manualRequest&&(previous.manual_resume_request!==options.manualRequest||previous.user_stop_requested))
      return {ok:false,error:'该次续采请求已停止或被替换'};
    const candidate=mode==='resume'?previous:{run_id:crypto.randomUUID(),collector_version:'0.6.9',config:{...presets[['formal','formal_here'].includes(mode)?2:mode==='start10'?1:0]},created_at_utc:now(),rows:{},observations:[],discovered:[],completed:[],attempts:{},scrolls:0,logs:[],profile:{}};
    const selectedTarget=mode==='resume'?localPandaTarget.fromState(candidate):localPandaTarget.parse(options.target?.profile_url);
    if(!selectedTarget)return {ok:false,error:'请从目标账号主页新建采集；未识别到有效主页。'};
    if(mode!=='dialog'&&!localPandaTarget.same(location.href,selectedTarget))return {ok:false,error:'请返回该批次目标主页：'+selectedTarget.profile_url};
    candidate.target={...selectedTarget,name:mode==='resume'?selectedTarget.name:options.target?.name||selectedTarget.name};
    // Each launch gets fresh helpers; switching accounts cannot reuse an old
    // reader's captured comment/URL helpers or active-detail binding.
    page=createPage();page.setTarget(candidate.target);
    if(mode==='dialog') {
      if(!page.dialogs().length)return {ok:false,error:'请先手动点击目标帖子的评论图标，保持详情弹窗打开，再点击读取当前帖子弹窗。'};
      const item=page.currentDialogItem();
      if(!item)return {ok:false,error:'当前弹窗的帖子编号或目标账号发布者未能唯一确认，未启动采集；请保存当前页面结构CSV用于核对。'};
      page.bindDetail(item);
    }
    if(page.restriction())return {ok:false,error:page.restriction()};
    let positionStart=null,positionItems=[];
    if(mode==='formal_here'){
      if(page.dialogs().length)return {ok:false,error:'请先关闭详情弹窗，回到主页目标日期附近，再从当前位置新建采集。'};
      const found=page.discover();positionItems=found.items;
      positionStart=positionItems.find(item=>{const rect=item.node.getBoundingClientRect();return rect.bottom>0&&rect.top<innerHeight;});
      if(!positionStart)return {ok:false,error:'当前屏幕没有可确认的目标账号帖子；请滚到一条普通帖子的位置后重试。'};
      candidate.position_excluded_keys=positionItems.slice(0,positionItems.indexOf(positionStart)).map(item=>item.key);
      candidate.start_position={mode:'current_viewport',anchor_post_key:positionStart.key,anchor_post_url:positionStart.url,
        scroll_top:scrollY,created_at_utc:now(),excluded_loaded_posts:candidate.position_excluded_keys.length,
        coverage:'仅从用户指定位置向下扫描，不代表覆盖此前帖子'};
    }
    // Resume preserves the fixed window and original test/formal configuration.
    const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
    if(!record(candidate)||!record(candidate.config)||!record(candidate.rows)||!record(candidate.attempts)||
      (candidate.observations!==undefined&&(!Array.isArray(candidate.observations)||!candidate.observations.every(row=>record(row)&&typeof row.post_url==='string')))||
      (candidate.profile!==undefined&&!record(candidate.profile))||
      !Array.isArray(candidate.logs)||!Array.isArray(candidate.completed)||!Array.isArray(candidate.discovered)||
      ![...candidate.completed,...candidate.discovered].every(value=>typeof value==='string')||
      !Number.isInteger(candidate.scrolls)||candidate.scrolls<0||typeof candidate.run_id!=='string'||!candidate.run_id||
      !Object.values(candidate.attempts).every(value=>Number.isInteger(value)&&value>=0)||
      !Object.entries(candidate.rows).every(([url,row])=>record(row)&&row.post_url===url))return {ok:false,error:'invalid_saved_run_state'};
    const matchedConfig=presets.find(preset=>Object.keys(candidate.config).length===Object.keys(preset).length&&Object.keys(preset).every(key=>candidate.config[key]===preset[key]));
    if(!matchedConfig)
      return {ok:false,error:'saved_configuration_mismatch'};
    if(candidate.supervisor_skipped_keys!==undefined&&(!Array.isArray(candidate.supervisor_skipped_keys)||!candidate.supervisor_skipped_keys.every(key=>typeof key==='string')))return {ok:false,error:'invalid_saved_run_state'};
    if(candidate.position_excluded_keys!==undefined&&(!Array.isArray(candidate.position_excluded_keys)||!candidate.position_excluded_keys.every(key=>typeof key==='string')))return {ok:false,error:'invalid_position_exclusion_state'};
    if(candidate.resume_cursor&&(!record(candidate.resume_cursor)||
      !localPandaTarget.same(candidate.resume_cursor.profile_url,candidate.target)||
      !candidate.rows[candidate.resume_cursor.post_url]||
      localPandaCommentReader({}).postKey(candidate.resume_cursor.post_url)!==candidate.resume_cursor.post_key))
      return {ok:false,error:'invalid_resume_cursor'};
    const previousStop=candidate.stop_reason||'';
    config=matchedConfig===legacyFormal?presets[2]:matchedConfig;state=candidate;state.config={...config};state.observations=state.observations||[];currentRow=null;baselineRow=null;storageError='';state.last_runner_version='0.6.9';
    if(positionStart){
      // Save a real own-post snapshot before launch so even an immediate page
      // interruption retains a resource anchor rather than reverting to the top.
      const row=page.snapshot(positionStart.node,positionStart,1);
      row.run_id=state.run_id;row.processing_status='pending_position_start';row.collection_mode='position_start_pending';
      row.publication_time_timezone_policy=config.display_timezone_policy;
      state.rows[positionStart.url]=row;state.discovered=positionItems.map(item=>item.key);
      state.source_cursor={post_key:positionStart.key,post_url:positionStart.url,profile_url:state.target.profile_url,
        scroll_top:scrollY,sample_index:1,at_utc:now()};
      state.resume_cursor={...state.source_cursor,reason:'user_selected_current_position',retry_post:true};
      log('current_position_start_selected',JSON.stringify(state.start_position));
    }
    // An explicit manual continuation always uses the latest checkpoint, not an
    // earlier backfill candidate. Previously collected rows stay in this run.
    if(mode==='resume'&&!automaticRecovery){
      const selectedCheckpoint=localPandaCheckpoint.select(state);
      const {row,key,retry}=selectedCheckpoint||{};
      const savedCursor=state.resume_cursor;
      if(row&&!key)return {ok:false,error:'断点帖子编号无法确认，原批次未覆盖；请导出原始证据核验。'};
      if(row){
        const hint=state.source_cursor?.post_key===key?state.source_cursor:savedCursor?.post_key===key?savedCursor:{};
        state.resume_cursor={...hint,post_key:key,post_url:row.post_url,profile_url:state.target.profile_url,
          reason:retry?'manual_retry_interrupted_post':'manual_continue_after_saved_post',retry_post:retry};
        state.manual_resume_history=state.manual_resume_history||[];
        state.manual_resume_history.push({at_utc:now(),post_key:key,sample_index:row.sample_index,previous_stop:previousStop,
          retry_post:retry,previous_attempts:state.attempts[key]||0,previous_navigation_retries:state.navigation_retry_counts?.[key]||0});
        if(retry){
          state.attempts[key]=0;state.completed=state.completed.filter(value=>value!==key);
          state.supervisor_skipped_keys=(state.supervisor_skipped_keys||[]).filter(value=>value!==key);
          if(state.navigation_retry_counts)delete state.navigation_retry_counts[key];
        }
        log('manual_resume_from_checkpoint',JSON.stringify(state.resume_cursor));
      }
      state.background_feed_wait=null;
      state.manual_resume_strategy=options.resumeStrategy||'in_place';
      state.manual_resume_status='locating_checkpoint';state.manual_resume_error='';
    }
    state.execution_scroll_start=state.scrolls;
    // Rebuild ordering evidence for each execution; keep previously captured rows.
    if(config.date_boundary_policy)state.date_boundary={in_range_seen:Object.values(state.rows).some(row=>classifyPublicationTime(row).range==='in_range'),old_keys:[],last_old_ms:null,confirmed_growths:0,seen:[]};
    state.owner=owner;state.started_clock=automaticRecovery&&Number.isFinite(state.recovery_started_clock)?state.recovery_started_clock:Date.now();state.status='running';state.stop_reason='';
    state.user_stop_requested=false;state.paused_before_navigation=false;
    const blockedBackfill=mode==='resume'&&!automaticRecovery&&!state.resume_cursor?Object.values(state.rows)
      .filter(row=>!row.raw_detail_evidence_json&&row.collection_stop_reason==='comment_entry_full_navigation_blocked')
      .sort((a,b)=>Number(a.sample_index)-Number(b.sample_index))[0]:null;
    if(blockedBackfill){
      const key=localPandaCommentReader({}).postKey(blockedBackfill.post_url);
      state.resume_cursor={post_key:key,post_url:blockedBackfill.post_url,profile_url:state.target.profile_url,reason:'backfill_navigation_guard_regression'};
      state.supervisor_skipped_keys=(state.supervisor_skipped_keys||[]).filter(value=>value!==key);
      state.attempts[key]=Math.min(state.attempts[key]||0,1);
      log('backfill_missing_details_from_first_blocked_post',key);
    }
    if(!automaticRecovery)state.consecutive_detail_failures=0;
    const interruptedBeforeResume=state.current_post||state.last_interrupted_post;
    state.current_post='';state.last_interrupted_post='';state.pending_action=null;
    if(mode==='resume'&&!state.resume_cursor){
      const interrupted=interruptedBeforeResume;
      const row=interrupted&&Object.values(state.rows).find(row=>localPandaCommentReader({}).postKey(row.post_url)===interrupted);
      if(interrupted&&row&&!(state.supervisor_skipped_keys||[]).includes(interrupted)){
        state.resume_cursor={...(state.source_cursor||{}),post_key:interrupted,post_url:row.post_url,profile_url:state.target.profile_url};
        state.attempts[interrupted]=Math.min(state.attempts[interrupted]||0,1);
      }
    }
    state.safe_post_progress=state.safe_post_progress||Object.values(state.rows).filter(row=>row.return_to_profile_status==='confirmed').length;
    stop=false;paused=false;interruptedByNavigation=false;busy=true;globalThis.localPandaTiming?.activate(state.run_id);panel();recordLifecycle('run_started',false);
    try {await persist();}catch(error){busy=false;state.status='stopped';state.stop_reason='storage_write_failed';throw error;}
    if(config.collection_scope==='formal'&&typeof chrome.runtime?.sendMessage==='function') {
      const supervision=await supervisorMessage('lp_fb_register_run',{automatic_recovery:automaticRecovery});
      state.supervisor_status=supervision?.ok?'armed':supervision?.error||'unavailable';await persist();
      if(!supervision?.ok) {
        busy=false;state.status='stopped';state.stop_reason='supervisor_registration_failed';await persist();
        return {ok:false,error:'自动恢复未能启用：'+state.supervisor_status+'；请重新加载扩展并刷新目标主页后恢复。'};
      }
    }
    execute(['formal','formal_here','resume','start10'].includes(mode)?'start':mode).catch(error=>{busy=false;status('运行异常：'+String(error.message||error));});
    return {ok:true,run_id:state.run_id,message:'目标：'+state.target.name+'\n'+state.target.profile_url+'\n任务在网页中运行，可关闭扩展小窗；请保留网页。'};
    } finally {launching=false;}
  }
  const discoveryStatus=()=>{const found=page.discover();return {reader_target:page.getTarget(),
    run_id:state?.run_id||'',run_target:state?.target||null,busy,runner_version:'0.6.9',
    error:found.error,evidence:found.evidence,discovered_keys:found.items.map(item=>item.key),
    eligibility_evidence:found.items.map(item=>({post_key:item.key,completed:!!state?.completed?.includes(item.key),
      excluded_by_start_position:!!state?.position_excluded_keys?.includes(item.key),
      supervisor_skipped:!!state?.supervisor_skipped_keys?.includes(item.key),attempts:state?.attempts?.[item.key]||0})),
    resume_cursor:state?.resume_cursor||null,
    adaptive_discovery:state?.adaptive_discovery||null,adaptive_recovery_events:state?.adaptive_recovery_events||[],
    last_discovery_evidence:state?.last_discovery_evidence||null};};
  return {version:'0.6.9',launch,download,classifyPublicationTime,discoveryStatus,getState:()=>state,stop:requestStop,busy:()=>busy};
})();
