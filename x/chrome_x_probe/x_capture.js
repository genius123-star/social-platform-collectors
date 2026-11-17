/* Passive cache of public fields in normal X page responses. No extra requests or credentials. */
if(!globalThis.MediaXCapture)globalThis.MediaXCapture=(()=>{
  const version='0.6.5',posts=new Map(),requests=new WeakMap();
  const match=location.pathname.match(/^\/(\w+)\/?$/),query=new URL(location.href).searchParams.get('q')||'';
  let account=((location.pathname==='/search'?query.match(/(?:^|\s)from:(\w+)/)?.[1]:match?.[1])||'').toLowerCase(),user=null,responses=0;
  const pick=(obj,keys)=>Object.fromEntries(keys.filter(k=>obj?.[k]!==undefined).map(k=>[k,obj[k]]));
  const screen=u=>u?.core?.screen_name||u?.legacy?.screen_name;
  const own=u=>String(screen(u)||'').toLowerCase()===account;
  const safeUser=u=>({__typename:'User',rest_id:String(u.rest_id||''),core:pick(u.core,['screen_name','name']),legacy:pick(u.legacy,['screen_name','name','description','followers_count','verified','verified_type']),
    profile_bio:pick(u.profile_bio,['description']),relationship_counts:pick(u.relationship_counts,['followers']),verification:pick(u.verification,['is_blue_verified','verified_type']),...pick(u,['is_blue_verified'])});
  const tags=a=>Array.isArray(a)?a.map(v=>pick(v,['text'])):[];
  const media=a=>Array.isArray(a)?a.map(v=>({type:v.type,public_metrics:pick(v.public_metrics,['view_count'])})):[];
  function ingest(data) {
    const at=new Date().toISOString();let budget=50000;
    function visit(o,depth=0) {
      if(!o||typeof o!=='object'||--budget<0||depth>35)return;
      if(Array.isArray(o)){for(const v of o)visit(v,depth+1);return;}
      if(o.__typename==='TweetWithVisibilityResults'){visit(o.tweet,depth+1);return;}
      if(o.__typename==='User'){if(own(o))user={user:safeUser(o),at};return;}
      if(o.__typename==='Tweet') {
        const author=o.core?.user_results?.result;
        if(!own(author)||o.legacy?.retweeted_status_result||o.legacy?.in_reply_to_status_id_str)return;
        const id=String(o.rest_id||o.legacy?.id_str||'');if(!/^\d+$/.test(id))return;
        const legacy=o.legacy||{},details=o.details||{},note=o.note_tweet?.note_tweet_results?.result;
        const tweet={__typename:'Tweet',rest_id:id,core:{user_results:{result:safeUser(author)}},
          legacy:{...pick(legacy,['id_str','full_text','created_at','favorite_count','reply_count','retweet_count','quote_count','bookmark_count','truncated']),
            entities:{hashtags:tags(legacy.entities?.hashtags),media:media(legacy.entities?.media)},extended_entities:{media:media(legacy.extended_entities?.media)}},
          counts:pick(o.counts,['favorite_count','reply_count','retweet_count','quote_count','bookmark_count']),views:pick(o.views,['count']),
          details:{...pick(details,['created_at_ms','full_text','is_expandable']),hashtag_entities:tags(details.hashtag_entities)}};
        if(o.media_entities2)tweet.media_entities2=media(o.media_entities2);
        if(note)tweet.note_tweet={note_tweet_results:{result:{...pick(note,['text']),entity_set:{hashtags:tags(note.entity_set?.hashtags)}}}};
        posts.delete(id);posts.set(id,{tweet,at});if(posts.size>500)posts.delete(posts.keys().next().value);
        return;
      }
      for(const value of Object.values(o))visit(value,depth+1);
    }
    visit(data);
  }
  const allowed=value=>{try{const u=new URL(value,location.href);return u.protocol==='https:'&&['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname)&&/^\/i\/api\/graphql\/[^/]+\/(UserByScreenName|UserByRestId|TweetDetail|SearchTimeline|UserTweets|UserMedia)\/?$/.test(u.pathname);}catch{return false;}};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=function(...args){const pending=originalFetch.apply(this,args);if(allowed(typeof args[0]==='string'||args[0] instanceof URL?String(args[0]):args[0]?.url))pending.then(r=>{responses++;if(r.ok)r.clone().json().then(ingest).catch(()=>{});}).catch(()=>{});return pending;};
  const originalOpen=XMLHttpRequest.prototype.open,originalSend=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(method,url,...args){requests.set(this,allowed(url));return originalOpen.call(this,method,url,...args);};
  XMLHttpRequest.prototype.send=function(...args){if(requests.get(this))this.addEventListener('load',()=>{responses++;try{if(this.status>=200&&this.status<300)ingest(this.responseType==='json'?this.response:JSON.parse(this.responseText));}catch{}},{once:true});return originalSend.apply(this,args);};
  return {version,read(username,id,method){const key=username.toLowerCase();if(key!==account){account=key;posts.clear();user=null;}
    return {profile:user,entry:posts.get(String(id))||null,entries:method==='list'?[...posts.values()]:[],diagnostic:{version,responses,posts:posts.size}};}};
})();
