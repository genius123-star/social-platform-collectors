"use strict";
// Shared discovery and identity rules are used for trial, history and explicit resume.
if(globalThis.VKProbeCollector?.running)throw new Error('原试采仍在运行，请先停止。');
globalThis.VKProbeCollector=(()=>{
  let running=false,stopped=false,input=null,phase='idle',current=null;
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const error=code=>{throw new Error(code);};
  function gate(){
    if(stopped)error('user_stopped');
    if(Date.now()>input.deadline)error('trial_time_budget_exhausted');
    if(VKProbeCore.target(location.href)?.entry_url!==input.entry_url)error('target_page_changed');
    if(document.visibilityState!=='visible')error('page_hidden_trial_paused');
    const dialog=[...document.querySelectorAll('[role="dialog"]')].some(el=>el.getBoundingClientRect().width>0&&getComputedStyle(el).visibility!=='hidden');
    if(dialog)error('unexpected_dialog_trial_paused');
  }
  function locate(key){
    gate();const item=VKProbeDiagnostics({live:true,onlyKey:key}).items.find(x=>x.key===key);
    if(!item)error('source_resource_not_found');
    const headers=item.candidate.fields.header_links;
    if(!headers.length||!headers.every(h=>VKProbeCore.target(h.url)?.entry_url===input.entry_url))error('header_author_not_confirmed');
    return item;
  }
  async function save(stage,extra={}){
    phase=stage;
    const response=await chrome.runtime.sendMessage({type:'vk_probe_auto_commit',run_id:input.run_id,epoch:input.epoch,phase:stage,current_key:current,
      cursor:{scroll_y:Math.round(scrollY)},...extra});
    if(!response?.ok)error(response?.error||'storage_or_binding_failed');
  }
  async function position(key,select,allowComment=false){
    const owned=(item,el)=>item.own(el)||allowComment&&globalThis.VKProbeComments?.read(item).controls.includes(el);
    let item=locate(key),el=select(item);
    if(!el||!owned(item,el)||!item.rendered(el))error('action_target_not_confirmed');
    el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
    await wait(80);item=locate(key);el=select(item);
    if(!el||!owned(item,el)||!item.rendered(el))error('action_target_changed_after_scroll');
    const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
    const hit=document.elementFromPoint(x,y);
    if(!hit||!(el===hit||el.contains(hit)))error('action_target_occluded');
    return {item,el,x,y};
  }
  async function expand(key){
    let item=locate(key);
    if(!item.showMore.length)return 'no_show_more_observed';
    if(item.showMore.length!==1)return 'ambiguous_show_more_not_clicked';
    await save('before_body_expand',{candidate:item.candidate});gate();
    const {el}=await position(key,i=>i.showMore.length===1?i.showMore[0]:null);
    if(el.tagName!=='SPAN'||el.getAttribute('role')!=='button'||el.closest('a[href],form')||
      el.getAttribute('aria-disabled')==='true'||!['显示更多','Показать полностью','Show more'].includes(el.innerText.trim()))error('unsafe_expand_control');
    gate();el.click();
    for(let i=0;i<25;i++){
      await wait(100);item=locate(key);
      if(!item.showMore.length){await save('body_expanded',{candidate:item.candidate});return 'show_more_removed_after_same_post_click';}
    }
    await save('body_expand_partial',{candidate:item.candidate});return 'show_more_still_present_after_budget';
  }
  function timeControl(item){
    const nodes=item.timeLinks.filter(el=>/^\d+\s*(?:小时|分钟|天)前$|^刚刚$|^昨天(?:\s+\d{1,2}:\d{2})?$/.test(el.innerText.trim())||VKProbeCore.projectDate(el.innerText));
    return nodes.length===1?nodes[0]:null;
  }
  function pointer(el,enter,point){
    const names=enter?['pointerover','pointerenter','mouseover','mouseenter']:['pointerout','pointerleave','mouseout','mouseleave'];
    for(const name of names){
      const Constructor=name.startsWith('pointer')?PointerEvent:MouseEvent;
      el.dispatchEvent(new Constructor(name,{bubbles:!name.endsWith('enter')&&!name.endsWith('leave'),view:window,
        clientX:point.x,clientY:point.y,relatedTarget:document.body,pointerType:'mouse'}));
    }
  }
  async function hover(key){
    await save('before_time_hover',{candidate:locate(key).candidate});
    const target=await position(key,timeControl);gate();
    VKProbeHover.prepare(target.el);
    pointer(target.el,true,target);
    try{
      for(let i=0;i<35;i++){await wait(100);gate();locate(key);if(VKProbeHover.ready(key))break;}
    }finally{pointer(target.el,false,target);}
    for(let i=0;i<20;i++){
      await wait(100);gate();const result=VKProbeHover.outcome(key);
      if(result.status==='saved')return 'tooltip_saved';
      if(result.status==='storage_or_binding_failed')error('storage_or_binding_failed');
      if(['no_stable_tooltip','tooltip_lifecycle_unconfirmed'].includes(result.status))return result.status;
    }
    return 'tooltip_save_budget_exhausted';
  }
  async function comments(key){
    if(!globalThis.VKProbeComments)return 'comment_reader_unavailable';
    let item=locate(key),evidence=VKProbeComments.read(item),zero=VKProbeSamples.metric(item.candidate,'comment').value===0;
    if(zero&&!evidence.items.length){item.candidate.fields.comments={items:[],status:'explicit_zero_at_observation'};await save('comments_saved',{candidate:item.candidate});return 'explicit_zero_at_observation';}
    const seen=new Set();let clicks=0;
    while(clicks<20){
      gate();item=locate(key);evidence=VKProbeComments.read(item);
      item.candidate.fields.comments={items:evidence.items,status:evidence.status};
      await save('comments_saved',{candidate:item.candidate});
      // Only a known expansion inside this wall, or an explicit aria-controls link to its own subtree.
      const countButtons=item.commentButtons.filter(el=>{const id=el.getAttribute('aria-controls');return id&&item.node.contains(document.getElementById(id));});
      const control=[...evidence.controls,...countButtons].find(el=>!seen.has(el));
      if(!control)break;
      const before=evidence.items.map(c=>c.id).join(',');
      await save('before_comment_expand');
      const positioned=await position(key,i=>{
        const fresh=VKProbeComments.read(i);return [...fresh.controls,...i.commentButtons].find(el=>el===control);
      },true);
      if(positioned.el.getAttribute('aria-disabled')==='true'||positioned.el.hasAttribute('disabled'))break;
      gate();seen.add(control);positioned.el.click();clicks++;
      for(let n=0;n<15;n++){await wait(100);gate();if(VKProbeComments.read(locate(key)).items.map(c=>c.id).join(',')!==before)break;}
    }
    item=locate(key);evidence=VKProbeComments.read(item);
    const expected=VKProbeSamples.metric(item.candidate,'comment').value;
    const status=expected!==''&&expected===evidence.items.length&&!evidence.controls.length?'displayed_count_matched_not_platform_completeness_proof':
      clicks>=20?'comment_expand_budget_partial':evidence.items.length?'visible_comments_partial':'comment_entry_unverified';
    item.candidate.fields.comments={items:evidence.items,status,clicks};await save('comments_saved',{candidate:item.candidate});return status;
  }
  async function discover(done){
    gate();const found=VKProbeDiagnostics({live:true,skipKeys:[...done],minimumY:input.minimumY}).items.filter(item=>{
      const c=item.candidate;return c.resource.owner_id==='-42692593'&&c.fields.header_links.length&&
        c.fields.header_links.every(h=>VKProbeCore.target(h.url)?.entry_url===input.entry_url);
    });
    if(found.length){
      current=null;await save('discovered',{discovered:found.map(x=>x.candidate)});
      VKProbeHover.addKeys(found.map(x=>x.key));
    }
    return found.map(x=>x.key);
  }
  async function execute(){
    const results={},done=new Set(input.processed_keys||[]);let fatal=null,attempted=0,stalls=0,scrolls=0;
    try{
      const history=input.mode==='history';
      if(history&&!input.from_current){
        let anchor=null;const completed=input.processed_keys||[];
        for(let n=completed.length-1;n>=Math.max(0,completed.length-20);n--){try{anchor=locate(completed[n]);break;}catch{}}
        if(anchor)anchor.node.scrollIntoView({block:'end',behavior:'instant'});
        else window.scrollTo({top:0,behavior:'instant'});
        await wait(200);
      }
      let queue=history?await discover(done):input.keys.filter(k=>!done.has(k));
      while(true){
        if(!queue.length){
          if(!history)break;
          if(scrolls>=300){fatal='scroll_budget_partial';break;}
          current=null;await save('before_history_scroll');gate();
          // Advance from the current viewport; no-growth is a partial stop, never proof of the wall's end.
          const before={y:scrollY,height:document.documentElement.scrollHeight};
          window.scrollBy({top:Math.max(400,innerHeight*0.8),behavior:'instant'});scrolls++;
          for(let n=0;n<10;n++){await wait(150);gate();if(document.documentElement.scrollHeight!==before.height)break;}
          queue=await discover(done);
          if(queue.length||Math.abs(scrollY-before.y)>2)stalls=0;else stalls++;
          await save('history_scrolled',{discovery_state:{scrolls,stalls,before,after:{y:scrollY,height:document.documentElement.scrollHeight}}});
          if(stalls>=6){fatal='no_new_verified_posts_after_six_scrolls_partial';break;}
          continue;
        }
        const key=queue.shift();if(done.has(key))continue;
        current=key;gate();
        const result={post_key:key,started_at:new Date().toISOString(),body_expansion:'not_attempted',tooltip:'not_attempted',
          comments:'not_attempted',date:'research_policy_2026_BJT',like:'only_explicit_public_labels'};
        try{
          await save('post_started',{candidate:locate(key).candidate});
          if(history){
            const date=VKProbeSamples.publication(locate(key).candidate);
            try{result.tooltip=await hover(key);}catch(e){
              if(/user_stopped|time_budget|target_page|page_hidden|dialog|storage|binding/.test(e.message))throw e;
              result.tooltip='hover_unavailable_'+e.message;
            }
            result.calendar_date_present=!!date.utc||date.precision==='day';
            const tooltip=VKProbeHover.outcome(key).text;
            const tooltipDate=VKProbeCore.projectDate(tooltip);
            const parsed=date.range==='date_pending'?tooltipDate:date;
            result.range=parsed?.range||'date_pending';
            if(date.status==='date_pending_conflict')result.range='date_pending';
            if(!date.utc&&date.bjt&&tooltipDate&&date.bjt.slice(0,10)!==tooltipDate.bjt.slice(0,10))result.range='date_pending';
          }
          if(result.range==='out_of_range'){
            result.body_expansion='not_expanded_outside_research_window';result.comments='not_collected_outside_research_window';result.status='outside_window_saved';
          }else{
          result.body_expansion=await expand(key);
          if(!history)result.tooltip=await hover(key);
          result.comments=await comments(key);
          result.status=(result.tooltip==='tooltip_saved'||result.calendar_date_present)&&['show_more_removed_after_same_post_click','no_show_more_observed'].includes(result.body_expansion)
            ?'observed_with_remaining_field_gaps':'partial';
          }
        }catch(e){
          result.status='partial';result.error=e.message;
          if(/user_stopped|time_budget|target_page|page_hidden|dialog|storage|binding/.test(e.message))fatal=e.message;
        }
        const item=(()=>{try{return locate(key);}catch{return null;}})();
        result.finished_at=new Date().toISOString();results[key]=result;
        await save('post_processed',{candidate:item?.candidate,result});
        done.add(key);attempted++;
        if(fatal)break;
        if(history&&attempted>=200){fatal='session_200_posts_budget_partial_resume_available';break;}
      }
      await save(fatal==='user_stopped'?'stopped':fatal?'paused':'trial_finished',
        {stop_reason:fatal||(input.keys.length===3?'three_post_trial_budget_completed':'loaded_trial_queue_exhausted')});
    }catch(e){
      try{await save(e.message==='user_stopped'?'stopped':'paused',{stop_reason:e.message});}catch{console.warn('VK试采停止，最后写入前的断点仍在本地。');}
    }finally{VKProbeHover.stop();running=false;current=null;}
  }
  function launch(config){
    if(running)error('trial_already_running');input={...config,minimumY:config.from_current?scrollY:undefined};stopped=false;running=true;
    execute().catch(()=>{});return {started:true,run_id:input.run_id,version:VKProbeCore.VERSION};
  }
  const stop=()=>{stopped=true;return {stopping:true};};
  return {launch,stop,get running(){return running;},status:()=>({running,phase,current_key:current,version:VKProbeCore.VERSION})};
})();
