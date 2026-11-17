"use strict";
// One click, one public-page snapshot. No navigation, requests or input values.
globalThis.localPandaDiagnostics = (() => {
  const version='0.6.9';let target=null;
  const blocked='script,style,template,noscript,iframe,input,textarea,select,option,[role="textbox"],[role="navigation"],[role="banner"],[aria-label*="Messenger"],[aria-label*="聊天"],[data-pagelet*="Chat"],[contenteditable]:not([contenteditable="false"]),#local-panda-collector-panel';
  const controlLabel=/^(?:关闭|Close|赞|Like|Likes|留下心情|评论|发表评论|Comments?|最相关.*|所有评论|全部评论|由新到旧|Most relevant|All comments|Newest|查看.*评论|查看更多.*|查看.*回复|View .*comments|View .*replies|See more.*|展开|隐藏翻译|查看翻译|See translation|Hide translation|Share\b.*|分享.*|静音|取消静音|Mute|Unmute|播放|暂停|Play|Pause|搜索 Reels|上一.*|下一.*|菜单|Menu|Localpanda.*|查看所有者个人主页)$/i;
  function clean(raw) {
    try {
      const u=new URL(raw,location.href);if(u.hostname!=='www.facebook.com')return '';
      const q=new URLSearchParams();
      for(const key of ['id','fbid','story_fbid','comment_id','reply_comment_id'])if(u.searchParams.has(key))q.set(key,u.searchParams.get(key));
      return u.origin+u.pathname+(q.size?'?'+q:'');
    }catch{return '';}
  }
  const route=raw=>{try{const u=new URL(clean(raw));return u.pathname.replace(/\/$/,'').toLowerCase()+'?'+['id','fbid','story_fbid'].map(k=>u.searchParams.get(k)||'').join(':');}catch{return '';}};
  const publicText=node=>{
    const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let value='',part;
    while((part=walker.nextNode())) {
      if(!part.parentElement.closest(blocked))value+=' '+part.nodeValue;
      if(value.length>1800)break;
    }
    return value.replace(/[\s\uFEFF]+/g,' ').trim().slice(0,1800);
  };
  const rect=node=>{const r=node.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};};
  const shown=node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&!node.closest('[hidden],[aria-hidden="true"],[inert]');};
  function ownerLink(root) {
    return [...root.querySelectorAll('a[href]')].some(a=>{
      if(a.closest(blocked))return false;
      return localPandaTarget.same(a.href,target);
    });
  }
  function capture({allowedPostUrls=[],target:requested}={}) {
    target=localPandaTarget.parse(requested?.profile_url);if(!target)throw new Error('diagnostic_target_missing');
    if(location.hostname!=='www.facebook.com')throw new Error('diagnostic_target_not_allowed');
    if(/\/login|\/checkpoint|\/two_step_verification|\/challenge/i.test(location.pathname)||
      [...document.querySelectorAll('input[type="password"],iframe[src*="captcha"],[id*="captcha"]')].some(shown)||
      /access denied|verify you are human|security check|访问受限|安全验证/i.test(document.title)||
      [...document.querySelectorAll('[role="alert"]')].filter(shown).some(n=>/temporarily blocked|try again later|操作过于频繁|访问受到限制/i.test(publicText(n))))
      throw new Error('diagnostic_login_or_restriction_stop');
    const onProfile=localPandaTarget.same(location.href,target);
    const knownDetail=allowedPostUrls.some(url=>route(url)===route(location.href)&&route(url));
    if(!onProfile&&!knownDetail)throw new Error('diagnostic_detail_not_in_saved_target_posts');
    const hasPostTitle=root=>{
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
      while((node=walker.nextNode()))if(!node.parentElement.closest(blocked)&&/的帖子|['’]s post/i.test(node.nodeValue)) {
        let parent=node.parentElement;
        for(let i=0;parent&&root.contains(parent)&&i<3;i++,parent=parent.parentElement)
          if(/(?:的帖子|['’]s\s+post)$/i.test(publicText(parent)))return true;
      }
      return false;
    };
    const candidates=[...document.querySelectorAll('[role="dialog"]')].filter(shown).filter(n=>ownerLink(n)&&(knownDetail||hasPostTitle(n)));
    let roots=candidates.filter(n=>!candidates.some(parent=>parent!==n&&parent.contains(n)));
    let kind=knownDetail?'known_post_viewer':'profile_post_dialog';
    if(!roots.length&&onProfile) {
      const main=document.querySelector('main,[role="main"]');
      const h=main&&[...main.querySelectorAll('h1,h2,h3,[role="heading"]')].find(n=>shown(n)&&/^(帖子|Posts)$/.test(publicText(n))&&!n.closest('[role="article"],[role="dialog"]'));
      roots=h?[...main.querySelectorAll('[role="article"]')].filter(n=>{
        if(n.parentElement.closest('[role="article"]')||n.closest('[role="dialog"]')||!shown(n)||!(h.compareDocumentPosition(n)&Node.DOCUMENT_POSITION_FOLLOWING))return false;
        const first=[...n.querySelectorAll('a[href]')].find(a=>a.closest('[role="article"]')===n&&!a.closest(blocked)&&!localPandaTarget.isStoryLink(a.href));
        const url=first&&clean(first.getAttribute('href'));
        return url&&localPandaTarget.same(url,target);
      }):[];
      kind='profile_post_list';
    }
    if(!roots.length)throw new Error('diagnostic_public_target_root_not_confirmed');
    const id=crypto.randomUUID(),at=new Date().toISOString(),rows=[],limit=1800;let truncated=false;
    const publicCommentDialog=node=>{
      if(!knownDetail)return false;
      const links=[...node.querySelectorAll('a[href]')].filter(a=>/[?&](?:reply_)?comment_id=/.test(a.href)&&/\/(?:reel|videos|posts|permalink)\//.test(new URL(a.href).pathname));
      return links.length>0&&links.every(a=>route(a.href)===route(location.href));
    };
    function walk(node,parent,rootId,depth) {
      if(rows.length>=limit){truncated=true;return;}
      if(node.matches(blocked))return;
      const index=rows.length,r=rect(node),s=getComputedStyle(node);
      const area=r.width*r.height,intersection=Math.max(0,Math.min(r.x+r.width,innerWidth)-Math.max(r.x,0))*Math.max(0,Math.min(r.y+r.height,innerHeight)-Math.max(r.y,0));
      const label=node.getAttribute('aria-label')||'',readControl=controlLabel.test(label);
      const ownText=[...node.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.nodeValue).join(' ').replace(/\s+/g,' ').trim();
      const numeric=/^\d[\d,.\s]*(?:[KMB万亿]|次|条)?$/i.test(ownText);
      const isMessage=node.matches('[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-testid="post_message"],[data-testid="comment_message"]');
      const u=node.matches('a[href]')?clean(node.href):'';
      const safeLink=u&&(/\/(?:reel|videos|posts|permalink|photos)\/|\/(?:photo|story)\.php/.test(new URL(u).pathname)||localPandaTarget.same(u,target));
      const data={record_type:'diagnostic_node',root_id:rootId,node_id:index,parent_id:parent,depth,tag:node.tagName.toLowerCase(),role:node.getAttribute('role')||'',
        rect_json:JSON.stringify(r),viewport_fraction:area?Math.round(intersection/area*1000)/1000:0,
        css_display:s.display,css_visibility:s.visibility,css_opacity:s.opacity,aria_hidden_ancestor:!!node.closest('[aria-hidden="true"],[hidden],[inert]'),
        aria_label:readControl?label:'',text:isMessage||readControl?publicText(node):(numeric?ownText:''),public_url:safeLink?u:'',
        data_ad_preview:node.getAttribute('data-ad-preview')==='message'?'message':'',
        video_paused:node.tagName==='VIDEO'?node.paused:'',video_current_time:node.tagName==='VIDEO'?node.currentTime:'',video_ready_state:node.tagName==='VIDEO'?node.readyState:''};
      rows.push(data);
      if(depth>=48){if(node.children.length)truncated=true;return;}
      if(node.matches('svg,canvas')||(depth>0&&node.matches('[role="dialog"]')&&!publicCommentDialog(node)))return;
      for(const child of node.children)walk(child,index,rootId,depth+1);
    }
    roots.slice(0,4).forEach((root,i)=>walk(root,'',i,0));
    if(roots.length>4)truncated=true;
    return {id,rows,metadata:{record_type:'diagnostic_metadata',version,collected_at_utc:at,profile_url:target.profile_url,
      observed_public_url:clean(location.href),page_kind:kind,roots_found:roots.length,node_count:rows.length,truncated,
      viewport_width:innerWidth,viewport_height:innerHeight,
      scope:'public element structure; not research metrics; no scripts, inputs, cookies or requests'}};
  }
  function download(report) {
    const rows=[report.metadata,...report.rows],fields=[...new Set(rows.flatMap(r=>Object.keys(r)))];
    const quote=value=>'"'+String(value??'').replaceAll('"','""')+'"';
    const csv='\uFEFF'+[fields,...rows.map(r=>fields.map(k=>r[k]))].map(r=>r.map(quote).join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');
    const filename='facebook_structure_probe_'+report.metadata.collected_at_utc.replace(/[:.]/g,'-')+'.csv';
    a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);return filename;
  }
  async function run(config) {
    const report=capture(config);let warning='';
    try{await chrome.storage.local.set({['lp_fb_diagnostic_'+report.id]:report});}catch{warning='本地存储失败，仍已发起CSV下载';}
    return {ok:true,filename:download(report),nodes:report.rows.length,truncated:report.metadata.truncated,warning};
  }
  async function safeRun(config) {
    try{return await run(config);}
    catch(error){return {ok:false,error_code:/^diagnostic_[a-z_]+$/.test(error?.message||'')?error.message:'diagnostic_internal_error',
      error_name:error?.name||'Error',version,observed_public_url:clean(location.href)};}
  }
  return {capture,download,run,safeRun};
})();
