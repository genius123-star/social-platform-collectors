/* TikTok adapter. Reuses the existing identity-bound, whitelisted page reader. */
globalThis.MediaReader=(()=>{
  const C=MediaCore,version=C.VERSION;
  function normalize(snapshot,account) {
    if(snapshot.username?.toLowerCase()!==account.key)throw Error('snapshot_account_mismatch');
    const candidate=(snapshot.items||[]).find(v=>String(v.item?.id)===snapshot.content_id&&v.item?.author?.uniqueId?.toLowerCase()===account.key);
    if(!candidate)return null;
    const i=candidate.item,m=Object.keys(i.statsV2||{}).length?i.statsV2:i.stats||{},stamp=snapshot.collected_at_utc;
    const metrics={};
    for(const [name,key]of Object.entries({likes:'diggCount',comments:'commentCount',shares:'shareCount',bookmarks:'collectCount',plays:'playCount'}))metrics[name]=C.metric(m[key],candidate.script+'.'+key);
    const profile=snapshot.profile||{},u=profile.user||i.author||{},visible=profile.visible||{};
    return {row:{id:snapshot.content_id,url:snapshot.page_url,author:i.author.uniqueId,author_id:String(i.author.id||''),name:i.author.nickname||'',created_at:C.time(Number(i.createTime)),
      collected_at:stamp,text:typeof i.desc==='string'?i.desc:'',text_status:typeof i.desc==='string'?(i.desc?'full':'empty'):'missing',
      type:snapshot.page_url.includes('/photo/')?'图片轮播':'视频',tags:[...new Set((i.textExtra||[]).filter(x=>x.hashtagName).map(x=>x.hashtagName))],
      metrics,source:'tiktok_embedded_json',evidence:{script:candidate.script,id:String(i.id),author:i.author.uniqueId}},
      profile:{username:u.uniqueId||snapshot.username,account_id:u.id||'',name:u.nickname||visible.display_name||'',bio:u.signature??visible.bio_raw??null,
        verified:typeof u.verified==='boolean'?u.verified:null,followers:C.metric(profile.stats?.followerCount??visible.follower_count_raw,'profile'),collected_at:profile.collected_at_utc||stamp}};
  }
  function list(account,captured) {
    const current=C.target('tiktok',location.href);
    if(current.key!==account.key)throw Error('list_account_mismatch');
    const s=readTikTokPage();
    if(s.status!=='observed')return {barrier:s.status};
    const u=s.profile.user||{},v=s.profile.visible||{};
    const links=s.links.map(link=>{const p=C.post('tiktok',link.content_url,account.username);return {...p,type:p.type==='photo'?'图片轮播':'视频',author:account.username,text:link.aria_label||'',created_at:'',pinned:/置顶|Pinned/i.test((link.text||'')+' '+(link.aria_label||''))};});
    return {version,links,profile:{username:account.username,account_id:u.id||'',name:u.nickname||v.display_name||'',bio:u.signature??v.bio_raw??null,
      verified:typeof u.verified==='boolean'?u.verified:null,followers:C.metric(s.profile.stats?.followerCount??v.follower_count_raw,'profile'),collected_at:s.collected_at_utc},
      candidates:document.querySelectorAll('a[href*="/video/"],a[href*="/photo/"]').length,rejected:0,empty_confirmed:false,strategy:'tiktok_verified_profile_links'};
  }
  function detail(account,id,captured) {
    if(location.pathname.replace(/\/$/,'')==='/@'+account.username)return {partial:true,reason:'detail_not_ready'};
    const own=C.post('tiktok',location.href,account.username);
    if(own.id!==id)throw Error('detail_resource_changed');
    const s=readTikTokPage();
    if(/private|verification|login|restricted/.test(s.status))return {barrier:s.status};
    const cached=captured?.entry;
    if(cached?.item?.author?.privateAccount)return {barrier:'private_account_stop'};
    const response=cached&&normalize({...s,items:[{script:'normal_page_response',item:cached.item}],collected_at_utc:cached.collected_at_utc,
      profile:captured.profile||{user:cached.item.author,stats:cached.item.authorStats}},account);
    const embedded=normalize(s,account),result=response&&(!embedded||C.quality(response.row)>=C.quality(embedded.row))?response:embedded;
    if(!result) {
      const v=s.visible_metrics||{},body=v['browse-video-desc']??v['video-desc'],author=(v['browser-nickname']||'').split('\n')[0].trim().replace(/^@/,'').toLowerCase();
      if(author===account.key&&typeof body==='string') {
        const metrics={};for(const [name,key]of Object.entries({likes:'like-count',comments:'comment-count',shares:'share-count',bookmarks:'collect-count'}))metrics[name]=C.metric(v[key],'visible_detail.'+key);
        metrics.plays=C.metric(null);const time=document.querySelector('[data-e2e="browser-nickname"]')?.parentElement?.querySelector('time[datetime]');
        return {row:{...own,author:account.username,collected_at:s.collected_at_utc,created_at:C.time(time?.getAttribute('datetime')),text:body,text_status:'truncated',
          type:own.type==='photo'?'图片轮播':'视频',tags:[...new Set([...body.matchAll(/#([\p{L}\p{N}_]+)/gu)].map(m=>m[1]))],metrics,source:'tiktok_visible_detail',
          evidence:{id,author:account.username,reason:'detail_structure_unavailable',capture:captured?.diagnostic||null}}};
      }
      return {partial:true,reason:'detail_structure_unavailable',evidence:{url:s.page_url,status:s.status,visible_metrics:v,capture:captured?.diagnostic||null}};
    }
    return result;
  }
  function profile(account,captured){const result=list(account,captured);return result.barrier?{barrier:result.barrier}:result.profile;}
  function openDetail(account,id) {
    try{if(C.post('tiktok',location.href,account.username).id===id)return true;}catch{}
    if(C.target('tiktok',location.href).key!==account.key)throw Error('list_account_mismatch');
    if(location.pathname.replace(/\/$/,'').toLowerCase()!=='/@'+account.key)throw Error('return_to_profile_required');
    const link=[...document.querySelectorAll('a[href]')].find(a=>{try{return a.getClientRects().length>0&&C.post('tiktok',a.href,account.username).id===id;}catch{return false;}});
    if(!link)throw Error('target_card_not_loaded');
    const previous=link.getAttribute('target');link.setAttribute('target','_self');
    try{link.click();}finally{if(previous===null)link.removeAttribute('target');else link.setAttribute('target',previous);}
    return true;
  }
  function returnList(account,id) {
    if(location.pathname.replace(/\/$/,'').toLowerCase()==='/@'+account.key)return true;
    if(C.post('tiktok',location.href,account.username).id!==id)throw Error('detail_resource_changed');
    history.back();return true;
  }
  function importData(data,account) {
    const values=Array.isArray(data)?data:data.schema==='media_seed_v1'?data.snapshots:[data],rows=[],profiles=[],links=[];
    for(const s of values) {
      if(s.schema==='public_history_discovery_v1') {
        if(s.platform!=='tiktok'||s.username.toLowerCase()!==account.key)throw Error('import_account_mismatch');
        links.push(...s.links.map(l=>({...C.post('tiktok',l.content_url,account.username),author:account.username})));
      } else if(s.schema==='tiktok_page_probe_v1') {
        const result=normalize(s,account);
        if(result){rows.push(result.row);profiles.push(result.profile);}else if(s.username?.toLowerCase()!==account.key)throw Error('import_account_mismatch');
      } else throw Error('unsupported_import_schema');
    }
    return {rows,profiles,links};
  }
  return {version,list,detail,profile,openDetail,returnList,importData,normalize};
})();
