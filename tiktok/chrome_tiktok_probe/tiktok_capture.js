/* Observe only normal page requests for the selected author's public item fields.
 * No requests, cookies, headers, comments, video files, or URL parameters are retained. */
if(!globalThis.MediaTikTokCapture)globalThis.MediaTikTokCapture=(()=>{
  const version='0.6.5',started=new Date().toISOString();
  let account=location.pathname.match(/^\/@([\w.]+)(?:\/|$)/)?.[1]?.toLowerCase()||'',profile=null,responses=0;
  const items=new Map(),requests=new WeakMap(),seeded=new WeakSet(),paths=new Set();
  const pick=(obj,keys)=>Object.fromEntries(keys.filter(k=>obj?.[k]!==undefined).map(k=>[k,obj[k]]));
  const allowed=value=>{try{const u=new URL(value,location.href),own=u.protocol==='https:'&&['www.tiktok.com','tiktok.com'].includes(u.hostname);
    if(own&&u.pathname.startsWith('/api/')&&!/comment|message|inbox|setting|login|passport/i.test(u.pathname)&&paths.size<12)paths.add(u.pathname);
    return own&&/^\/api\/(?:item\/detail|post\/item_list|user\/detail)\/?$/.test(u.pathname);}catch{return false;}};
  function ingest(data) {
    if(!account||!data||typeof data!=='object')return;
    const stamp=new Date().toISOString(),info=data.userInfo||data.data?.userInfo;
    if(info?.user?.uniqueId?.toLowerCase()===account)profile={user:pick(info.user,['id','uniqueId','nickname','signature','verified','privateAccount']),stats:pick(info.stats,['followerCount']),collected_at_utc:stamp};
    const candidates=[data.itemInfo?.itemStruct,data.itemStruct,...(Array.isArray(data.itemList)?data.itemList:[])];
    for(const item of candidates) {
      if(item?.author?.uniqueId?.toLowerCase()!==account||!/^\d+$/.test(String(item.id)))continue;
      const safe={...pick(item,['id','createTime','desc','isAd']),author:pick(item.author,['id','uniqueId','nickname','signature','verified','privateAccount']),
        textExtra:(item.textExtra||[]).map(t=>pick(t,['hashtagName'])),stats:pick(item.stats,['playCount','diggCount','commentCount','shareCount','collectCount']),
        statsV2:pick(item.statsV2,['playCount','diggCount','commentCount','shareCount','collectCount']),authorStats:pick(item.authorStatsV2||item.authorStats,['followerCount'])};
      items.delete(String(item.id));items.set(String(item.id),{item:safe,collected_at_utc:stamp});
      // ponytail: bounded per-page cache; older entries are reread when their card is opened.
      if(items.size>500)items.delete(items.keys().next().value);
    }
  }
  function seedEmbedded() {
    for(const id of ['__UNIVERSAL_DATA_FOR_REHYDRATION__','SIGI_STATE']) {
      const node=document.getElementById(id);if(!node||seeded.has(node))continue;
      try {
        const value=JSON.parse(node.textContent),scope=value.__DEFAULT_SCOPE__||{};
        if(id==='SIGI_STATE')ingest({itemList:Object.values(value.ItemModule||{})});
        else {ingest(scope['webapp.video-detail']);ingest(scope['webapp.user-post']);ingest(scope['webapp.user-detail']);}
        seeded.add(node);
      }catch{}
    }
  }
  const fetchOriginal=globalThis.fetch;
  const fetchHook=function(...args){const pending=fetchOriginal.apply(this,args);if(allowed(typeof args[0]==='string'||args[0] instanceof URL?String(args[0]):args[0]?.url))
    pending.then(response=>{responses++;if(response.ok)response.clone().json().then(ingest).catch(()=>{});}).catch(()=>{});return pending;};
  globalThis.fetch=fetchHook;
  const openOriginal=XMLHttpRequest.prototype.open,sendOriginal=XMLHttpRequest.prototype.send;
  const openHook=function(method,url,...args){requests.set(this,allowed(url));return openOriginal.call(this,method,url,...args);};
  XMLHttpRequest.prototype.open=openHook;
  XMLHttpRequest.prototype.send=function(...args){if(requests.get(this))this.addEventListener('load',()=>{responses++;try{if(this.status>=200&&this.status<300)ingest(this.responseType==='json'?this.response:JSON.parse(this.responseText));}catch{}},{once:true});return sendOriginal.apply(this,args);};
  return {version,read(username,id){const key=String(username).toLowerCase();if(key!==account){account=key;items.clear();profile=null;}
    seedEmbedded();return {profile,entry:items.get(String(id))||null,diagnostic:{version,started_at:started,responses,items:items.size,matched:items.has(String(id)),
      fetch_attached:globalThis.fetch===fetchHook,xhr_attached:XMLHttpRequest.prototype.open===openHook,api_paths:[...paths]}};}};
})();
