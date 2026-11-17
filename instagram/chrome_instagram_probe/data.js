// Shared by the popup, page loop and supervisor. Legacy evidence remains untouched.
globalThis.instagramData = (() => {
  const STATE='instagram_auto_v1_state', PREFIX='instagram_run_', RAW='instagram_snapshot_';
  const START='2025-10-16T16:00:00.000Z', END='2026-10-17T16:00:00.000Z';
  const get=async key=>(await chrome.storage.local.get(key))[key];
  const code=url=>new URL(url).pathname.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/)?.[1];
  const validTime=value=>typeof value==='string' && /T.*(?:Z|[+-]\d\d:\d\d)$/i.test(value) && Number.isFinite(Date.parse(value));
  const period=value=>!validTime(value) ? 'date_pending' :
    new Date(value).toISOString()<START || new Date(value).toISOString()>=END ? 'out_of_range' : 'in_range';
  async function saveRun(run) {
    try {await chrome.storage.local.set({[PREFIX+run.run_id]:structuredClone(run),[STATE]:structuredClone(run)});}
    catch {throw Error('storage_write_failed');}
  }
  async function snapshots(runId='',username='') {
    const all=await chrome.storage.local.get(null);
    const rows=[...(all.instagram_dom_diagnostic_v1_snapshots || []),
      ...Object.entries(all).filter(([k])=>k.startsWith(RAW)).map(([,v])=>v)];
    return rows.filter(s=>(!runId || s.collection?.run_id===runId) && (!username || s.username===username))
      .sort((a,b)=>a.collected_at_utc.localeCompare(b.collected_at_utc));
  }
  async function saveSnapshot(snapshot) {
    const bytes=new TextEncoder().encode(JSON.stringify(snapshot)).length;
    if (bytes>2000000) throw Error('single_snapshot_budget_reached');
    // ponytail: native per-observation keys; add IndexedDB only if measured read/export cost warrants it.
    const used=await chrome.storage.local.getBytesInUse(null);
    if (used+bytes>200000000) throw Error('storage_budget_reached_export_required');
    try {await chrome.storage.local.set({[RAW+crypto.randomUUID()]:snapshot});}
    catch {throw Error('storage_write_failed');}
  }
  function normalize(s) {
    const name=s.username, lines=s.visible_text.split('\n'), controls=s.controls || [];
    const own=(s.links || []).filter(l=>{
      try {const u=new URL(l.url);return u.protocol==='https:' && u.host==='www.instagram.com' &&
        new RegExp('^/'+name.replaceAll('.','\\.')+'/(?:p|reel|reels)/'+s.shortcode+'/?$').test(u.pathname);} catch {return false;}
    });
    const dates=[...new Set((s.times || []).filter(t=>validTime(t.datetime) && own.some(l=>l.text && l.text===t.text)).map(t=>t.datetime))];
    const time=dates.length===1 ? dates[0] : '';
    const timeLabels=(s.times || []).filter(t=>t.datetime===time).map(t=>t.text).filter(Boolean);
    const captions=[];
    controls.forEach((c,index)=>{
      if (c.text_truncated || !c.text?.startsWith(name+'\n')) return;
      for (const t of timeLabels) {
        const clean=c.text.replace(/\n查看翻译$/,'');
        if (clean.endsWith('\n'+t)) captions.push({body:clean.slice(name.length+1,-t.length-1),index});
      }
    });
    const unique=[...new Map(captions.map(c=>[c.index+':'+c.body,c])).values()];
    const authors=new Set((s.links || []).filter(l=>{
      try{return l.text && new URL(l.url).pathname.replace(/\/$/,'')==='/'+l.text;}catch{return false;}
    }).map(l=>l.text));
    const caption=unique.length===1 ? unique[0].body : '';
    const firstComment=controls.findIndex(c=>authors.has(c.text?.split('\n')[0]) && !c.text.startsWith(name+'\n'));
    const cutoff=unique.length===1 ? unique[0].index : firstComment<0 ? controls.length : firstComment;
    const likes=controls.slice(0,cutoff).filter(c=>c.tag==='DIV' && /^[\d,.KkMm万亿]+次赞$/.test(c.text));
    const authorLinked=(s.links || []).some(l=>{
      try{const u=new URL(l.url);return u.protocol==='https:' && u.host==='www.instagram.com' &&
        u.pathname.replace(/\/$/,'')==='/'+name && l.text===name;}catch{return false;}
    });
    const captionTimes=unique.length===1?controls[unique[0].index].times || []:[];
    const captionIdentity=unique.length===1 && validTime(time) && authorLinked && captionTimes.length===1 &&
      validTime(captionTimes[0].datetime) && Date.parse(captionTimes[0].datetime)===Date.parse(time);
    const verified=own.length>0 && (lines[0]===name || captionIdentity);
    const identityStrategy=!verified?'unconfirmed':lines[0]===name?'account_permalink_and_header':'account_permalink_caption_author_and_scoped_time';
    const bjt=value=>value ? new Date(Date.parse(value)+28800000).toISOString().replace('Z','+08:00') : '';
    const number=raw=>{
      const m=String(raw || '').replaceAll(',','').match(/^([\d.]+)([KkMm万亿]?)$/);
      return m && Number.isFinite(Number(m[1])) ? Number(m[1])*({'k':1000,'m':1000000,'万':10000,'亿':100000000}[m[2].toLowerCase()] || 1) : '';
    };
    const result=s.collection_result || {};
    const post={run_id:s.collection?.run_id || '',username:name,content_id:s.shortcode,
      content_url:own[0]?.url || s.page_url,identity_status:verified?'verified':'identity_pending',identity_strategy:identityStrategy,
      created_at_utc:time,created_at_bjt:bjt(time),period_status:period(time),caption,
      caption_status:unique.length===1?'observed_author_block':'missing_or_ambiguous',
      content_type:own.some(l=>/\/(?:reel|reels)\//.test(l.url))?'reel':s.media_evidence?.type || 'unverified',
      like_count:verified && likes.length===1?number(likes[0].text.slice(0,-2)):'',
      like_count_raw:verified && likes.length===1?likes[0].text:'',
      comment_count:'',share_count:'',repost_count:'',favorite_count:'',view_count:'',play_count:'',
      metrics_missing_reason:'not_available_from_confirmed_source',
      comments_coverage:result.stop_reason || 'visible_fragments_only',comments_complete:false,replies_complete:false,
      collected_at_utc:s.collected_at_utc};
    for(const field of ['comment_count','view_count','play_count']) {
      const evidence=(s.metric_evidence || []).filter(e=>e.field===field && e.source==='confirmed_detail_outside_comment_items');
      const values=[...new Set(evidence.map(e=>e.raw))];
      if(verified && values.length===1) {post[field]=number(values[0]);post[field+'_raw']=values[0];post[field+'_source']=evidence[0].label;}
    }
    for(const field of ['like_count','comment_count','share_count','repost_count','favorite_count','view_count','play_count']) {
      post[field+'_status']=post[field]===''?'missing':post[field]===0?'explicit_zero':'observed';
      post[field+'_missing_reason']=post[field]===''?'not_available_from_confirmed_source':'';
      post[field+'_precision']=post[field]===''?'':/[KkMm万亿]/.test(post[field+'_raw'] || '')?'rounded_display':'exact_display';
    }
    const comments=[],seen=new Set();
    if (verified) controls.forEach((c,index)=>{
      if(c.tag!=='DIV' || c.text_truncated || seen.has(c.text) || (c.times || []).length>1) return;
      const [author,...rest]=c.text.split('\n');
      if (!authors.has(author) || author===name) return;
      const matches=[];
      for(const t of c.times?.length?c.times:s.times || []) {
        if(!t.text || !validTime(t.datetime) || t.datetime===time) continue;
        const value=rest.join('\n'),at=value.lastIndexOf('\n'+t.text);
        if(at<1) continue;
        const tail=value.slice(at+t.text.length+1).match(/^(?:([\d,.KkMm万亿]+)次赞)?回复(?:\n查看翻译)?$/);
        if(tail) matches.push({body:value.slice(0,at),time:t.datetime,likes:tail[1] || ''});
      }
      const bodies=new Set(matches.map(m=>m.body));
      if(bodies.size!==1) return;
      const dates=new Set(matches.map(m=>m.time)),m=matches[0];seen.add(c.text);
      const evidence=(s.comment_evidence || []).filter(e=>e.author_username===author && e.datetime===m.time && e.text.includes(m.body));
      const ids=[...new Set(evidence.map(e=>e.comment_id).filter(Boolean))];
      const parents=[...new Set(evidence.map(e=>e.parent_comment_id).filter(Boolean))];
      comments.push({run_id:post.run_id,username:name,content_id:s.shortcode,content_period_status:post.period_status,
        comment_id:ids.length===1?ids[0]:'',parent_comment_id:ids.length===1 && parents.length===1?parents[0]:'',
        relation_status:ids.length===1 && parents.length===1?'dom_parent_verified':'unverified',
        author_username:author,body:m.body,created_at_utc:dates.size===1?m.time:'',like_count:number(m.likes),
        source_locator:'controls['+index+']',collected_at_utc:s.collected_at_utc});
    });
    return {post,comments};
  }
  function tables(snapshots) {
    const posts=new Map(),comments=new Map(),observations=[],profiles=new Map();
    for(const s of snapshots.filter(s=>s.page_kind==='profile')) {
      const escaped=s.username.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const header=s.visible_text.match(new RegExp('^'+escaped+'\\n([^\\n]+)\\n([\\d,.KkMm万亿]+)\\n帖子\\n([\\d,.KkMm万亿]+)\\n粉丝\\n([\\d,.KkMm万亿]+)\\n关注(?:\\n|$)'));
      profiles.set(s.username,{username:s.username,profile_url:s.page_url,display_name:header?.[1] || '',
        total_post_count_raw:header?.[2] || '',follower_count_raw:header?.[3] || '',following_count_raw:header?.[4] || '',
        count_precision:'display_value_retained_not_exact_if_abbreviated',collected_at_utc:s.collected_at_utc});
    }
    for(const s of snapshots.filter(s=>s.page_kind==='post' && s.collection?.phase!=='detail_rejected')) {
      const value=normalize(s),old=posts.get(s.shortcode);
      // Preserve the coherent better observation; never combine maxima from different times.
      const score=p=>Number(p.identity_status==='verified')*100+Number(!!p.created_at_utc)*10+Number(!!p.caption)*10+
        ['like_count','comment_count','view_count','play_count'].filter(k=>p[k]!=='').length;
      if(!old || score(value.post)>=score(old)) posts.set(s.shortcode,value.post);
      for(const c of value.comments) {
        observations.push(c);
        if(c.comment_id) comments.set(c.content_id+':'+c.comment_id,c);
      }
    }
    return {profiles:[...profiles.values()],posts:[...posts.values()],comments:[...comments.values()],comment_observations:observations};
  }
  return {STATE,PREFIX,START,END,get,saveRun,snapshots,saveSnapshot,normalize,tables,period};
})();
