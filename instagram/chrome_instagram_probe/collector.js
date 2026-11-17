// Runs in the tab's isolated extension world. Modal navigation only; no APIs/cookies.
if (globalThis.instagramAutoCollector?.version!=='0.4.2') {
  const db=globalThis.instagramData;
  const DATA = 'instagram_dom_diagnostic_v1_snapshots';
  const STATE = 'instagram_auto_v1_state';
  const STOP = 'instagram_auto_v1_stop_request';
  const SKIPPABLE = new Set(['post_open_timeout','post_owner_or_permalink_not_confirmed',
    'unique_post_dialog_required','ambiguous_load_more_comments',
    '帖子正文没有找到所选账号的可见链接，停止以防保存其他账号内容',
    '存在多个弹窗，请先关闭无关弹窗','未找到可见正文区域，未保存；请确认登录及页面已加载']);
  const LIMITS = {posts:10,scrolls:30,expansions:20,minutes:30,snapshots:250,bytes:6000000,candidates:1000};
  const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
  const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility!=='hidden'
    && getComputedStyle(el).display!=='none' && !el.closest('[aria-hidden="true"]');
  let active = false;
  let run;
  let savedStep = 0;
  const profilePath = () => location.pathname.replace(/\/$/,'') === '/'+run.username;
  const currentCode = () => location.pathname.match(/^\/(?:(?:[A-Za-z0-9._]+)\/)?(?:p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/)?.[1];
  function listScroller() {
    let element=document.querySelector('main');
    while (element) {
      if (element.scrollHeight>element.clientHeight+20 && /auto|scroll/.test(getComputedStyle(element).overflowY)) return element;
      element=element.parentElement;
    }
    return null;
  }
  function position() {
    const element=listScroller();
    return element ? {kind:'element',x:element.scrollLeft,y:element.scrollTop,height:element.scrollHeight}
      : {kind:'window',x:scrollX,y:scrollY,height:document.documentElement.scrollHeight};
  }
  function restorePosition(saved) {
    const element=saved.kind==='element' ? listScroller() : null;
    if (element) {element.scrollLeft=saved.x;element.scrollTop=saved.y;}
    else scrollTo(saved.x,saved.y);
  }
  async function persist(replace=false) {
    const current=(await chrome.storage.local.get(STATE))[STATE];
    if (!replace && current && (current.run_id!==run.run_id || current.execution_id!==run.execution_id)) throw Error('run_replaced_stop');
    run.heartbeat_at = new Date().toISOString();
    run.collector_version='0.4.2';
    run.page_visibility=document.visibilityState || 'unknown';
    await db.saveRun(run);
    const label=document.getElementById?.('instagram-collector-panel')?.querySelector('div');
    if(label) label.textContent=`${run.username} · ${run.run_id.slice(0,8)} · ${run.status} · ${run.done.length}帖 · 跳过${Object.keys(run.skipped || {}).length}帖 · ${run.phase}\n${run.checkpoint?.published_at || ''}`;
  }
  async function check() {
    const stored = await chrome.storage.local.get([STATE,STOP]);
    const state = stored[STATE];
    if (state?.run_id !== run.run_id || state.execution_id!==run.execution_id) throw Error('run_replaced_stop');
    if (stored[STOP]===run.run_id) throw Error('user_stop');
    if (run.status==='paused') throw Error('user_pause');
    if (Date.now() >= run.deadline_ms) throw Error('time_budget_reached');
    if (document.querySelector('input[type="password"],form[action*="login"]') || /\/accounts\/|\/challenge\/|\/checkpoint\//.test(location.pathname)) throw Error('login_or_verification_stop');
  }
  async function waitFor(predicate, reason, timeout=20000) {
    const end = Date.now()+timeout;
    while (Date.now()<end) {
      await check();
      if (predicate()) return;
      await sleep(500);
    }
    throw Error(reason);
  }
  function read(expectedCode) {
    if (expectedCode && currentCode()!==expectedCode) throw Error('resource_changed_stop');
    if (!expectedCode && !profilePath()) throw Error('profile_changed_stop');
    const snapshot = readInstagramPage(run.username);
    if (expectedCode) {
      const identity=db.normalize(snapshot).post;
      if (snapshot.shortcode!==expectedCode || identity.identity_status!=='verified') throw Error('post_owner_or_permalink_not_confirmed');
      snapshot.identity_strategy=identity.identity_strategy;
    }
    return snapshot;
  }
  async function save(snapshot, phase, code='') {
    await check();
    snapshot.collection = {run_id:run.run_id,phase,resource_shortcode:code,limits:LIMITS,
      batch_number:run.batch_number,target_done:run.target_done,batch_start_done:run.batch_start_done,
      scrolls_used:run.scrolls_used,expansions_used:run.expansions_used,
      post_expansions_used:run.current_expansions || 0,history_complete:false};
    const stepId = run.run_id+':'+(++savedStep)+':'+snapshot.collected_at_utc;
    snapshot.collection.step_id = stepId;
    await db.saveSnapshot(snapshot);
    run.saved_snapshots++;
    run.last_progress_at=snapshot.collected_at_utc;
    await persist();
  }
  async function discover(afterScroll=false) {
    await check();
    const snapshot = read();
    const oldCount = run.queue.length;
    let reactivated=0;
    for (const link of snapshot.links) {
      const match = new URL(link.url).pathname.match(/^\/([A-Za-z0-9._]+)\/(p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/);
      if (run.mode!=='comments' && match && match[1]===run.username && !run.queue.some(item=>item.code===match[3])) {
        if (run.queue.length>=LIMITS.candidates && run.mode!=='formal') throw Error('candidate_budget_reached');
        if (run.position_excluded?.includes(match[3])) continue;
        run.queue.push({code:match[3],url:link.url});
      }
      if (match && match[1]===run.username && !run.skipped?.[match[3]] && run.deferred.includes(match[3]) &&
          run.failures.findLast(failure=>failure.code===match[3])?.reason==='queued_link_not_currently_rendered') {
        run.deferred=run.deferred.filter(code=>code!==match[3]);reactivated++;
      }
    }
    if (run.queue.length!==oldCount || reactivated) run.stable_rounds=0;
    else if (afterScroll) run.stable_rounds++;
    run.discovery_evidence={at:new Date().toISOString(),page_url:location.href,link_count:snapshot.links.length,
      queue_count:run.queue.length,new_candidates:run.queue.length-oldCount,reactivated,
      pending:run.queue.filter(q=>!run.done.includes(q.code) && !run.skipped?.[q.code] && !run.deferred.includes(q.code)).length,
      position:position(),visibility:document.visibilityState || 'unknown',truncation:snapshot.truncation || {}};
    run.discovery_evidence.post_link_count=snapshot.links.filter(l=>/\/(p|reel|reels)\//.test(l.url)).length;
    if (!run.profile_saved || run.queue.length!==oldCount || afterScroll) {
      await save(snapshot,'profile_discovery');run.profile_saved=true;
    }
  }
  function scope() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
    if (dialogs.length>1) throw Error('unique_post_dialog_required');
    const root=dialogs[0] || (currentCode() && document.querySelector('main'));
    if (!root) throw Error('unique_post_dialog_required');
    return root;
  }
  function expansionAction() {
    const root = scope();
    const buttons = [...root.querySelectorAll('button,[role="button"]')].filter(visible);
    const replies = buttons.filter(b=>/^查看回复\s*[（(]\d+[)）]$/.test((b.innerText || '').trim()));
    if (replies.length) return {element:replies[0],kind:'replies',label:replies[0].innerText.trim()};
    const more = [...root.querySelectorAll('svg[aria-label="加载更多评论"]')].filter(visible)
      .map(svg=>svg.closest('button,[role="button"]')).filter(b=>b && visible(b));
    const unique = [...new Set(more)];
    if (unique.length>1) throw Error('ambiguous_load_more_comments');
    return unique.length ? {element:unique[0],kind:'comments',label:'加载更多评论'} : null;
  }
  function commentScroller(postTime) {
    const root=scope(),candidates=new Set();
    for(const t of root.querySelectorAll('time')) {
      if(t.getAttribute('datetime')===postTime) continue;
      let el=t.parentElement;
      while(el && el!==root) {
        if(el.scrollHeight>el.clientHeight+20 && /auto|scroll/.test(getComputedStyle(el).overflowY)) {candidates.add(el);break;}
        el=el.parentElement;
      }
    }
    if(candidates.size!==1) return null;
    const el=[...candidates][0];return el.scrollTop+el.clientHeight<el.scrollHeight-5?el:null;
  }
  async function expandCaption(item,parsed) {
    if(!parsed.created_at_utc) return;
    const root=scope();
    const candidates=[...root.querySelectorAll('button,[role="button"]')].filter(b=>{
      if(!visible(b) || !/^(更多|more)$/i.test((b.innerText || '').trim())) return false;
      let parent=b.parentElement;
      for(let n=0;parent && parent!==root && n<6;n++,parent=parent.parentElement) {
        const text=parent.innerText || '',times=[...parent.querySelectorAll('time')];
        if(text.startsWith(run.username+'\n') && times.length===1 && times[0].getAttribute('datetime')===parsed.created_at_utc) return true;
      }return false;
    });
    if(candidates.length!==1) return;
    await check();run.phase='expanding_caption';await persist();candidates[0].click();await sleep(800);
    await save(read(item.code),'caption_expanded',item.code);
  }
  async function collect(item) {
    run.current_code = item.code;
    run.post_expansions ||= {};
    run.current_expansions = run.post_expansions[item.code] || 0;
    run.phase = 'opening_detail';
    run.checkpoint={code:item.code,url:item.url,phase:run.phase};
    await persist();
    const alreadyOpen=currentCode()===item.code;
    const initialPosition = alreadyOpen && run.return_position ? run.return_position : position();
    run.return_position = initialPosition;
    const links = [...document.querySelectorAll('main a[href]')].filter(a=>visible(a) && (()=>{
      try { const u=new URL(a.href); return u.origin===location.origin && u.pathname.replace(/\/$/,'')===new URL(item.url).pathname.replace(/\/$/,''); }
      catch {return false;}
    })());
    if (!alreadyOpen && !links.length) {
      run.failures.push({code:item.code,reason:'queued_link_not_currently_rendered',at:new Date().toISOString()});
      run.deferred.push(item.code);
      await persist();
      return;
    }
    if(!alreadyOpen) links[0].click();
    await waitFor(()=>currentCode()===item.code && [...document.querySelectorAll('[role="dialog"]')].some(visible), 'post_open_timeout');
    await sleep(1500);
    const initial=read(item.code);
    let parsed=db.normalize(initial).post;
    run.checkpoint={code:item.code,url:item.url,phase:'reading_detail',
      published_at:parsed.created_at_bjt,summary:parsed.caption.slice(0,120)};
    run.post_dates ||= {};run.post_dates[item.code]=parsed.created_at_utc;
    await save(initial,'detail_initial',item.code);
    await expandCaption(item,parsed);parsed=db.normalize(read(item.code)).post;
    run.phase = 'expanding_comments';
    let stopReason = run.current_expansions>=LIMITS.expansions ? 'per_post_expansion_budget_reached' : 'no_confirmed_expand_control';
    let unchanged = 0;
    while (run.current_expansions<LIMITS.expansions && !(run.mode==='formal' && parsed.period_status==='out_of_range')) {
      await check();
      const before = read(item.code);
      let action = expansionAction();
      if(!action) {
        const el=commentScroller(parsed.created_at_utc);
        if(el) action={element:el,kind:'comments_scroll',label:'评论容器滚动'};
      }
      if (!action) break;
      if (action.element.disabled || action.element.getAttribute('aria-disabled')==='true') {
        stopReason = 'expand_control_disabled'; break;
      }
      if(action.kind==='comments_scroll') action.element.scrollTop+=Math.max(200,action.element.clientHeight*.8);
      else action.element.click();
      run.current_expansions++;
      run.post_expansions[item.code] = run.current_expansions;
      run.expansions_used++;
      await sleep(1800);
      const after = read(item.code);
      await save(after,'after_'+action.kind+'_click',item.code);
      const changed = before.visible_text!==after.visible_text || JSON.stringify(before.times)!==JSON.stringify(after.times);
      unchanged = changed ? 0 : unchanged+1;
      run.actions.push({code:item.code,kind:action.kind,label:action.label,changed,at:new Date().toISOString()});
      await persist();
      if (unchanged>=2) {stopReason='expand_no_progress_twice'; break;}
      if (run.current_expansions===LIMITS.expansions) stopReason='per_post_expansion_budget_reached';
    }
    const final = read(item.code);
    if(run.mode==='formal' && parsed.period_status==='out_of_range') stopReason='outside_window_comments_skipped';
    final.collection_result = {stop_reason:stopReason,expansions_used:run.current_expansions,comments_complete:false,replies_complete:false};
    await save(final,'detail_final',item.code);
    if(!run.done.includes(item.code)) run.done.push(item.code);
    run.consecutive_failures=0;
    run.phase='returning_to_profile';
    await persist();
    // Only back across the profile -> observed modal transition made by this loop.
    if (currentCode()!==item.code) throw Error('resource_changed_before_return_stop');
    await closeDetail(item.code);
    await waitFor(()=>profilePath() && ![...document.querySelectorAll('[role="dialog"]')].some(visible),'profile_return_timeout');
    restorePosition(initialPosition);
    await sleep(1200);
    run.current_code='';
    await persist();
  }
  async function closeDetail(code) {
    // Back is valid only for the modal transition observed by this loop; verify the destination.
    if (currentCode()!==code) throw Error('resource_changed_before_return_stop');
    history.back();
  }
  async function attempt(item) {
    try {await collect(item);} catch(error) {
      if(!SKIPPABLE.has(error.message)) throw error;
      await check(); // Login, stop and storage failures must not be converted to skipped posts.
      const failure={code:item.code,url:item.url,reason:error.message,at:new Date().toISOString(),phase:run.phase};
      let snapshot;
      try {
        snapshot=readInstagramPage(run.username);
        failure.evidence={page_url:snapshot.page_url,shortcode:snapshot.shortcode,scope:snapshot.scope,
          first_lines:snapshot.visible_text.split('\n').slice(0,8),
          matching_links:snapshot.links.filter(l=>l.url.includes('/'+item.code+'/')).slice(0,10)};
      } catch(diagnosticError) {failure.evidence_error=diagnosticError.message;}
      run.failures.push(failure);
      run.skipped[item.code]=failure;
      if(!run.deferred.includes(item.code)) run.deferred.push(item.code);
      run.consecutive_failures=(run.consecutive_failures || 0)+1;
      run.last_skip=failure;run.phase='skipping_failed_post';
      await persist();
      if(snapshot?.page_kind==='post' && snapshot.shortcode===item.code) await save(snapshot,'detail_rejected',item.code);
      if(currentCode()===item.code) {
        await closeDetail(item.code);
        await waitFor(()=>profilePath() && ![...document.querySelectorAll('[role="dialog"]')].some(visible),'failed_post_return_timeout');
        if(run.return_position) restorePosition(run.return_position);
        await sleep(1200);
      } else if(!profilePath()) throw Error('cannot_safely_return_after_post_error');
      run.current_code='';
      await persist();
    }
  }
  async function panel() {
    if(!document.createElement) return;
    document.getElementById('instagram-collector-panel')?.remove();
    const box=document.createElement('aside');box.id='instagram-collector-panel';
    box.style.cssText='position:fixed;bottom:12px;right:12px;z-index:2147483647;background:white;color:black;padding:10px;max-width:320px;border:1px solid #777;font:13px sans-serif';
    const text=document.createElement('div');
    text.textContent=`Instagram ${run.username} · ${run.run_id.slice(0,8)} · 已保存${run.done.length}帖`;
    box.append(text);
    for(const [label,action] of [['隐藏',()=>box.remove()],['暂停',async()=>{
      await chrome.storage.local.set({[STOP]:run.run_id});
    }],['停止',async()=>{
      await chrome.storage.local.set({[STOP]:run.run_id});
      chrome.runtime?.sendMessage({type:'ig_disarm',run_id:run.run_id}).catch(()=>{});
    }]]) {
      const b=document.createElement('button');b.textContent=label;b.onclick=action;box.append(b);
    }
    document.documentElement.append(box);
  }
  async function loop() {
    try {
      while (run.mode==='formal' || run.done.length<run.target_done) {
        await check();
        if(currentCode() && currentCode()===run.current_code) {
          const interrupted=run.queue.find(q=>q.code===run.current_code);
          if(!interrupted) throw Error('checkpoint_resource_missing');
          if(run.done.includes(interrupted.code) || run.skipped[interrupted.code]) {
            await closeDetail(interrupted.code);
            await waitFor(()=>profilePath() && ![...document.querySelectorAll('[role="dialog"]')].some(visible),'profile_return_timeout');
            if(run.return_position) restorePosition(run.return_position);
          } else await attempt(interrupted);
          continue;
        }
        if (!profilePath()) throw Error('manual_navigation_or_wrong_page_stop');
        run.phase='discovering';
        await discover(run.after_scroll===true);
        run.after_scroll=false;
        if(!run.queue.length && run.discovery_evidence.post_link_count) {
          run.rejected_scans=(run.rejected_scans || 0)+1;
          if(run.rejected_scans>=3) throw Error('post_links_present_but_identity_rules_reject_all');
          await sleep(1200);continue;
        }
        const item = run.queue.find(item=>!run.done.includes(item.code) && !run.skipped[item.code] && !run.deferred.includes(item.code));
        if (item) {
          await attempt(item);
          continue;
        }
        if (run.scrolls_used>=run.scroll_limit) {run.stop_reason='discovery_scroll_budget_reached';break;}
        if (run.stable_rounds>=6) {run.stop_reason='list_stalled_coverage_unverified';break;}
        run.phase='scrolling_profile';
        const before = position();
        const element=listScroller();
        if (element) element.scrollTop+=Math.max(500,element.clientHeight*.8);
        else scrollBy(0,Math.max(500,innerHeight*.8));
        run.scrolls_used++;
        run.after_scroll=true;
        await sleep(2000);
        if(document.visibilityState==='hidden') {
          run.stable_rounds=0;run.background_waits=(run.background_waits || 0)+1;
          await sleep(15000);
        }
        run.scroll_evidence.push({before,after:position()});
        // A boundary observation is conservative, and remains distinct from complete history.
        const known=run.queue.filter(q=>run.done.includes(q.code) && !run.position_excluded?.includes(q.code));
        const observedInRange=known.some(q=>db.period(run.post_dates?.[q.code])==='in_range');
        const tail=known.slice(-8),old=observedInRange && tail.length===8 && tail.every(q=>run.post_dates?.[q.code] &&
          new Date(run.post_dates[q.code]).toISOString()<db.START);
        run.boundary_confirm_scans=old && document.visibilityState!=='hidden' ? (run.boundary_confirm_scans || 0)+1 : 0;
        if(run.mode==='formal' && run.boundary_confirm_scans>=3 && !run.deferred.some(code=>!run.skipped[code])) {
          run.stop_reason='research_start_boundary_observed_not_full_history';break;
        }
        await persist();
      }
      run.status='stopped';
      run.stop_reason ||= run.target_done===10 ? 'ten_post_test_budget_reached' : 'batch_post_budget_reached';
    } catch(error) {
      run.status=['user_stop','user_pause','consecutive_detail_failures_pause'].includes(error.message) ? 'paused' : 'interrupted';
      if(['profile_return_timeout','failed_post_return_timeout','cannot_safely_return_after_post_error'].includes(error.message)) {
        run.status='running';run.phase='recovery_required';
      }
      run.stop_reason=error.message;
      run.failures.push({code:run.current_code || '',reason:error.message,at:new Date().toISOString()});
    } finally {
      if(run.phase!=='recovery_required') run.phase='idle';run.history_complete=false;
      try {
        const state=(await chrome.storage.local.get(STATE))[STATE];
        if (state?.run_id===run.run_id && state.execution_id===run.execution_id) await persist();
      } finally {active=false;}
    }
  }
  globalThis.instagramAutoCollector = {
    version:'0.4.2',
    status:()=>run ? {...structuredClone(run),loop_active:active} : null,
    diagnose:()=>({version:'0.4.2',target:run?.username,run_id:run?.run_id,phase:run?.phase,
      page_url:location.href,visibility:document.visibilityState,checkpoint:run?.checkpoint,discovery:run?.discovery_evidence,
      snapshot:readInstagramPage(run?.username || location.pathname.split('/')[1])}),
    async start(username,mode=false,selectedRunId='') {
      if (active) throw Error('本标签页已在采集');
      if (!['dailyvideo.kg','chinaarabtv'].includes(username)) throw Error('账号未登记');
      const current=(await chrome.storage.local.get(STATE))[STATE];
      const previous=selectedRunId ? await db.get(db.PREFIX+selectedRunId) || (current?.run_id===selectedRunId?current:null) : current;
      if(location.pathname.replace(/\/$/,'')!=='/'+username && !(mode===true && previous?.username===username &&
          currentCode()===previous.current_code)) throw Error('请先返回所选账号主页，再开始或恢复');
      if(current?.status==='running' && current.run_id!==previous?.run_id && Date.now()-Date.parse(current.heartbeat_at)<30000) throw Error('其他任务正在运行');
      if (previous?.status==='running' && Date.now()-Date.parse(previous.heartbeat_at)<30000) throw Error('已有运行中的Instagram批次，请先停止');
      if (![false,true,'next','formal','here','comments'].includes(mode)) throw Error('未知启动模式');
      if (mode===true || mode==='next') {
        if (!previous || previous.username!==username) throw Error('没有该账号的断点');
        run=previous;
        run.target_done ||= LIMITS.posts;
        run.batch_start_done ||= 0;
        run.batch_number ||= 1;
        run.batch_scroll_start ||= 0;
        run.scroll_limit ??= LIMITS.scrolls;
        if (mode==='next') {
          if(['formal','comments'].includes(run.mode)) throw Error('正式或评论任务请使用恢复，不需要增加10帖目标');
          if (run.done.length<run.target_done) throw Error('当前批次尚未采满，请先用“从断点恢复”；不会跳过未完成批次');
          run.batch_history ||= [];
          run.batch_history.push({batch_number:run.batch_number,done:run.done.length,
            scrolls_used:run.scrolls_used,stop_reason:run.stop_reason,continued_at:new Date().toISOString()});
          run.batch_start_done=run.done.length;
          run.target_done=run.done.length+LIMITS.posts;
          run.batch_number++;
          run.batch_scroll_start=run.scrolls_used;
          run.scroll_limit=run.scrolls_used+LIMITS.scrolls;
          run.stable_rounds=0;
          run.after_scroll=false;
        } else {
          if (run.mode!=='formal' && run.done.length>=run.target_done) throw Error('当前批次已采满，请点击“继续下一批10帖”');
          run.resume_count=(run.resume_count || 0)+1;
          if(run.mode==='comments') run.scroll_limit=run.scrolls_used+LIMITS.scrolls;
        }
        run.skipped ||= {};
        for(const failure of run.skip_history_migrated?[]:run.failures) if(SKIPPABLE.has(failure.reason) && !run.done.includes(failure.code)) {
          run.skipped[failure.code] ||= failure;
        }
        run.skip_history_migrated=true;
        // Retry only the old identity rejection once after this rule upgrade; keep unrelated skips.
        if(['0.4.0','0.4.1'].includes(run.collector_version)) {
          run.identity_rechecks ||= {};
          for(const [code,failure] of Object.entries(run.skipped)) {
            if(failure.reason==='post_owner_or_permalink_not_confirmed' && !run.identity_rechecks[code]) {
              run.identity_rechecks[code]={version:'0.4.2',previous_reason:failure.reason,at:new Date().toISOString()};
              delete run.skipped[code];
            }
          }
        }
        run.deferred=Object.keys(run.skipped);
        run.stable_rounds=0;run.boundary_confirm_scans=0;run.consecutive_failures=0;run.rejected_scans=0;
      } else {
        run={run_id:crypto.randomUUID(),username,started_at:new Date().toISOString(),done:[],deferred:[],skipped:{},queue:[],
          failures:[],actions:[],scroll_evidence:[],scrolls_used:0,expansions_used:0,saved_snapshots:0,stable_rounds:0,resume_count:0,
          target_done:LIMITS.posts,batch_start_done:0,batch_number:1,batch_scroll_start:0,scroll_limit:LIMITS.scrolls,batch_history:[]};
        run.mode=mode==='comments'?'comments':['formal','here'].includes(mode)?'formal':'test';
        if(mode==='comments') {
          if(!previous || previous.username!==username) throw Error('请选择该账号已有任务');
          const posts=db.tables(await db.snapshots(previous.run_id,username)).posts;
          run.queue=posts.filter(p=>p.identity_status==='verified' && p.period_status==='in_range' && !p.comments_complete)
            .map(p=>({code:p.content_id,url:p.content_url}));
          if(!run.queue.length) throw Error('所选任务没有可补采的期间内帖子');
          run.parent_run_id=previous.run_id;run.target_done=run.queue.length;
        }
        run.profile_url='https://www.instagram.com/'+username+'/';
        run.research_window={start_utc:db.START,end_utc:db.END};
        run.started_from_position=mode==='here';
        if(mode==='here') {
          const links=[...document.querySelectorAll('main a[href]')];
          const first=links.find(a=>{const r=a.getBoundingClientRect();return r.bottom>0 && r.top<innerHeight &&
            new URL(a.href).pathname.startsWith('/'+username+'/') && /\/(p|reel|reels)\//.test(a.href);});
          if(!first) throw Error('当前位置没有可核验的目标帖子');
          run.position_excluded=links.slice(0,links.indexOf(first)).map(a=>new URL(a.href).pathname.match(/\/(?:p|reel|reels)\/([^/]+)/)?.[1]).filter(Boolean);
          run.start_position={...position(),url:first.href};
          run.coverage_limitation='above_start_position_not_scanned';
        }
      }
      if(run.mode==='formal') {run.target_done=null;run.scroll_limit=Number.MAX_SAFE_INTEGER;}
      run.profile_url ||= 'https://www.instagram.com/'+username+'/';
      if(mode==='formal') {restorePosition({kind:position().kind,x:0,y:0});await sleep(1000);}
      run.status='running';run.stop_requested=false;run.stop_reason='';run.phase='starting';
      run.execution_id=crypto.randomUUID();
      run.deadline_ms=Date.now()+LIMITS.minutes*60000;run.limits=LIMITS;
      await chrome.storage.local.set({[STOP]:''});
      if(current && current.run_id!==run.run_id) await chrome.storage.local.set({[db.PREFIX+current.run_id]:current});
      await persist(true);
      if(chrome.runtime?.sendMessage) {
        const response=await chrome.runtime.sendMessage({type:'ig_register',run_id:run.run_id,username,profile_url:run.profile_url});
        if(!response?.ok) {run.status='paused';run.stop_reason='supervisor_registration_failed';await persist();throw Error(run.stop_reason);}
      }
      // The loop lives in this tab, so closing the popup does not stop it.
      active=true;
      await panel();
      void loop().catch(()=>{active=false;run.status='interrupted';run.stop_reason='storage_write_failed';run.unsaved_error=true;});
      return {run_id:run.run_id,status:'started',limits:LIMITS};
    }
  };
}
