// Small integration check: native persistence, supervisor decisions and actual archived evidence.
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path'),crypto=require('crypto');
const directory=path.join(__dirname,'chrome_instagram_probe');
const local={},session={},events={},calls=[];
let scriptStatus=null;
const storage=store=>({async get(keys){if(keys===null)return structuredClone(store);return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(store[k])]));},
  async set(values){Object.assign(store,structuredClone(values));},async remove(keys){for(const k of Array.isArray(keys)?keys:[keys])delete store[k];},async getBytesInUse(){return JSON.stringify(store).length;}});
const tab={id:7,status:'complete',url:'https://www.instagram.com/dailyvideo.kg/'};
const chrome={storage:{local:storage(local),session:storage(session)},
  runtime:{getURL:()=> 'chrome-extension://test/',onMessage:{addListener:f=>events.message=f}},
  tabs:{get:async()=>tab,update:async(id,change)=>{calls.push(['navigate',change.url]);tab.url=change.url;},onUpdated:{addListener:f=>events.updated=f},onRemoved:{addListener:f=>events.removed=f}},
  alarms:{create:async()=>{},onAlarm:{addListener:f=>events.alarm=f}},
  scripting:{executeScript:async input=>{calls.push(['inject',input.files || input.args || 'status']);return [{result:scriptStatus}];}}};
const context=vm.createContext({URL,Date,TextEncoder,structuredClone,crypto,chrome});
context.importScripts=file=>vm.runInContext(fs.readFileSync(path.join(directory,file),'utf8'),context);
vm.runInContext(fs.readFileSync(path.join(directory,'supervisor.js'),'utf8'),context);
const send=(message,sender={tab})=>new Promise(resolve=>events.message(message,sender,resolve));
(async()=>{
  const db=context.instagramData;
  const run={run_id:'TEST_RUN',username:'dailyvideo.kg',profile_url:tab.url,status:'running',mode:'formal',phase:'opening_detail',
    heartbeat_at:'2000-01-01T00:00:00Z',deadline_ms:Date.now()+60000,done:[],deferred:[],queue:[],started_at:'2026-10-23T00:00:00Z'};
  await db.saveRun(run);assert(local.instagram_run_TEST_RUN);
  assert((await send({type:'ig_register',run_id:run.run_id,username:run.username})).ok);
  assert.equal(session.instagram_supervisor_binding.tab_id,7);
  scriptStatus={run_id:run.run_id,status:'running'};
  await events.alarm({name:'instagram_supervise'});
  assert(!calls.some(c=>c[0]==='navigate' || Array.isArray(c[1]) && c[1].includes('collector.js')));
  scriptStatus=null;calls.length=0;
  await events.alarm({name:'instagram_supervise'});
  assert(calls.some(c=>c[0]==='inject' && Array.isArray(c[1]) && c[1].includes('collector.js')));
  const attempts=session.instagram_supervisor_binding.attempts;
  await send({type:'ig_register',run_id:run.run_id,username:run.username});
  assert.equal(session.instagram_supervisor_binding.attempts,attempts,'registration must not reset recovery budget');
  local.instagram_auto_v1_stop_request=run.run_id;calls.length=0;
  await events.alarm({name:'instagram_supervise'});assert(!session.instagram_supervisor_binding);assert.equal(calls.length,0);
  delete local.instagram_auto_v1_stop_request;
  await db.saveRun(run);await send({type:'ig_register',run_id:run.run_id,username:run.username});
  for(let i=0;i<3;i++) await events.alarm({name:'instagram_supervise'});
  assert.equal(local.instagram_auto_v1_state.stop_reason,'automatic_recovery_budget_reached');
  await db.saveRun(run);
  await send({type:'ig_register',run_id:run.run_id,username:run.username});
  tab.url='https://www.instagram.com/challenge/test/';await events.alarm({name:'instagram_supervise'});
  assert.equal(local.instagram_auto_v1_state.stop_reason,'access_or_login_requires_user');assert(!session.instagram_supervisor_binding);
  const original=JSON.stringify(local.instagram_run_TEST_RUN);
  const invalid=await send({type:'ig_resume',run_id:'UNKNOWN',tab_id:7},{url:'chrome-extension://test/popup.html'});
  assert(!invalid.ok);assert.equal(JSON.stringify(local.instagram_run_TEST_RUN),original);
  const badTime=db.period('2026-10-17T00:00:00');assert.equal(badTime,'date_pending');
  assert.equal(db.period('2025-10-16T16:00:00Z'),'in_range');assert.equal(db.period('2026-10-17T16:00:00Z'),'out_of_range');
  const originalSet=chrome.storage.local.set;
  chrome.storage.local.set=async values=>{if(Object.keys(values).some(k=>k.startsWith('instagram_snapshot_'))) throw Error('simulated_disk_failure');return originalSet(values);};
  await assert.rejects(()=>db.saveSnapshot({visible_text:'synthetic only'}),/storage_write_failed/);
  chrome.storage.local.set=originalSet;
  assert(!Object.keys(local).some(k=>k.startsWith('instagram_snapshot_')));
  // The Python entry point supplies parsed CSV snapshots on stdin; no CSV parser dependency.
  const input=fs.readFileSync(0,'utf8');
  if(input.trim()) {
    const snapshots=JSON.parse(input),result=db.tables(snapshots);
    assert.equal(snapshots.length,47);assert.equal(result.posts.length,14);
    assert.equal(result.posts.filter(p=>p.period_status==='in_range').length,4);
    assert.equal(result.comment_observations.length,280);assert.equal(result.comments.length,0);
    assert.equal(result.posts.find(p=>p.content_id==='DezJQHlOgrr').like_count,57);
    const profile=result.profiles.find(p=>p.username==='dailyvideo.kg');assert.equal(profile.follower_count_raw,'4.5万');
    console.log('Archived real CSV: 47 snapshots / 14 posts / 4 in range / 280 observations / 0 confirmed comment IDs.');
  }
  console.log('v0.4 native persistence, time boundaries, supervisor recovery/stop/login and budget checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
