"use strict";
// Scheduling only. This cannot execute a renderer which Chrome has genuinely frozen.
if(!globalThis.localPandaTiming)globalThis.localPandaTiming=(()=>{
  let runId='',excluded=0,frozenAt=null,lastMode='page_timer',delayedWakes=0,freezeCount=0,resumeCount=0,lifecycleEpoch=0;
  for(const event of ['visibilitychange','freeze','resume'])document.addEventListener(event,()=>{lifecycleEpoch++;});
  const raw=()=>performance.now();
  const clock=()=>raw()-excluded-(frozenAt===null?0:raw()-frozenAt);
  document.addEventListener('freeze',()=>{if(frozenAt===null){frozenAt=raw();freezeCount++;}});
  document.addEventListener('resume',()=>{if(frozenAt!==null){excluded+=raw()-frozenAt;frozenAt=null;resumeCount++;}});
  async function delay(ms){
    const start=clock(),wasHidden=document.hidden||!document.hasFocus();
    let scheduled=false;
    if(wasHidden&&runId&&typeof globalThis.chrome?.runtime?.sendMessage==='function'){
      try{
        const result=await chrome.runtime.sendMessage({type:'lp_fb_wait',run_id:runId,delay_ms:Math.max(1,Math.min(1000,ms))});
        scheduled=result?.ok===true;if(scheduled)lastMode='extension_timer';
      }catch{}
    }
    if(!scheduled){lastMode='page_timer';await new Promise(resolve=>setTimeout(resolve,ms));}
    // Do not count a background scheduling gap as six seconds of unsuccessful DOM polling.
    const elapsed=clock()-start;
    if((wasHidden||document.hidden||!document.hasFocus())&&elapsed>ms+1000){excluded+=elapsed-ms;delayedWakes++;}
  }
  return {clock,delay,activate:id=>{runId=id;},deactivate:()=>{runId='';},
    snapshot:()=>({visibility:document.visibilityState,has_focus:document.hasFocus(),lifecycle_epoch:lifecycleEpoch,
      frozen:frozenAt!==null,scheduler:lastMode,excluded_wait_ms:Math.round(excluded+(frozenAt===null?0:raw()-frozenAt)),delayed_wakes:delayedWakes,freeze_count:freezeCount,resume_count:resumeCount})};
})();
