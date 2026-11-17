importScripts('data.js');
const db=instagramData;
const BIND='instagram_supervisor_binding';
const allowed=url=>{try{const u=new URL(url);return u.protocol==='https:' && ['www.instagram.com','instagram.com'].includes(u.hostname);}catch{return false;}};
let busy=false;
async function disarm(runId) {
  const binding=(await chrome.storage.session.get(BIND))[BIND];
  if(binding?.run_id===runId) await chrome.storage.session.remove(BIND);
  const manual=(await chrome.storage.session.get('instagram_manual_resume')).instagram_manual_resume;
  if(manual?.run_id===runId) await chrome.storage.session.remove('instagram_manual_resume');
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  (async()=>{
    if(message.type==='ig_register') {
      const run=await db.get(db.STATE);
      if(!sender.tab || !allowed(sender.tab.url) || run?.run_id!==message.run_id || run.username!==message.username) throw Error('invalid_supervisor_registration');
      const old=(await chrome.storage.session.get(BIND))[BIND];
      await chrome.storage.session.set({[BIND]:old?.run_id===run.run_id && old.tab_id===sender.tab.id ? old :
        {tab_id:sender.tab.id,run_id:run.run_id,profile_url:run.profile_url,attempts:0,no_progress:0,done:run.done.length}});
      await chrome.alarms.create('instagram_supervise',{periodInMinutes:0.5});
    } else if(message.type==='ig_disarm') await disarm(message.run_id);
    else if(message.type==='ig_resume') {
      const run=await db.get(db.PREFIX+message.run_id) || await db.get(db.STATE);
      if(!run || run.run_id!==message.run_id || !sender.url?.startsWith(chrome.runtime.getURL(''))) throw Error('invalid_resume');
      const active=await db.get(db.STATE);
      if(active?.status==='running' && active.run_id!==run.run_id && Date.now()-Date.parse(active.heartbeat_at)<30000) throw Error('其他任务正在运行');
      await disarm(message.run_id);
      run.heartbeat_at='1970-01-01T00:00:00Z';await db.saveRun(run);
      const tab=await chrome.tabs.get(message.tab_id);
      if(!allowed(tab.url)) throw Error('请先在当前标签页打开Instagram');
      await chrome.storage.session.set({instagram_manual_resume:{tab_id:tab.id,run_id:run.run_id}});
      await chrome.tabs.update(tab.id,{url:run.profile_url || 'https://www.instagram.com/'+run.username+'/'});
    }
    return {ok:true};
  })().then(reply,e=>reply({ok:false,error:e.message}));
  return true;
});
async function inject(tabId,run) {
  await chrome.scripting.executeScript({target:{tabId},files:['data.js','page_reader.js','collector.js']});
  await chrome.scripting.executeScript({target:{tabId},args:[run.username,run.run_id],
    func:(name,id)=>instagramAutoCollector.start(name,true,id)});
}
async function supervise(tabId) {
  if(busy) return;busy=true;
  try {
    const manual=(await chrome.storage.session.get('instagram_manual_resume')).instagram_manual_resume;
    const binding=(await chrome.storage.session.get(BIND))[BIND];
    const tab=await chrome.tabs.get(tabId);
    if(tab.status!=='complete' || !allowed(tab.url)) return;
    const runId=manual?.tab_id===tabId?manual.run_id:binding?.tab_id===tabId?binding.run_id:'';
    if(!runId) return;
    const run=await db.get(db.PREFIX+runId) || await db.get(db.STATE);
    const active=await db.get(db.STATE),stop=await db.get('instagram_auto_v1_stop_request');
    if(!run || active?.run_id!==runId || stop===runId) {
      await disarm(runId);await chrome.storage.session.remove('instagram_manual_resume');return;
    }
    const path=new URL(tab.url).pathname;
    if(/^\/(accounts|challenge|checkpoint|direct)\//.test(path)) {
      run.status='paused';run.stop_reason='access_or_login_requires_user';await db.saveRun(run);await disarm(runId);return;
    }
    if(manual?.tab_id===tabId) {
      if(path.replace(/\/$/,'')!=='/'+run.username) return;
      await chrome.storage.session.remove('instagram_manual_resume');await inject(tabId,run);return;
    }
    if(run.status!=='running') {await disarm(runId);return;}
    if(Date.now()>=run.deadline_ms) {run.status='paused';run.stop_reason='time_budget_reached';await db.saveRun(run);await disarm(runId);return;}
    const [{result}]=await chrome.scripting.executeScript({target:{tabId},func:()=>globalThis.instagramAutoCollector?.status?.()});
    // A living loop, even a late heartbeat, is not grounds to refresh the page.
    if(result?.run_id===runId && result.status==='running' && result.loop_active!==false) return;
    if(tab.frozen || tab.discarded) return;
    if(Date.now()-Date.parse(run.heartbeat_at)<10000) return;
    const progress=run.done.length>binding.done;
    binding.no_progress=progress?0:binding.no_progress+1;binding.attempts++;binding.done=run.done.length;
    if(binding.attempts>10 || binding.no_progress>2) {
      run.status='paused';run.stop_reason='automatic_recovery_budget_reached';await db.saveRun(run);await disarm(runId);return;
    }
    await chrome.storage.session.set({[BIND]:binding});
    run.recovery_events ||= [];run.recovery_events.push({at:new Date().toISOString(),url:tab.url,attempt:binding.attempts});
    run.automatic_recovery_count=binding.attempts;run.heartbeat_at='1970-01-01T00:00:00Z';await db.saveRun(run);
    if(path.replace(/\/$/,'')==='/'+run.username) await inject(tabId,run);
    else if(/^\/(?:(?:[A-Za-z0-9._]+)\/)?(?:p|reel|reels)\//.test(path)) await chrome.tabs.update(tabId,{url:run.profile_url});
    else {run.status='paused';run.stop_reason='unknown_route_requires_user';await db.saveRun(run);await disarm(runId);}
  } catch(error) {
    // Preserve state when browser permissions or the tab disappear; never spin a refresh loop.
    const binding=(await chrome.storage.session.get(BIND))[BIND];
    if(binding?.tab_id===tabId) {
      const run=await db.get(db.PREFIX+binding.run_id);
      if(run) {run.status='paused';run.stop_reason='supervisor_error:'+error.message;await db.saveRun(run);}
      await disarm(binding.run_id);
    }
  } finally {busy=false;}
}
chrome.tabs.onUpdated.addListener((id,change)=>{if(change.status==='complete') void supervise(id);});
chrome.tabs.onRemoved.addListener(id=>{chrome.storage.session.get(BIND).then(v=>{if(v[BIND]?.tab_id===id) return disarm(v[BIND].run_id);});});
chrome.alarms.onAlarm.addListener(async alarm=>{if(alarm.name==='instagram_supervise') {
  const binding=(await chrome.storage.session.get(BIND))[BIND];if(binding) await supervise(binding.tab_id);
}});
