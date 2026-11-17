// Deterministic simulation of the tab loop. Never opens Instagram or writes research data.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const crypto = require('crypto');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname,'chrome_instagram_probe','collector.js'),'utf8');
const STATE='instagram_auto_v1_state', DATA='instagram_dom_diagnostic_v1_snapshots', STOP='instagram_auto_v1_stop_request';
const raw=sim=>Object.entries(sim.store).filter(([k])=>k.startsWith('instagram_snapshot_')).map(([,v])=>v);
function simulation(options={}) {
  const store={};
  const stats={opened:[],plainReplyClicks:0,expansions:0,windowScrolls:0};
  let current='',paused=false;
  let clockOffset=0;
  class SimulationDate extends Date {static now(){return Date.now()+clockOffset;}}
  const perCode={};
  const location={origin:'https://www.instagram.com',pathname:'/dailyvideo.kg/'};
  const visible=extra=>({getClientRects:()=>[1],closest:()=>null,getAttribute:()=>null,...extra});
  const links=Array.from({length:options.fewLinks ? 2 : options.totalLinks || 12},(_,i)=>visible({href:`https://www.instagram.com/dailyvideo.kg/reel/SYNTHETIC_${i}/`,
    click(){stats.opened.push(`SYNTHETIC_${i}`);if(i<(options.openTimeoutCount || 0)) return;
      current=`SYNTHETIC_${i}`;perCode[current] ||= 0;location.pathname=`/p/${current}/`;}}));
  let renderedCount=options.virtualized ? 12 : links.length;
  const rendered=()=>links.slice(0,renderedCount);
  const mainScroller={scrollHeight:10000,clientHeight:800,scrollTop:0,scrollLeft:0,parentElement:null};
  const clickExpand=()=>{perCode[current]++;stats.expansions++;};
  const reply=visible({innerText:'查看回复 (1)',click:clickExpand});
  const plainReply=visible({innerText:'回复',click(){stats.plainReplyClicks++;}});
  const more=visible({click:clickExpand});
  const svg=visible({closest:selector=>selector==='button,[role="button"]' ? more : null});
  const dialog=visible({querySelectorAll(selector){
    if (selector==='button,[role="button"]') return options.forever || perCode[current]===0 ? [reply,plainReply] : [plainReply];
    if (selector==='svg[aria-label="加载更多评论"]') return perCode[current]===1 ? [svg] : [];
    return [];
  }});
  const context=vm.createContext({URL,TextEncoder,crypto,structuredClone,location,Date:SimulationDate,scrollX:0,scrollY:0,innerHeight:800,
    setTimeout:(callback,ms)=>{if(options.openTimeoutCount)clockOffset+=ms;return setImmediate(callback);},getComputedStyle:()=>({visibility:'visible',display:'block',overflowY:options.nestedScroll?'auto':'visible'}),
    document:{documentElement:{scrollHeight:10000},querySelector:selector=>options.nestedScroll && selector==='main'?mainScroller:null,querySelectorAll(selector){
      if(selector==='[role="dialog"]') return current ? [dialog] : [];
      if(selector==='main a[href]') return current ? [] : rendered();
      return [];
    }},
    history:{back(){current='';location.pathname='/dailyvideo.kg/';}},
    scrollTo(x,y){context.scrollX=x;context.scrollY=y;},
    scrollBy(x,y){stats.windowScrolls++;context.scrollY+=y;if(options.virtualized)renderedCount+=10;},
    chrome:{storage:{local:{async get(keys){
      if(keys===null) return structuredClone(store);
      return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,structuredClone(store[key])]));
    },async getBytesInUse(){return options.fullStorage?200000001:JSON.stringify(store).length;},async set(values){
      for(const [key,value] of Object.entries(values)) store[key]=structuredClone(value);
      if(!paused && store[STATE]?.status==='running' &&
          ((options.pauseAfterTwo && store[STATE].done.length===2) ||
           (options.pauseAtDone && store[STATE].done.length===options.pauseAtDone) ||
           (options.pauseMidPost && Object.values(store[STATE].post_expansions || {}).some(n=>n===5)))) {
        store[STOP]=store[STATE].run_id;paused=true;
      }
    }}}},
    readInstagramPage(){
      const wrong = options.wrongFirst && current==='SYNTHETIC_0' || current && Number(current.split('_').at(-1))<(options.wrongCount || 0);
      return {schema:'instagram_dom_diagnostic_v1',username:'dailyvideo.kg',
        collected_at_utc:new Date().toISOString(),page_kind:current?'post':'profile',shortcode:current,
        page_url:'https://www.instagram.com'+location.pathname,
        visible_text:(wrong?'other_account':options.leadingTag && current?'tagged_person\ndailyvideo.kg':'dailyvideo.kg')+'\n'+(options.noProgress?'constant':String(perCode[current] || 0)),
        times:options.leadingTag && current?[{text:'date',datetime:'2026-10-10T10:05:02.000Z'}]:[],
        links:current ? [{url:`https://www.instagram.com/dailyvideo.kg/reel/${current}/`,text:'date'},
          {url:'https://www.instagram.com/dailyvideo.kg/',text:'dailyvideo.kg'}] : rendered().map(a=>({url:a.href,text:''})),
        controls:options.leadingTag && current?[{tag:'DIV',text:'dailyvideo.kg\nSynthetic author caption\ndate',
          times:[{text:'date',datetime:'2026-10-10T10:05:02.000Z'}]}]:[]};
    }});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'chrome_instagram_probe','data.js'),'utf8'),context);
  vm.runInContext(source,context);
  return {store,stats,context,async start(resume=false,id=''){return context.instagramAutoCollector.start('dailyvideo.kg',resume,id);},
    goProfile(){context.history.back();},
    async settled(){
      const until=Date.now()+5000;
      while(Date.now()<until){
        if(store[STATE] && store[STATE].status!=='running') return store[STATE];
        await new Promise(resolve=>setTimeout(resolve,1));
      }
      throw Error('simulation did not settle');
    }};
}
(async()=>{
  let sim=simulation();
  await sim.start();
  await assert.rejects(()=>sim.start(),/已在采集/);
  let result=await sim.settled();
  assert.equal(result.done.length,10);assert.equal(new Set(result.done).size,10);
  assert.equal(result.stop_reason,'ten_post_test_budget_reached');
  assert.equal(sim.stats.plainReplyClicks,0);assert.equal(result.expansions_used,20);
  assert.equal(result.history_complete,false);
  assert(raw(sim).some(s=>s.collection.phase==='detail_final' && s.collection_result.comments_complete===false));

  sim=simulation({totalLinks:40});await sim.start();await sim.settled();
  const firstRunId=sim.store[STATE].run_id;
  // Remove newly introduced fields to reproduce a persisted v0.2.0 checkpoint.
  for(const key of ['target_done','batch_start_done','batch_number','batch_scroll_start','scroll_limit','batch_history']) delete sim.store[STATE][key];
  await sim.start('next');result=await sim.settled();
  assert.equal(result.done.length,20);assert.equal(result.target_done,20);assert.equal(result.batch_number,2);
  assert.equal(result.run_id,firstRunId);assert.equal(new Set(sim.stats.opened).size,20);assert.equal(sim.stats.opened.length,20);
  assert.equal(result.stop_reason,'batch_post_budget_reached');
  await assert.rejects(()=>sim.start(true),/继续下一批/);
  await sim.start('next');result=await sim.settled();
  assert.equal(result.done.length,30);assert.equal(sim.stats.opened.length,30);assert.equal(new Set(sim.stats.opened).size,30);
  sim=simulation({totalLinks:30});await sim.start();await sim.settled();
  const legacyId=sim.store[STATE].run_id;delete sim.store['instagram_run_'+legacyId];
  await sim.start('next',legacyId);result=await sim.settled();assert.equal(result.done.length,20);

  sim=simulation({totalLinks:40,pauseAtDone:13});await sim.start();await sim.settled();
  await sim.start('next');result=await sim.settled();
  assert.equal(result.status,'paused');assert.equal(result.done.length,13);assert.equal(result.target_done,20);
  await assert.rejects(()=>sim.start('next'),/尚未采满/);
  await sim.start(true);result=await sim.settled();
  assert.equal(result.done.length,20);assert.equal(result.target_done,20);assert.equal(result.batch_number,2);
  assert.equal(sim.stats.opened.length,20);

  sim=simulation({totalLinks:25,virtualized:true});await sim.start();await sim.settled();
  sim.store[STATE].queue=Array.from({length:25},(_,i)=>({code:`SYNTHETIC_${i}`,url:`https://www.instagram.com/dailyvideo.kg/reel/SYNTHETIC_${i}/`}));
  await sim.start('next');result=await sim.settled();
  assert.equal(result.done.length,20);assert.equal(new Set(sim.stats.opened).size,20);
  assert(result.scrolls_used>=1);assert(result.failures.some(f=>f.reason==='queued_link_not_currently_rendered'));

  sim=simulation({pauseAfterTwo:true});await sim.start();result=await sim.settled();
  assert.equal(result.status,'paused');assert.equal(result.done.length,2);
  await sim.start(true);result=await sim.settled();
  assert.equal(result.done.length,10);assert.equal(result.resume_count,1);
  assert.equal(sim.stats.opened.length,10); // completed posts were not opened twice

  sim=simulation({forever:true,pauseMidPost:true});await sim.start();result=await sim.settled();
  assert.equal(result.status,'paused');assert.equal(result.expansions_used,5);
  await sim.start(true);result=await sim.settled();
  assert.equal(result.expansions_used,200); // per-post budget carries over on resume
  assert(Object.values(result.post_expansions).every(n=>n===20));

  sim=simulation({fewLinks:true});await sim.start();result=await sim.settled();
  assert.equal(result.done.length,2);assert.equal(result.scrolls_used,6);
  assert.equal(result.stop_reason,'list_stalled_coverage_unverified');

  sim=simulation({fewLinks:true,nestedScroll:true});await sim.start();result=await sim.settled();
  assert.equal(result.scrolls_used,6);assert.equal(sim.stats.windowScrolls,0);
  assert(result.scroll_evidence.every(e=>e.before.kind==='element' && e.after.y>e.before.y));

  sim=simulation({wrongFirst:true});await sim.start();result=await sim.settled();
  assert.equal(result.done.length,10);assert(result.deferred.includes('SYNTHETIC_0'));
  assert(!raw(sim).some(s=>s.shortcode==='SYNTHETIC_0' && s.collection.phase==='detail_final'));
  assert(raw(sim).some(s=>s.shortcode==='SYNTHETIC_0' && s.collection.phase==='detail_rejected'));

  sim=simulation({wrongCount:5,totalLinks:25,pauseAtDone:3});await sim.start();result=await sim.settled();
  assert.equal(result.done.length,3);assert.equal(Object.keys(result.skipped).length,5);
  assert.equal(result.stop_reason,'user_stop');
  await sim.start(true);result=await sim.settled();assert.equal(result.done.length,10);
  for(let i=0;i<5;i++) assert.equal(sim.stats.opened.filter(code=>code===`SYNTHETIC_${i}`).length,1);
  assert(Object.values(result.skipped).every(f=>f.reason==='post_owner_or_permalink_not_confirmed' && f.evidence));

  sim=simulation({openTimeoutCount:4,totalLinks:20});await sim.start();result=await sim.settled();
  assert.equal(result.done.length,10);assert.equal(Object.keys(result.skipped).length,4);
  assert(Object.values(result.skipped).every(f=>f.reason==='post_open_timeout'));

  sim=simulation({totalLinks:60});await sim.start();await sim.settled();
  const checkpoint=sim.store[STATE],checkpointId=checkpoint.run_id;
  checkpoint.mode='formal';checkpoint.status='paused';checkpoint.target_done=null;delete checkpoint.skipped;
  checkpoint.stop_reason='consecutive_detail_failures_pause';
  checkpoint.failures=[10,11,12].map(i=>({code:`SYNTHETIC_${i}`,reason:'post_owner_or_permalink_not_confirmed'}));
  await sim.start(true);result=await sim.settled();
  assert.equal(result.run_id,checkpointId);assert.equal(result.done.length,57);assert.equal(Object.keys(result.skipped).length,3);
  assert(!sim.stats.opened.includes('SYNTHETIC_10'));assert.notEqual(result.stop_reason,'consecutive_detail_failures_pause');

  sim=simulation({leadingTag:true});await sim.start();result=await sim.settled();
  assert.equal(result.done.length,10);assert.equal(Object.keys(result.skipped).length,0);
  assert(raw(sim).filter(s=>s.collection.phase==='detail_final').every(s=>s.identity_strategy==='account_permalink_caption_author_and_scoped_time'));

  sim=simulation({totalLinks:60});await sim.start();await sim.settled();
  const oldIdentity=sim.store[STATE];oldIdentity.mode='formal';oldIdentity.target_done=null;oldIdentity.status='paused';
  oldIdentity.collector_version='0.4.1';oldIdentity.skipped={
    SYNTHETIC_10:{code:'SYNTHETIC_10',reason:'post_owner_or_permalink_not_confirmed'},
    SYNTHETIC_11:{code:'SYNTHETIC_11',reason:'post_open_timeout'}};
  oldIdentity.failures=Object.values(oldIdentity.skipped);
  await sim.start(true);result=await sim.settled();
  assert.equal(result.done.length,59);assert(result.done.includes('SYNTHETIC_10'));
  assert(result.skipped.SYNTHETIC_11);assert(result.identity_rechecks.SYNTHETIC_10);

  const stillBad={totalLinks:60};sim=simulation(stillBad);await sim.start();await sim.settled();
  const older=sim.store[STATE];older.mode='formal';older.target_done=null;older.status='paused';older.collector_version='0.4.1';
  older.skipped={SYNTHETIC_10:{code:'SYNTHETIC_10',reason:'post_owner_or_permalink_not_confirmed'}};
  older.failures=Object.values(older.skipped);stillBad.wrongCount=11;
  await sim.start(true);result=await sim.settled();assert(result.skipped.SYNTHETIC_10);
  await sim.start(true);await sim.settled();
  assert.equal(sim.stats.opened.filter(code=>code==='SYNTHETIC_10').length,1,'identity upgrade retry must not repeat on every resume');

  const resumeOptions={pauseMidPost:true,forever:true};sim=simulation(resumeOptions);await sim.start();await sim.settled();
  resumeOptions.wrongFirst=true;await sim.start(true);result=await sim.settled();
  assert.equal(result.done.length,10);assert(result.skipped.SYNTHETIC_0);

  sim=simulation({noProgress:true});await sim.start();await sim.settled();
  assert(raw(sim).some(s=>s.collection_result?.stop_reason==='expand_no_progress_twice'));

  sim=simulation({forever:true});await sim.start();result=await sim.settled();
  assert.equal(result.expansions_used,200);
  assert(Object.values(result.post_expansions).every(n=>n===20));
  assert(raw(sim).filter(s=>s.collection.phase==='detail_final').every(s=>s.collection_result.stop_reason==='per_post_expansion_budget_reached'));

  sim=simulation();sim.store[DATA]=Array.from({length:250},()=>({old:true}));
  await sim.start();result=await sim.settled();
  assert.equal(result.done.length,10);assert.equal(sim.store[DATA].length,250);
  assert(sim.store['instagram_run_'+result.run_id]);
  const oldId=result.run_id;await sim.start();result=await sim.settled();
  assert.notEqual(result.run_id,oldId);assert(sim.store['instagram_run_'+oldId]);
  sim=simulation({fullStorage:true});await sim.start();result=await sim.settled();
  assert.equal(result.stop_reason,'storage_budget_reached_export_required');assert.equal(result.done.length,0);
  sim=simulation({totalLinks:60});await sim.start('formal');result=await sim.settled();
  assert.equal(result.done.length,60);assert.equal(result.mode,'formal');assert.equal(result.history_complete,false);
  assert.equal(result.stop_reason,'list_stalled_coverage_unverified');
  assert(fs.readFileSync(path.join(__dirname,'chrome_instagram_probe','popup.html'),'utf8').includes('id="formal"'));
  console.log('Automatic simulation passed: 60-post formal run, legacy 10/20/30, independent runs, resume, virtualization, safety and storage.');
})().catch(error=>{console.error(error);process.exitCode=1;});
