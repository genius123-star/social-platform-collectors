"use strict";
// Read only public, individually identified replies inside the verified wall object.
globalThis.VKProbeComments=(()=>{
  function read(item){
    const {node,key,rendered}=item,items=[],controls=[];
    const ids=new Set();
    const replyKey=el=>{
      const declared=el.getAttribute('data-reply-id')||el.getAttribute('data-comment-id')||el.id||'';
      const m=declared.match(/^reply(-?\d+)_(\d+)$/);
      if(m&&m[1]==='-42692593')return m[2];
      return /^\d+$/.test(declared)?declared:null;
    };
    const roots=[...node.querySelectorAll('[data-reply-id],[data-comment-id],[id^="reply-42692593_"]')].filter(el=>rendered(el)&&replyKey(el));
    const bound=el=>{for(let p=el;p&&p!==node;p=p.parentElement){
      const r=(p.getAttribute('data-post-id')||p.id||'').match(/^(?:post|wall)?(-?\d+)_(\d+)$/);
      if(r&&`wall${r[1]}_${r[2]}`!==key)return false;
    }return node.contains(el);};
    for(const root of roots){
      const id=replyKey(root);if(ids.has(id)||!bound(root))continue;
      const own=el=>{for(let p=el;p&&p!==root;p=p.parentElement)if(roots.includes(p))return false;return root.contains(el);};
      const texts=[...root.querySelectorAll('.reply_text,.wall_reply_text,[data-testid="comment-text"]')].filter(el=>rendered(el)&&own(el));
      if(texts.length!==1)continue;
      const walker=document.createTreeWalker(texts[0],NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT);let text='',part;
      while((part=walker.nextNode())&&text.length<20000){
        const el=part.nodeType===Node.TEXT_NODE?part.parentElement:part;
        if(!rendered(el)||el.closest('input,textarea,form,[contenteditable],script,style'))continue;
        if(part.nodeType===Node.TEXT_NODE)text+=part.textContent;
        else if(part.matches('img.emoji[alt]'))text+=part.alt;
      }
      const parent=root.getAttribute('data-parent-reply-id')||root.getAttribute('data-parent-comment-id')||'';
      const author=[...root.querySelectorAll('a[href]')].filter(el=>rendered(el)&&own(el)&&el.matches('.author,.reply_author,[data-testid="comment-author"]'));
      const time=[...root.querySelectorAll('a[href],time')].find(el=>{const r=VKProbeCore.resource(el.getAttribute('href'),location.href);return own(el)&&rendered(el)&&(r?.key===key&&r.reply===id||el.tagName==='TIME');});
      let authorURL='';if(author.length===1)authorURL=VKProbeCore.publicLink(author[0].getAttribute('href'),location.href)?.url||'';
      const labels=[...root.querySelectorAll('[aria-label]')].filter(el=>rendered(el)&&own(el)).map(el=>({label:el.getAttribute('aria-label')}));
      const like=VKProbeSamples.metric({fields:{interaction_bar:{status:'comment_share_common_ancestor_verified',labels}}},'like');
      items.push({resource_key:key,id,parent_id:/^\d+$/.test(parent)?parent:'',parent_status:parent?'explicit_parent_attribute':'parent_unverified',
        author_url:authorURL,text:text.trim().slice(0,20000),like_count:like.value,
        time_raw:time?.getAttribute('datetime')||time?.getAttribute('title')||time?.innerText||'',observed_at:new Date().toISOString()});ids.add(id);
      if(items.length>=500)break;
    }
    for(const el of node.querySelectorAll('button,[role="button"],a[href]')){
      if(!rendered(el)||!bound(el)||el.closest('form,[contenteditable]'))continue;
      const label=(el.getAttribute('aria-label')||el.innerText||'').trim();
      if(!/^(?:显示|展开|加载|查看)(?:更多|全部)?(?:\s*\d+\s*条?)?(?:评论|回复)$|^(?:Show|View|Load) (?:more|all|\d+) (?:comments|replies)$|^Показать (?:ещ[её]|все|\d+) (?:комментари[ияев]+|ответ[а-я]*)$/iu.test(label))continue;
      if(el.tagName==='A'){const r=VKProbeCore.resource(el.getAttribute('href'),location.href);if(!r||r.key!==key)continue;}
      controls.push(el);
    }
    return {items,controls,status:items.length?'visible_comments_partial':'no_verified_comment_structure'};
  }
  return {read};
})();
