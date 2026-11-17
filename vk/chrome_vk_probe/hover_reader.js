"use strict";
// User-driven hover only. No pointer injection, clicks, page globals, cookies or private responses.
if(globalThis.VKProbeHover)globalThis.VKProbeHover.stop();
globalThis.VKProbeHover=(()=>{
  let config=null,session=null,serial=0,observer=null,expiry=null;
  const outcomes=new Map();
  const forbidden='input,textarea,select,[contenteditable],form,nav,aside,[role=navigation],script,style';
  const visible=el=>{
    if(!el?.isConnected||el.closest(forbidden)||el.closest('[hidden],[aria-hidden="true"]'))return false;
    const r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0;
  };
  const text=el=>visible(el)?el.innerText?.trim().slice(0,500)||'':'';
  const matches=raw=>raw.length<=240&&!!VKProbeCore.projectDate(raw)&&/\d{1,2}:\d{2}/u.test(raw);
  const near=(el,anchor)=>{
    const a=anchor.getBoundingClientRect(),b=el.getBoundingClientRect();
    return Math.max(a.left-b.right,b.left-a.right,0)<=260&&Math.max(a.top-b.bottom,b.top-a.bottom,0)<=180;
  };
  function candidates(s) {
    const items=[];
    for(const el of s.added){const raw=text(el);if(matches(raw)&&near(el,s.anchor))items.push({el,raw});}
    // Multiple descendants of the same tooltip may expose the same text. Distinct texts remain ambiguous.
    const byText=new Map();for(const item of items)if(!byText.has(item.raw))byText.set(item.raw,item);
    return [...byText.values()];
  }
  function check(s) {
    if(session!==s||s.leaving||!s.anchor.isConnected)return;
    const items=candidates(s);
    if(items.length===1){
      if(s.last===items[0].raw){s.samples++;}else{s.last=items[0].raw;s.samples=1;s.first_seen=Date.now();}
      s.selected=items[0];
    }else{s.last=null;s.samples=0;s.selected=null;}
  }
  function observe(mutations) {
    const s=session;if(!s||s.leaving)return;
    for(const m of mutations){
      const nodes=[...m.addedNodes,m.target];
      for(const n of nodes){
        let p=n.nodeType===Node.ELEMENT_NODE?n:n.parentElement;
        for(let i=0;p&&p!==document.body&&p!==document.documentElement&&i<4;i++,p=p.parentElement){
          if(!s.before.has(p)&&s.added.size<120)s.added.add(p);
        }
      }
    }
    check(s);
  }
  function mouseover(event) {
    if(!config||Date.now()>config.deadline||!event.target?.closest)return;
    const anchor=event.target.closest('a[href]');if(!anchor||!visible(anchor))return;
    if(event.relatedTarget&&anchor.contains(event.relatedTarget))return;
    const r=VKProbeCore.resource(anchor.getAttribute('href'),location.href);
    if(!r||r.type!=='wall'||r.reply||r.thread||!config.keys.includes(r.key)||VKProbeCore.target(location.href)?.entry_url!==config.entry_url)return;
    // Only the actual time text on the already known post resource is eligible.
    if(!/^(?:\d+\s*(?:小时|分钟|天)前|刚刚|昨天(?:\s+\d{1,2}:\d{2})?|(?:\d{4}年)?\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?)$/.test(text(anchor))&&!VKProbeCore.projectDate(text(anchor)))return;
    if(session?.anchor===anchor&&!session.leaving)return;
    if(session?.timer)clearInterval(session.timer);
    const before=new Set([...document.querySelectorAll('[role="tooltip"],[data-popper-placement]')].filter(visible));
    const s={id:++serial,anchor,key:r.key,resource_url:r.url,before,added:new Set(),samples:0,last:null,
      selected:null,leaving:false,started_at:new Date().toISOString()};
    session=s;s.timer=setInterval(()=>check(s),120);
    outcomes.set(r.key,{status:'observing'});
  }
  async function mouseout(event) {
    const s=session;
    if(!s||s.leaving||!s.anchor.contains(event.target)||event.relatedTarget&&s.anchor.contains(event.relatedTarget))return;
    s.leaving=true;clearInterval(s.timer);
    const selected=s.selected;
    if(!selected||s.samples<2||Date.now()-s.first_seen<180){outcomes.set(s.key,{status:'no_stable_tooltip'});if(session===s)session=null;return;}
    const run=config&&{...config};if(!run)return;
    let disappeared=false;
    for(let i=0;i<15;i++){
      await new Promise(resolve=>setTimeout(resolve,80));
      if(session!==s)return;
      if(!visible(selected.el)||!matches(text(selected.el))){disappeared=true;break;}
    }
    if(!disappeared||VKProbeCore.target(location.href)?.entry_url!==run.entry_url){outcomes.set(s.key,{status:'tooltip_lifecycle_unconfirmed'});if(session===s)session=null;return;}
    const observation={resource_key:s.key,resource_url:s.resource_url,text:selected.raw,
      association_status:'hover_lifecycle_confirmed',started_at:s.started_at,collected_at:new Date().toISOString(),
      source:run.automatic?'extension_mouse_event_public_tooltip':'user_hover_public_tooltip',stable_samples:s.samples,disappeared_after_leave:true};
    outcomes.set(s.key,{status:'saving'});
    try {
      const response=await chrome.runtime.sendMessage({type:'vk_probe_hover_observation',run_id:run.run_id,epoch:run.epoch,observation});
      if(!response?.ok){outcomes.set(s.key,{status:'storage_or_binding_failed',error:response?.error||'后台无响应'});console.warn('VK时间提示未保存。');}
      else outcomes.set(s.key,{status:'saved',text:observation.text,collected_at:observation.collected_at});
    }catch{outcomes.set(s.key,{status:'storage_or_binding_failed'});console.warn('VK时间提示未保存，请重新开启记录。');}
    if(session===s)session=null;
  }
  function stop(){
    config=null;if(session?.timer)clearInterval(session.timer);session=null;
    observer?.disconnect();observer=null;clearTimeout(expiry);
    document.removeEventListener('mouseover',mouseover,true);document.removeEventListener('mouseout',mouseout,true);
  }
  function start(input){
    stop();if(VKProbeCore.target(location.href)?.entry_url!==input.entry_url)throw new Error('目标主页已改变。');
    outcomes.clear();config=input;observer=new MutationObserver(observe);observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','aria-hidden']});
    document.addEventListener('mouseover',mouseover,true);document.addEventListener('mouseout',mouseout,true);
    expiry=setTimeout(stop,Math.max(1,input.deadline-Date.now()));return {version:VKProbeCore.VERSION,armed:true};
  }
  const outcome=key=>outcomes.get(key)||{status:'not_observed'};
  const ready=key=>session?.key===key&&session.samples>=2&&Date.now()-session.first_seen>=180&&!!session.selected;
  const prepare=anchor=>{if(!config?.automatic)throw new Error('自动悬停尚未绑定。');mouseover({target:anchor,relatedTarget:document.body});};
  const addKeys=keys=>{if(config)config.keys=[...new Set([...config.keys,...keys])];};
  return {start,stop,outcome,ready,prepare,addKeys};
})();
