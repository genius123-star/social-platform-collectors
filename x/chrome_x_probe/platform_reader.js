/* X adapter. JSON decoding follows x_public_probe.py; no eval or session extraction. */
globalThis.MediaReader=(()=>{
  const C=MediaCore,version=C.VERSION,get=(o,p)=>p.split('.').reduce((v,k)=>v&&typeof v==='object'?v[k]:undefined,o);
  const first=(o,...paths)=>paths.map(p=>get(o,p)).find(v=>v!==null&&v!==undefined);
  const unwrap=o=>o?.__typename==='TweetWithVisibilityResults'?o.tweet:o;
  const username=o=>first(o,'core.screen_name','legacy.screen_name');
  function decode(scripts) {
    const found=[];let budget=50000;
    function visit(v,depth=0) {
      if(--budget<0||depth>35)return;
      if(typeof v==='string'&&/^[{[]/.test(v)){try{visit(JSON.parse(v),depth+1);}catch{}return;}
      if(Array.isArray(v)){for(const x of v)visit(x,depth+1);return;}
      if(v&&typeof v==='object') {
        const o=unwrap(v);
        if(['User','Tweet'].includes(o?.__typename)){found.push(o);return;}
        for(const x of Object.values(v))visit(x,depth+1);
      }
    }
    for(const text of scripts) {
      if(!/profile_bio|user_results|tweet_results/.test(text))continue;
      try{visit(JSON.parse(text));}catch{for(const match of text.matchAll(/"(?:\\.|[^"\\])*"/g)){try{visit(JSON.parse(match[0]));}catch{}}}
    }
    return found;
  }
  function profileObject(user,account,stamp) {
    if(String(username(user)||'').toLowerCase()!==account.key)return null;
    const blue=first(user,'verification.is_blue_verified','is_blue_verified'),kind=first(user,'verification.verified_type','legacy.verified_type');
    const legacy=first(user,'legacy.verified');
    return {username:username(user),account_id:String(user.rest_id||''),name:first(user,'core.name','legacy.name')||'',
      bio:first(user,'profile_bio.description','legacy.description')??null,verified:legacy===true||blue===true||/^(blue|business|government)$/i.test(kind||'')?true:blue===false&&!kind||legacy===false&&blue!==true?false:null,
      verification_type:kind||'',followers:C.metric(first(user,'relationship_counts.followers','legacy.followers_count'),'user.followers'),collected_at:stamp};
  }
  function normalize(obj,account,stamp) {
    obj=unwrap(obj);const author=get(obj,'core.user_results.result');
    if(obj?.__typename!=='Tweet'||String(username(author)||'').toLowerCase()!==account.key)return null;
    const id=String(first(obj,'rest_id','legacy.id_str')||'');
    if(!/^\d+$/.test(id))throw Error('invalid_content_id');
    // Do not attribute the original author's repost counts/body to the target account.
    if(get(obj,'legacy.retweeted_status_result'))return null;
    const note=get(obj,'note_tweet.note_tweet_results.result'),text=first(obj,'note_tweet.note_tweet_results.result.text','details.full_text','legacy.full_text');
    const rawTime=first(obj,'details.created_at_ms','legacy.created_at'),metrics={};
    for(const [field,paths]of Object.entries({likes:['counts.favorite_count','legacy.favorite_count'],comments:['counts.reply_count','legacy.reply_count'],
      shares:['counts.retweet_count','legacy.retweet_count'],quotes:['counts.quote_count','legacy.quote_count'],bookmarks:['counts.bookmark_count','legacy.bookmark_count'],views:['views.count']}))metrics[field]=C.metric(first(obj,...paths),paths[0]);
    const media=first(obj,'media_entities2','legacy.extended_entities.media','legacy.entities.media')||[];
    const plays=media.filter(m=>m.type==='video').map(m=>get(m,'public_metrics.view_count'));
    metrics.plays=plays.length===1?C.metric(plays[0],'media.public_metrics.view_count'):{raw:plays.map((p,i)=>p===undefined?'':`视频${i+1}：${p}`).filter(Boolean).join('；'),value:'',precision:plays.some(p=>p!==undefined)?'rounded':'missing',source:'per_video_public_metrics'};
    const tags=first(obj,'note_tweet.note_tweet_results.result.entity_set.hashtags','details.hashtag_entities','legacy.entities.hashtags');
    return {row:{id,url:`https://x.com/${account.username}/status/${id}`,author:username(author),author_id:String(author.rest_id||''),name:first(author,'core.name','legacy.name')||'',
      created_at:C.time(typeof rawTime==='string'&&/^\d{13}$/.test(rawTime)?Number(rawTime):rawTime),collected_at:stamp,text:typeof text==='string'?text:'',
      text_status:typeof text!=='string'?'missing':(note&&!note.text)||get(obj,'legacy.truncated')===true||(get(obj,'details.is_expandable')===true&&!note?.text)?'truncated':text?'full':'empty',tags:Array.isArray(tags)?tags.map(t=>t.text).filter(t=>typeof t==='string'):[],
      type:[...new Set(media.map(m=>({photo:'图片',video:'视频',animated_gif:'动图'}[m.type]||m.type)))].join('、')||'文本',metrics,
      source:'x_embedded_json',evidence:{id,author:username(author),text_path:note?.text?'note_tweet':'full_text'}},profile:profileObject(author,account,stamp)};
  }
  const objects=()=>decode([...document.querySelectorAll('script')].map(n=>n.textContent||''));
  function barrier() {
    if(/\/i\/flow\/login/.test(location.pathname)||document.querySelector('input[type="password"]'))return 'login_required';
    if([...document.querySelectorAll('[role="dialog"]')].some(n=>n.getClientRects().length&&/Sign in to X|登录\s*X|登入\s*X/i.test(n.innerText||'')))return 'login_required';
    if([...document.querySelectorAll('iframe[src*="captcha"], [data-testid="captcha-container"]')].some(n=>n.getClientRects().length))return 'verification_required';
    return '';
  }
  const belongs=(n,article)=>n?.closest('article')===article&&!n.closest('div[role="link"], [data-testid="quoteTweet"]');
  function nodeMetric(node,source) {
    const values=[node?.innerText,node?.getAttribute('aria-label'),node?.getAttribute('title'),...[...(node?.querySelectorAll('[aria-label], [title]')||[])].flatMap(n=>[n.getAttribute('aria-label'),n.getAttribute('title')])];
    for(const value of values) {const number=String(value||'').match(/\d[\d,.]*(?:\s?[KMB万亿])?/i)?.[0],metric=C.metric(number,source);if(metric.precision!=='missing')return metric;}
    return C.metric(null,source);
  }
  function hashtags(body) {
    const linked=[...(body?.querySelectorAll('a[href]')||[])].flatMap(a=>{try{const u=new URL(a.href);return /^\/hashtag\//.test(u.pathname)?[decodeURIComponent(u.pathname.split('/')[2])]:[];}catch{return [];}});
    return [...new Set(linked.length?linked:[...(body?.innerText||'').matchAll(/#([\p{L}\p{M}\p{N}_]+)/gu)].map(m=>m[1]))];
  }
  function card(article,account) {
    const t=[...article.querySelectorAll('time')].find(n=>belongs(n,article)),anchor=t?.closest('a[href]');
    if(!anchor)return null;
    let p;try{p=C.post('x',anchor.href,account.username);}catch{return null;}
    const header=article.querySelector('[data-testid="User-Name"]');
    if(!header||![...header.querySelectorAll('a[href]')].some(a=>new URL(a.href).pathname.toLowerCase()==='/'+account.key))return null;
    const body=[...article.querySelectorAll('[data-testid="tweetText"]')].find(n=>belongs(n,article));
    const more=[...article.querySelectorAll('[data-testid="tweet-text-show-more-link"]')].find(n=>belongs(n,article));
    const group=[...article.querySelectorAll('[role="group"]')].find(n=>belongs(n,article)&&n.querySelector('[data-testid="reply"]'));
    const metrics={};
    for(const [key,testid]of Object.entries({likes:'like',comments:'reply',shares:'retweet',bookmarks:'bookmark'})) {
      const n=group?.querySelector(`[data-testid="${testid}"], [data-testid="un${testid}"]`);
      metrics[key]=nodeMetric(n,`action.${testid}`);
    }
    const view=[...article.querySelectorAll('a[href]')].find(a=>belongs(a,article)&&new URL(a.href).pathname.toLowerCase()===`/${account.key}/status/${p.id}/analytics`);
    metrics.views=nodeMetric(view,'post.analytics_link');metrics.quotes=C.metric(null);metrics.plays=C.metric(null);
    return {...p,author:account.username,name:header.innerText.split('\n')[0]||'',created_at:C.time(t.getAttribute('datetime')),
      collected_at:new Date().toISOString(),text:body?.innerText??'',text_status:more?'truncated':body?'full':'missing',
      tags:hashtags(body),
      type:[...article.querySelectorAll('[data-testid="videoPlayer"]')].some(n=>belongs(n,article))?'视频':[...article.querySelectorAll('[data-testid="tweetPhoto"]')].some(n=>belongs(n,article))?'图片':'文本',
      metrics,source:'x_verified_article',evidence:{id:p.id,author:account.username,datetime:t.getAttribute('datetime'),text_complete:!more}};
  }
  const completeProfile=p=>p&&typeof p.bio==='string'&&typeof p.verified==='boolean'&&p.followers?.precision&&p.followers.precision!=='missing';
  function profile(account,captured) {
    const blocked=barrier();if(blocked)return {barrier:blocked};
    const stamp=new Date().toISOString(),structured=objects().map(o=>o.__typename==='User'?profileObject(o,account,stamp):profileObject(get(o,'core.user_results.result'),account,stamp)).filter(Boolean);
    if(captured?.profile){const p=profileObject(captured.profile.user,account,captured.profile.at);if(p)structured.push(p);}
    const complete=structured.filter(completeProfile).sort((a,b)=>a.collected_at.localeCompare(b.collected_at));if(complete.length)return complete.at(-1);
    if(C.target('x',location.href).key!==account.key)throw Error('profile_account_mismatch');
    const root=document.querySelector('[data-testid="primaryColumn"]')||document.querySelector('main')||document;
    const name=root.querySelector('[data-testid="UserName"]'),bio=root.querySelector('[data-testid="UserDescription"]');
    const followers=[...root.querySelectorAll('a[href]')].find(a=>new RegExp('^/'+account.username+'/(?:verified_)?followers/?$','i').test(new URL(a.href).pathname));
    const count=nodeMetric(followers,'profile.followers'),identity=new RegExp('@'+account.key+'(?![a-z0-9_])','i').test(name?.innerText||''),ready=identity&&count.precision!=='missing';
    const badge=name?.querySelector('[data-testid="icon-verified"], [aria-label="Verified account"], [aria-label="Verified"], [aria-label="认证账号"], [aria-label="已认证"]');
    const dom={username:account.username,name:name?.innerText.split('\n')[0]||'',bio:bio?.innerText??null,verified:badge?true:ready?false:null,followers:count,collected_at:stamp};
    if(ready&&completeProfile(dom))return dom;
    return {pending:true,reason:'profile_fields_not_ready'};
  }
  function searchMode(account) {
    if(location.pathname!=='/search'||C.target('x',location.href).key!==account.key)throw Error('search_account_mismatch');
    const tabs=[...document.querySelectorAll('[role="tab"]')],selected=tabs.find(n=>n.getAttribute('aria-selected')==='true');
    const isLatest=n=>{const label=n?.innerText?.trim()||'';if(/^(Top|热门|熱門|相关|相關)$/i.test(label))return false;
      if(/^(Latest|最新|最新資訊|最新内容|实时|實時)$/i.test(label))return true;
      try{return new URL(n?.href||n?.closest('a[href]')?.href).searchParams.get('f')==='live';}catch{return false;}};
    return {latest:!!selected&&isLatest(selected),tab:tabs.find(isLatest)};
  }
  function selectLatest(account) {
    const mode=searchMode(account);if(mode.latest)return true;if(!mode.tab)throw Error('x_latest_not_confirmed');mode.tab.click();return true;
  }
  function list(account,captured) {
    const blocked=barrier();if(blocked)return {barrier:blocked};
    const current=C.target('x',location.href);if(current.key!==account.key)throw Error('search_account_mismatch');
    if(location.pathname==='/search'&&!searchMode(account).latest)return {needs_latest:true,links:[],candidates:0};
    const articles=[...document.querySelectorAll('article')],rows=articles.map(a=>card(a,account)).filter(Boolean),map=new Map(rows.map(r=>[r.id,r]));
    const stamp=new Date().toISOString();
    for(const obj of objects()){const n=normalize(obj,account,stamp);if(n&&map.has(n.row.id)&&C.quality(n.row)>=C.quality(map.get(n.row.id)))map.set(n.row.id,n.row);}
    for(const entry of captured?.entries||[]){const n=normalize(entry.tweet,account,entry.at);if(n&&map.has(n.row.id)&&C.quality(n.row)>=C.quality(map.get(n.row.id)))map.set(n.row.id,n.row);}
    const empty=document.querySelector('[data-testid="emptyState"]')?.innerText||'';
    return {version,links:[...map.values()],candidates:articles.length,rejected:articles.length-rows.length,
      empty_confirmed:articles.length===0&&/No results|未找到|没有找到|无结果/i.test(empty),strategy:'x_own_timestamp_header'};
  }
  async function detail(account,id,captured) {
    const blocked=barrier();if(blocked)return {barrier:blocked};
    if(location.pathname==='/search'||location.pathname.replace(/\/$/,'').toLowerCase()==='/'+account.key) {
      if(C.target('x',location.href).key!==account.key)throw Error('search_account_mismatch');
      return {partial:true,reason:'detail_not_ready'};
    }
    if(C.post('x',location.href,account.username).id!==id)throw Error('detail_resource_changed');
    const stamp=new Date().toISOString();
    let structured=null;
    if(captured?.entry)structured=normalize(captured.entry.tweet,account,captured.entry.at);
    for(const obj of objects()){const n=normalize(obj,account,stamp);if(n?.row.id===id&&(!structured||C.quality(n.row)>C.quality(structured.row)))structured=n;}
    for(const article of document.querySelectorAll('article')) {
      let row=card(article,account);if(row?.id!==id)continue;
      const more=[...article.querySelectorAll('[data-testid="tweet-text-show-more-link"]')].find(n=>belongs(n,article));
      if(more){more.click();await new Promise(resolve=>setTimeout(resolve,500));row=card(article,account);}
      if(!row||row.id!==id)throw Error('detail_changed_after_expansion');
      if(structured&&C.quality(structured.row)>C.quality(row))return structured;
      return {row};
    }
    return structured||{partial:true,reason:'detail_not_ready'};
  }
  function openDetail(account,id) {
    const blocked=barrier();if(blocked)throw Error(blocked);
    try{if(C.post('x',location.href,account.username).id===id)return true;}catch{}
    if(C.target('x',location.href).key!==account.key)throw Error('search_account_mismatch');
    for(const article of document.querySelectorAll('article')) {
      if(card(article,account)?.id!==id)continue;
      const link=[...article.querySelectorAll('time')].find(n=>belongs(n,article))?.closest('a[href]');
      if(!link||!link.getClientRects().length)continue;
      const previous=link.getAttribute('target');link.setAttribute('target','_self');
      try{link.click();}finally{if(previous===null)link.removeAttribute('target');else link.setAttribute('target',previous);}
      return true;
    }
    throw Error('target_card_not_loaded');
  }
  function returnList(account,id,url) {
    if(C.target('x',url).key!==account.key)throw Error('search_account_mismatch');
    if(C.post('x',location.href,account.username).id!==id)throw Error('detail_resource_changed');
    history.back();return true;
  }
  function importData(data,account) {
    const values=Array.isArray(data)?data:data.schema==='media_seed_v1'?data.snapshots:[data],rows=[],profiles=[],links=[];
    for(const s of values) {
      if(s.schema==='public_history_discovery_v1') {
        if(s.platform!=='x'||s.username.toLowerCase()!==account.key)throw Error('import_account_mismatch');
        links.push(...s.links.map(l=>({...C.post('x',l.content_url,account.username),author:account.username,created_at:l.created_at_utc||''})));
      } else if(s.schema==='x_public_sample_v1') {
        if(C.target('x',s.page_url.split('/status/')[0]).key!==account.key)throw Error('import_account_mismatch');
        for(const o of s.objects||[]){if(o.__typename==='User'){const p=profileObject(o,account,s.collected_at_utc);if(p)profiles.push(p);}else{const n=normalize(o,account,s.collected_at_utc);if(n){rows.push(n.row);if(n.profile)profiles.push(n.profile);}}}
      } else if(s.metadata){const n=normalize(s.metadata,account,s.collected_at_utc);if(!s.collected_at_utc)throw Error('导入元数据必须包含实际采集时间');if(n){rows.push(n.row);if(n.profile)profiles.push(n.profile);}}
      else throw Error('unsupported_import_schema');
    }
    return {rows,profiles,links};
  }
  return {version,list,detail,profile,openDetail,returnList,selectLatest,normalize,decode,importData,card,hashtags};
})();
