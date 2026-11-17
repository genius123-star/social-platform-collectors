"use strict";
globalThis.localPandaPageReader = function ({checkpoint=async()=>{},gate=async()=>{},commentExpansionLimit=()=>5}={}) {
  const clock=()=>globalThis.localPandaTiming?.clock()??performance.now();
  const delay=ms=>globalThis.localPandaTiming?.delay(ms)??new Promise(resolve=>setTimeout(resolve,ms));
  let target=null,profileURL='';
  const setTarget=value=>{const parsed=localPandaTarget.parse(value?.profile_url);if(!parsed)throw new Error('invalid_target_profile');target={...parsed,name:value.name||parsed.name};profileURL=target.profile_url;activeItem=null;phase='profile';};
  const isAuthor=url=>localPandaTarget.same(url,target);
  let activeItem=null,phase='profile';
  const isProfile=()=>localPandaTarget.same(location.href,target);
  const visible=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0;};
  const clean=raw=>{try {const u=new URL(raw,location.href);if(!['facebook.com','www.facebook.com'].includes(u.hostname))return '';const q=new URLSearchParams();for(const k of ['story_fbid','id','fbid','comment_id','reply_comment_id'])if(u.searchParams.has(k))q.set(k,u.searchParams.get(k));return 'https://www.facebook.com'+u.pathname+(q.size?'?'+q:'');}catch{return '';}};
  function restriction() {
    if(/\/two_step_verification|\/checkpoint|\/challenge|\/login/i.test(location.pathname))return 'login_or_verification_required';
    if(location.hostname!=='www.facebook.com')return 'navigation_left_target_profile';
    if(/access denied|verify you are human|security check|访问受限|安全验证/i.test(document.title))return 'access_restricted';
    if([...document.querySelectorAll('input[type=password],iframe[src*="captcha"],iframe[title*="captcha" i],[id*="captcha"]')].some(visible))return 'login_or_verification_required';
    if([...document.querySelectorAll('[role="alert"]')].filter(visible).some(n=>/temporarily blocked|try again later|暂时被封锁|操作过于频繁|访问受到限制/i.test(n.innerText)))return 'access_restricted';
    if(!isProfile()) {
      if(activeItem&&matchingDialog(activeItem))return ''; // A verified own-post modal may update the background URL.
      // An opened post can legitimately update the URL without leaving the feed.
      // Bind the allowed detail to the resource discovered on the target profile.
      const detailRoute=/\/(?:reel|videos|posts|permalink|photos)\/|^\/(?:story|photo)\.php$/i.test(location.pathname);
      if(!activeItem||!detailRoute)return 'navigation_left_target_profile';
      const routeMatches=comments.postKey(location.href)===activeItem.key;
      const overlayMatches=!!matchingDialog(activeItem);
      if(!routeMatches&&!overlayMatches)return 'navigation_left_target_profile';
    }
    return '';
  }
  const comments=localPandaCommentReader({visible,restricted:()=>!!restriction(),cleanLink:clean});
  const text=comments.text;
  const dialogs=()=>[...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const own=(root,node)=>{
    const article=node.closest('[role="article"]');
    if(root.matches('[role="article"]'))return article===root;
    if(!article)return true;
    const parent=article.parentElement.closest('[role="article"]');
    return (!parent||!root.contains(parent)) && ![...article.querySelectorAll('a[href]')]
      .some(a=>a.closest('[role="article"]')===article&&/[?&](?:reply_)?comment_id=/.test(a.href));
  };
  const timeish=s=>/^(?:\d+\s*(?:天|小时|分钟|周|年|[smhdwy])|\d{1,4}[年月/.-]|昨天|刚刚|Yesterday|Just now|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))/i.test(s.trim());
  const messageSelector='[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-testid="post_message"]';
  // Recognition only: never manufacture an exact timestamp from these labels.
  const localizedTimeish=s=>timeish(s)||/^(?:il y a\s+\d|hace\s+\d|há\s+\d|aujourd’hui|aujourd'hui|hier|ayer|hoje|ontem|justo ahora|à l’instant|à l'instant|\d+\s*(?:min(?:utes?)?|heures?|jours?|semaines?|mois|ans?|horas?|d[ií]as?|semanas?|meses?|a[nñ]os?)\b|(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|lunes|martes|miércoles|jueves|viernes|sábado|domingo)[,\s]|\d{1,2}\s+(?:de\s+)?(?:janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|janeiro|fevereiro|março|maio|junho|julho|setembro|outubro)\b)/iu.test(s.trim());
  function resource(root) {
    const links=[...root.querySelectorAll('a[href]')].filter(a=>visible(a)&&own(root,a)&&!/[?&](?:reply_)?comment_id=/.test(a.href));
    const dates=links.filter(a=>comments.postKey(a.href)&&[a.innerText,a.getAttribute('aria-label')||'',a.getAttribute('title')||''].some(timeish));
    let method='unique_dated_resource';
    if(!dates.length){
      const message=[...root.querySelectorAll(messageSelector)].find(n=>own(root,n));
      const author=links.find(a=>!comments.postKey(a.href)&&!localPandaTarget.isStoryLink(a.href)&&localPandaTarget.parse(a.href));
      if(message&&author&&isAuthor(author.href)){
        const localized=links.filter(a=>comments.postKey(a.href)&&
          !!(author.compareDocumentPosition(a)&Node.DOCUMENT_POSITION_FOLLOWING)&&
          !!(a.compareDocumentPosition(message)&Node.DOCUMENT_POSITION_FOLLOWING)&&
          !a.querySelector('img,video')&&[a.innerText,a.getAttribute('aria-label')||'',a.getAttribute('title')||''].some(localizedTimeish));
        dates.push(...localized);method='localized_header_date_before_body';
      }
    }
    const keys=new Set(dates.map(a=>comments.postKey(a.href)));
    if(keys.size!==1)return null;
    const anchor=dates[0],url=new URL(clean(anchor.href));
    url.searchParams.delete('comment_id');url.searchParams.delete('reply_comment_id');
    return {key:[...keys][0],url:url.href,anchor,resource_method:method};
  }
  function headerAuthor(root,dateAnchor){
    // A live story replaces the avatar's profile URL with /stories/... .
    // Use only links before this post's own date; body mentions and translations
    // must never establish authorship. The first non-story candidate still has
    // to match the bound account, so shared/foreign headers are not bypassed.
    const links=[...root.querySelectorAll('a[href]')].filter(a=>visible(a)&&own(root,a)&&
      !!(a.compareDocumentPosition(dateAnchor)&Node.DOCUMENT_POSITION_FOLLOWING)&&
      !comments.postKey(a.href)&&!/[?&](?:reply_)?comment_id=/.test(a.href)&&!localPandaTarget.isStoryLink(a.href));
    const first=links[0];if(!first||isAuthor(first.href)||localPandaTarget.parse(first.href))return first||null;
    // Skip non-profile decorators only when the first actual profile is a
    // heading author. A foreign first profile is never bypassed.
    const profile=links.find(a=>localPandaTarget.parse(a.href));
    return profile?.closest('h2,h3,[role="heading"]')?profile:first;
  }
  function heading() {
    const main=document.querySelector('[role="main"],main');
    return main&&[...main.querySelectorAll('h1,h2,h3,[role="heading"]')].find(n=>visible(n)&&/^(帖子|Posts|Publications|Publicaciones|Publicações)$/i.test(text(n))&&!n.closest('[role="dialog"],[role="article"]'));
  }
  function discover() {
    const evidence={profile_url:clean(location.href),bound_profile_url:target?.profile_url||'',
      heading_found:false,counts:{},rejected:[],accepted_keys:[],rendered_message_cards:0};
    const reject=(reason,article,r=null,author=null)=>{
      evidence.counts[reason]=(evidence.counts[reason]||0)+1;
      if(evidence.rejected.length<12)evidence.rejected.push({reason,post_key:r?.key||'',
        author_url:author?clean(author.href):'',messages:article.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-testid="post_message"]').length});
    };
    const h=heading();if(!h)return {error:'posts_section_not_found',items:[],evidence};
    evidence.heading_found=true;
    const main=h.closest('[role="main"],main'),seen=new Set(),items=[],covered=new Set();
    const accept=(article,r,author,strategy)=>{
      seen.add(r.key);items.push({...r,node:article,source_body:body(article),discovery_strategy:strategy,
        author_evidence:{method:'verified_header_profile_before_own_date',url:clean(author.href),name:text(author)},
        list_position:{top:article.getBoundingClientRect().top+scrollY,observed_at_utc:new Date().toISOString()}});
      for(const m of article.querySelectorAll(messageSelector))covered.add(m);
    };
    for(const article of main.querySelectorAll('[role="article"]')) {
      if(!visible(article)||article.closest('[role="dialog"]')||article.parentElement.closest('[role="article"]'))continue;
      if(!(h.compareDocumentPosition(article)&Node.DOCUMENT_POSITION_FOLLOWING)){reject('before_posts_heading',article);continue;}
      if(article.querySelector('[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-testid="post_message"]'))evidence.rendered_message_cards++;
      const r=resource(article);if(!r){reject('unique_dated_resource_missing',article);continue;}
      if(seen.has(r.key)){reject('duplicate_resource',article,r);continue;}
      const author=headerAuthor(article,r.anchor);
      if(!author){reject('header_author_missing',article,r);continue;}
      if(!isAuthor(author.href)){reject('header_author_target_mismatch',article,r,author);continue;}
      accept(article,r,author,r.resource_method==='unique_dated_resource'?'article_header':'article_localized_header');
    }
    // Bounded fallback for a message card whose outer wrapper lacks role=article.
    // Require one body, no nested articles, a unique date and the same author;
    // preserve the Posts boundary so Featured and sidebars cannot become posts.
    let adaptedBodies=0;
    for(const message of [...main.querySelectorAll(messageSelector)].slice(0,100)){
      if(covered.has(message)||!visible(message)||message.closest('[role="article"],[role="dialog"]')||
        !(h.compareDocumentPosition(message)&Node.DOCUMENT_POSITION_FOLLOWING))continue;
      adaptedBodies++;
      for(let root=message.parentElement,depth=0;root&&root!==main&&depth<8;root=root.parentElement,depth++){
        if(root.querySelector('[role="article"]')||root.querySelectorAll(messageSelector).length!==1)break;
        if(!(h.compareDocumentPosition(root)&Node.DOCUMENT_POSITION_FOLLOWING)||!visible(root))continue;
        const r=resource(root);if(!r)continue;
        if(!(r.anchor.compareDocumentPosition(message)&Node.DOCUMENT_POSITION_FOLLOWING))continue;
        const author=headerAuthor(root,r.anchor);if(!author||!isAuthor(author.href))continue;
        const action=commentAction(root);if(!action||action.ambiguous)continue;
        if(!seen.has(r.key))accept(root,r,author,'message_ancestor_verified_comment_bar');
        break;
      }
    }
    evidence.rendered_message_cards+=adaptedBodies;
    evidence.adaptive_strategies=[...new Set(items.map(item=>item.discovery_strategy))];
    evidence.accepted_keys=items.map(item=>item.key);
    return {error:'',items,evidence};
  }
  async function locateSource(item,row,stage) {
    const started=clock(),hint=item.list_position?.top;
    const evidence={stage,expected_post_key:item.key,started_at_utc:new Date().toISOString(),
      position_hint:Number.isFinite(hint)?hint:null,max_wait_ms:6500,max_position_restores:1,position_restore_count:0,samples:[]};
    const finish=status=>{
      evidence.status=status;evidence.elapsed_ms=clock()-started;
      if(row){const prior=JSON.parse(row.source_relocation_evidence_json||'[]');
        row.source_relocation_evidence_json=JSON.stringify([...prior,evidence].slice(-8));}
    };
    try {
      while(clock()-started<6500) {
        await gate();const reason=restriction();if(reason)throw new Error(reason);
        if(clock()-started>=6500)break;
        if(!isProfile()||dialogs().length)throw new Error('unexpected_page_or_dialog_during_source_relocation');
        const found=discover(),matches=found.items.filter(value=>value.key===item.key);
        evidence.samples.push({elapsed_ms:clock()-started,scroll_top:scrollY,scope_status:found.error||'confirmed_posts_scope',
          expected_id_matches:matches.length,visible_post_keys:found.items.map(value=>value.key).slice(0,30)});
        if(matches.length===1){Object.assign(item,matches[0]);finish('confirmed');return item;}
        if(!evidence.position_restore_count&&Number.isFinite(hint)) {
          window.scrollTo({top:Math.max(0,hint-innerHeight*0.25),behavior:'instant'});
          evidence.position_restore_count++;
        }
        await delay(250);
      }
      finish('budget_exhausted');throw new Error('source_post_no_longer_discoverable');
    } catch(error) {
      if(!evidence.status){evidence.error=String(error.message||error);finish('interrupted');}
      throw error;
    }
  }
  const linkEvidence=(root,onlyOwn=false)=>[...root.querySelectorAll('a[href]')].filter(a=>!onlyOwn||own(root,a)).map(a=>({url:clean(a.href),text:visible(a)?a.innerText:'',aria_label:a.getAttribute('aria-label')||'',title:a.getAttribute('title')||''})).filter(x=>x.url);
  const timeEvidence=root=>[...root.querySelectorAll('time,abbr[data-utime]')].filter(n=>own(root,n)).map(n=>({text:n.innerText,datetime:n.getAttribute('datetime'),unix_time:n.getAttribute('data-utime'),title:n.getAttribute('title')}));
  const controlEvidence=root=>[...root.querySelectorAll('button,[role="button"]')].filter(n=>visible(n)&&own(root,n)).map(n=>({text:n.innerText,aria_label:n.getAttribute('aria-label')||'',aria_busy:!!n.closest('[aria-busy="true"]'),disabled:!!n.disabled||n.getAttribute('aria-disabled')==='true'}));
  function structuredTimes(item) {
    const result=[];let budget=1000;
    const visit=(value,source)=>{
      if(!value||typeof value!=='object'||budget--<=0)return;
      const urls=[value.url,value['@id']].filter(v=>typeof v==='string');
      if(urls.some(url=>comments.postKey(url)===item.key)) {
        for(const field of ['datePublished','uploadDate'])if(typeof value[field]==='string')
          result.push({source,field,datetime:value[field],matched_resource:urls.find(url=>comments.postKey(url)===item.key)});
      }
      for(const v of Object.values(value))if(v&&typeof v==='object')visit(v,source);
    };
    [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0,10).forEach((node,i)=>{
      const raw=node.textContent||'';if(raw.length>1000000)return;
      try{visit(JSON.parse(raw),'public_JSON_LD_script['+i+']');}catch{}
    });
    const og=document.querySelector('meta[property="og:url"]')?.content;
    if(og&&comments.postKey(og)===item.key)for(const node of document.querySelectorAll('meta[property="article:published_time"]'))
      if(node.content)result.push({source:'public_meta_article_published_time',datetime:node.content,matched_resource:clean(og)});
    return result.slice(0,20);
  }
  const messageControls=node=>{
    const found=[...node.querySelectorAll('button,[role="button"],span')].filter(n=>visible(n)&&comments.patterns.full.test(text(n))&&!n.closest('a[href],input,textarea,[contenteditable="true"]'));
    return found.filter(n=>!found.some(c=>c!==n&&n.contains(c)));
  };
  function body(root) {
    const nodes=[...root.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-testid="post_message"]')].filter(n=>visible(n)&&own(root,n));
    const unique=nodes.filter(n=>!nodes.some(p=>p!==n&&p.contains(n)));
    if(unique.length!==1)return {text:'',status:'body_container_not_uniquely_identified',hashtags:[],image_alt_labels:[]};
    const node=unique[0],more=messageControls(node);let value=node.innerText;
    for(const control of more)if(value.trimEnd().endsWith(control.innerText))value=value.trimEnd().slice(0,-control.innerText.length).trimEnd();
    return {text:value,status:more.length?'explicit_message_container_truncated':'explicit_message_container',
      hashtags:[...new Set((node.innerText.match(/#[\p{L}\p{N}_]+/gu)||[]))],
      image_alt_labels:[...node.querySelectorAll('img[alt]')].map(n=>n.alt).filter(Boolean)};
  }
  function profile() {
    const main=document.querySelector('[role="main"],main');if(!main)return {};
    const titles=[...main.querySelectorAll('h1,[role="heading"][aria-level="1"]')].filter(n=>visible(n)&&!n.closest('[role="article"],[role="dialog"]'));
    const names=new Set(titles.map(text).filter(Boolean));
    const title=names.size===1?titles.find(n=>text(n)===[...names][0]):null;
    const authorEvidence=[];
    if(!names.size)for(const item of discover().items) {
      const candidates=[...item.node.querySelectorAll('a[href]')].filter(a=>visible(a)&&own(item.node,a)&&
        isAuthor(a.href)&&
        !!(a.compareDocumentPosition(item.anchor)&Node.DOCUMENT_POSITION_FOLLOWING));
      const values=[...new Set(candidates.map(a=>text(a)||a.getAttribute('aria-label')||'').filter(Boolean))];
      if(values.length===1)authorEvidence.push({post_url:item.url,name:values[0]});
    }
    const authorNames=new Set(authorEvidence.map(value=>value.name));
    const fallback=!names.size&&authorEvidence.length>=2&&authorNames.size===1?[...authorNames][0]:'';
    const name=title?text(title):fallback;
    const badgeRoot=title?(title.parentElement.querySelector('[role="article"],[role="dialog"]')?title:title.parentElement):null;
    const bio=[...main.querySelectorAll('[data-testid="profile_bio"]')].find(n=>!n.closest('[role="article"],[role="dialog"]'));
    const followers=[...main.querySelectorAll('a[href]')].find(a=>visible(a)&&!a.closest('[role="article"],[role="dialog"]')&&(new URL(a.href).pathname.replace(/\/$/,'').toLowerCase()===new URL(profileURL).pathname.replace(/\/$/,'').toLowerCase()+'/followers'));
    const badges=[...(badgeRoot?.querySelectorAll('[aria-label]')||[])].filter(n=>visible(n)&&/^(已认证|已验证|Verified account|Verified)$/i.test(n.getAttribute('aria-label')||''));
    const intro=[];
    for(const label of main.querySelectorAll('h1,h2,h3,[role="heading"]')) {
      if(!visible(label)||label.closest('[role="article"],[role="dialog"]')||!/^(简介|Intro|关于|About)$/i.test(text(label)))continue;
      for(let parent=label.parentElement,depth=0;parent&&parent!==main&&depth<4;parent=parent.parentElement,depth++) {
        if(parent.querySelector('[role="article"],[role="dialog"],input,textarea,[contenteditable]:not([contenteditable="false"])'))break;
        const value=parent.innerText.trim();
        if(value.length>text(label).length&&value.length<=1800){intro.push({heading:text(label),text:value});break;}
      }
    }
    return {name_raw:name,name_source:title?'explicit_profile_heading':fallback?'verified_own_post_author_consensus':'not_verified',
      name_candidates_raw:titles.map(text),author_name_evidence:authorEvidence,followers_raw:followers?.innerText||'',
      intro_sections_raw:intro,
      description:bio&&visible(bio)?bio.innerText:'',description_status:bio&&visible(bio)?'explicit_profile_bio':'not_verified',
      verification:badges.length?'verified':'',verification_status:badges.length?'explicit_badge_label':'not_verified',
      verification_labels_raw:badges.map(n=>n.getAttribute('aria-label')),creation_time:'',creation_time_status:'not_verified',
      about_attempt:intro.length?'header_and_visible_intro_snapshot':'header_snapshot_only',browser_time_zone:Intl.DateTimeFormat().resolvedOptions().timeZone,
      collected_at_utc:new Date().toISOString()};
  }
  async function readProfile() {
    await gate();
    if(!isProfile()||dialogs().length)return {...profile(),profile_scan_status:'no_scroll_while_detail_or_dialog_visible'};
    const position={left:scrollX,top:scrollY};let result;
    try {
      window.scrollTo({left:0,top:0,behavior:'instant'});
      await stepWait(document.body,'__profile_header_wait__');await gate();
      result={...profile(),profile_scan_status:'profile_header_loaded_at_top',original_scroll_position:position};
      return result;
    } finally {
      if(!restriction()&&isProfile()&&!dialogs().length) {
        window.scrollTo({...position,behavior:'instant'});
        if(result)result.profile_list_position_restore_requested=true;
      }
    }
  }
  function snapshot(root,item,index) {
    const links=linkEvidence(root,true),controls=controlEvidence(root),times=timeEvidence(root);
    // An image alone is insufficient: video posters and avatars are also img.
    // Require an own photo resource linked to visible media, with no own video.
    const dateAnchor=resource(root)?.anchor;
    const photoLinks=[...root.querySelectorAll('a[href]')].filter(a=>visible(a)&&own(root,a)&&dateAnchor&&
      !!(dateAnchor.compareDocumentPosition(a)&Node.DOCUMENT_POSITION_FOLLOWING)&&
      /^(?:\/photo\.php|\/[^?]*photos\/)/i.test(new URL(a.href).pathname)&&
      [...a.querySelectorAll('img')].some(img=>visible(img)&&own(root,img)));
    const largeImages=[...root.querySelectorAll('img')].filter(n=>visible(n)&&own(root,n)&&dateAnchor&&
      !!(dateAnchor.compareDocumentPosition(n)&Node.DOCUMENT_POSITION_FOLLOWING)&&
      n.getBoundingClientRect().width>=120&&n.getBoundingClientRect().height>=120);
    const hasVideo=[...root.querySelectorAll('video,a[href],[aria-label]')].some(n=>own(root,n)&&
      (n.tagName==='VIDEO'||(n.tagName==='A'&&/^(?:reel|videos):/.test(comments.postKey(n.href)||''))||
      /^(播放|播放视频|Play|Play video)$/i.test(n.getAttribute('aria-label')||'')));
    const imageOnly=(photoLinks.length>0||largeImages.length>0)&&!hasVideo;
    return {account_key:target.account_key,profile_url:profileURL,record_type:'post',sample_index:index,
      discovery_strategy:item.discovery_strategy||'verified_dialog_header',resource_recognition_method:item.resource_method||'unique_dated_resource',
      post_header_author_evidence_json:JSON.stringify(item.author_evidence||{}),
      post_url:item.url,post_url_status:'own_time_link_resource',candidate_post_links_json:JSON.stringify([item.url]),
      collected_at_utc:new Date().toISOString(),source:'Chrome_extension_public_DOM',version:'0.6.9',
      pinned_post_observed:[...root.querySelectorAll('[aria-label],span')].some(n=>own(root,n)&&visible(n)&&/^(置顶|置顶帖子|Pinned|Pinned post)$/i.test((n.getAttribute('aria-label')||n.innerText||'').trim())),
      visible_article_text:root.innerText,raw_links_json:JSON.stringify(links),raw_controls_json:JSON.stringify(controls),
      raw_post_only_controls_json:JSON.stringify(controls),raw_post_only_time_elements_json:JSON.stringify(times),
      post_content_kind:imageOnly?'image':'not_verified_image',
      content_kind_evidence_json:JSON.stringify({own_photo_media_links:photoLinks.map(a=>clean(a.href)),
        own_large_images:largeImages.map(n=>({alt:n.alt,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})),own_video_resource_observed:hasVideo}),
      raw_visible_comments_json:JSON.stringify(imageOnly?[]:comments.read(root)),nested_article_texts_json:'[]',
      raw_post_body_json:JSON.stringify(body(root)),coverage:'bounded_pilot_completeness_not_established'};
  }
  async function readListImage(item,row) {
    const keys=['visible_article_text','raw_links_json','raw_controls_json','raw_post_only_controls_json',
      'raw_post_only_time_elements_json','raw_post_body_json'];
    row.raw_list_initial_evidence_json=JSON.stringify(Object.fromEntries(['collected_at_utc',...keys].map(key=>[key,row[key]])));
    const actions=[];row.list_body_expand_status='not_attempted';
    const refresh=()=>{
      if(!isProfile()||dialogs().length)throw new Error('profile_not_restored_before_image_save');
      const current=discover().items.find(value=>value.key===item.key);
      if(!current)throw new Error('image_list_resource_not_found');
      const observed=snapshot(current.node,current,row.sample_index);
      if(observed.post_content_kind!=='image')throw new Error('image_list_media_type_changed');
      for(const key of keys)row[key]=observed[key];
      row.collected_at_utc=observed.collected_at_utc;
      row.list_updated_at_utc=new Date().toISOString();row.list_body_expand_actions_json=JSON.stringify(actions);
      return current.node;
    };
    try {
      for(let i=0;i<5;i++) {
        await gate();const root=refresh();
        const messages=[...root.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-testid="post_message"]')].filter(n=>visible(n)&&own(root,n));
        const nodes=messages.filter(n=>!messages.some(other=>other!==n&&other.contains(n)));
        if(nodes.length!==1){row.list_body_expand_status='message_container_not_uniquely_identified';break;}
        const controls=messageControls(nodes[0]);
        if(!controls.length){row.list_body_expand_status='visible_body_captured';break;}
        if(controls.length!==1){row.list_body_expand_status='expand_control_not_uniquely_identified';break;}
        const before=root.innerText;controls[0].click();actions.push({action:'expand_image_post_body',attempt:i+1});
        const result=await stepWait(root,before,async()=>{refresh();await checkpoint(row);});
        refresh();await checkpoint(row);
        row.list_body_expand_status=result==='unchanged'?'expand_did_not_reveal_more_text':'body_expansion_limit_reached';
        if(result==='unchanged')break;
      }
    } finally {
      row.list_body_expand_actions_json=JSON.stringify(actions);
      await checkpoint(row);
    }
  }
  async function stepWait(root,before,capture=async()=>{}) {
    await gate();const outcome=await comments.waitForChange(root,before,async()=>{await gate();await capture();});
    if(restriction())throw new Error(restriction());
    if(outcome==='detached')await capture();
    return outcome;
  }
  async function waitForFeedGrowth(knownKeys) {
    const known=new Set(knownKeys),started=clock();let found=discover();
    const snapshot=()=>globalThis.localPandaTiming?.snapshot()||{visibility:document.visibilityState};
    const initial=snapshot();let continuouslyVisible=initial.visibility==='visible'&&!initial.frozen;
    const finish=status=>{
      const final=snapshot();
      const eligible=continuouslyVisible&&final.visibility==='visible'&&!final.frozen&&
        initial.lifecycle_epoch===final.lifecycle_epoch&&initial.delayed_wakes===final.delayed_wakes;
      return {status,items:found.items,feed_observation:{can_confirm_end:eligible,
        initial,final,elapsed_active_ms:Math.round(clock()-started)}};
    };
    while(clock()-started<6000) {
      await delay(250);await gate();
      const current=snapshot();continuouslyVisible=continuouslyVisible&&current.visibility==='visible'&&!current.frozen;
      if(restriction())throw new Error(restriction());
      found=discover();
      if(!found.error&&found.items.some(item=>!known.has(item.key))&&clock()-started>=2500)
        return finish('new_post_ids');
    }
    return finish(found.error||'unchanged');
  }
  function dialogMatches(dialog,item) {
    const r=resource(dialog);
    if(r)return r.key===item.key;
    const dated=[...dialog.querySelectorAll('a[href]')].filter(a=>visible(a)&&own(dialog,a)&&!/[?&](?:reply_)?comment_id=/.test(a.href)&&comments.postKey(a.href)&&[a.innerText,a.getAttribute('aria-label')||'',a.getAttribute('title')||''].some(timeish));
    if(dated.length)return false; // Ambiguous dated resources must not use the fallback.
    // A viewer can translate or truncate text. Identity must come from resource
    // links, never from matching the displayed language against the feed body.
    if(comments.postKey(location.href)!==item.key)return false;
    const keys=new Set([...dialog.querySelectorAll('a[href]')].filter(a=>visible(a)&&/[?&](?:reply_)?comment_id=/.test(a.href)).map(a=>comments.postKey(a.href)).filter(Boolean));
    const close=[...dialog.querySelectorAll('button,[role="button"]')].some(n=>visible(n)&&/^(关闭|Close)$/.test(n.getAttribute('aria-label')||text(n)));
    return close&&keys.size===1&&keys.has(item.key);
  }
  function matchingDialog(item) {
    if(!item)return null;
    const all=dialogs(),matched=all.filter(dialog=>dialogMatches(dialog,item));
    const leaves=matched.filter(dialog=>!matched.some(child=>child!==dialog&&dialog.contains(child)));
    if(leaves.length!==1)return null;
    const inner=leaves[0];
    // Only verified wrappers of this same post may coexist with the reader root.
    if(all.some(dialog=>dialog!==inner&&(!matched.includes(dialog)||!dialog.contains(inner))))return null;
    return inner;
  }
  function currentDialogItem() {
    const candidates=[];
    for(const dialog of dialogs()) {
      const r=resource(dialog);if(!r)continue;
      const first=headerAuthor(dialog,r.anchor);if(!first)continue;
      const author=new URL(first.href);
      if(author.origin!=='https://www.facebook.com'||!isAuthor(author.href))continue;
      const item={...r,node:dialog,source_body:body(dialog),identity_source:'open_dialog_own_date_and_header_author',
        author_evidence:{method:'first_non_story_header_link_before_own_date',url:clean(first.href),name:text(first)}};
      const confirmed=matchingDialog(item);if(!confirmed)continue;
      item.node=confirmed;
      if(!candidates.some(candidate=>candidate.key===item.key))candidates.push(item);
    }
    return candidates.length===1?candidates[0]:null;
  }
  function openingEvidence(item,target,elapsed) {
    return {expected_post_key:item.key,observed_public_url:clean(location.href),elapsed_ms:elapsed,
      source_post_controls:controlEvidence(item.node),clicked_control:target?{tag:target.tagName,text:text(target).slice(0,200),aria_label:target.getAttribute('aria-label')||'',url:target.hasAttribute('href')?clean(target.getAttribute('href')):''}:null,
      dialogs:dialogs().slice(0,3).map(d=>({resource_key:resource(d)?.key||'',text:d.innerText.slice(0,8000),
        links:linkEvidence(d,true).slice(0,80),controls:controlEvidence(d).slice(0,50)}))};
  }
  function commentAction(root) {
    const controls=[...root.querySelectorAll('button,[role="button"]')].filter(n=>visible(n)&&own(root,n)&&
      !n.closest('input,textarea,form,[contenteditable="true"],[aria-busy="true"]')&&!n.disabled&&n.getAttribute('aria-disabled')!=='true');
    const candidates=controls.filter(n=>/^(发表评论|Comment|Comments)$/i.test(n.getAttribute('aria-label')||''));
    const leaves=candidates.filter(n=>!candidates.some(child=>child!==n&&n.contains(child)));
    const matched=[];
    for(const target of leaves) {
      const index=controls.indexOf(target);
      const like=controls.slice(0,index).reverse().find(n=>/^(赞|点赞|Like|Unlike|取消赞)$/i.test(n.getAttribute('aria-label')||''));
      const share=controls.slice(index+1).find(n=>/^(分享(?:，.*)?|Share(?: .*)?)$/i.test(n.getAttribute('aria-label')||''));
      if(!like||!share)continue;
      for(let bar=target.parentElement,depth=0;bar&&bar!==root&&depth<6;bar=bar.parentElement,depth++) {
        if(!bar.contains(like)||!bar.contains(share))continue;
        if(text(bar).length>200||bar.querySelector('input,textarea,[contenteditable="true"],video'))break;
        const entries=controls.filter(n=>bar.contains(n));
        if(entries.length>10)break;
        matched.push({target,method:'scoped_like_comment_share_bar',evidence:{
          comment_count_text:text(target),bar_tag:bar.tagName,
          controls:entries.map(n=>({text:text(n),aria_label:n.getAttribute('aria-label')||''}))}});break;
      }
    }
    return matched.length===1?matched[0]:matched.length?{ambiguous:true,evidence:{matching_bar_count:matched.length}}:null;
  }
  async function open(item,row) {
    await gate();if(dialogs().length)throw new Error('unexpected_dialog_before_open');
    if(!isProfile())throw new Error('profile_not_restored_before_open');
    await locateSource(item,row,'before_comment_entry');
    activeItem=item;phase='opening_expected_detail';
    item.node.scrollIntoView({block:'center',behavior:'instant'});
    await delay(80);await gate();
    await locateSource(item,row,'after_comment_entry_scroll');
    // A date permalink opens the Reels viewer in the user's observed layout.
    // Only open a verified comment entry; never fall back to a media/date link.
    const controls=[...item.node.querySelectorAll('button,[role="button"]')].filter(n=>visible(n)&&own(item.node,n));
    const action=commentAction(item.node);
    const button=action?.ambiguous?null:(action?.target||controls.find(n=>comments.names(n).some(s=>/^查看更多评论$|^(?:View|See) more comments$/i.test(s))) ||
      controls.find(n=>/^(发表评论|Comment|Comments)$/i.test(n.getAttribute('aria-label')||'')&&/^\d[\d,.\s]*$/.test(text(n))&&Number(text(n).replace(/[,\s]/g,''))>0));
    if(row){row.comment_entry_selection_method=action?.method||(button?'legacy_explicit_more_or_numeric_count':'not_identified');
      row.comment_entry_evidence_json=JSON.stringify(action?.evidence||{});}
    const target=button;
    if(!target) {
      if(row){row.detail_opening_evidence_json=JSON.stringify(openingEvidence(item,null,0));await checkpoint(row);}
      throw new Error('comment_detail_entry_not_identified');
    }
    if(!item.node.isConnected||resource(item.node)?.key!==item.key||!visible(target))throw new Error('source_post_changed_before_open');
    target.scrollIntoView({block:'center',behavior:'instant'});
    await delay(80);await gate();
    if(!isProfile()||dialogs().length)throw new Error('page_changed_before_comment_click');
    const previousURL=location.href,previousHistoryLength=history.length;
    const ancestors=[];
    for(let node=target,depth=0;node&&depth<10;node=node.parentElement,depth++) {
      ancestors.push({tag:node.tagName,role:node.getAttribute('role')||'',aria_label:node.getAttribute('aria-label')||'',href:node.hasAttribute('href')?clean(node.getAttribute('href')):''});
      if(node===item.node)break;
    }
    const navigationLink=target.closest('a[href]');
    if(row) {
      row.comment_entry_before_click_json=JSON.stringify({post_key:item.key,at_utc:new Date().toISOString(),profile_url_before:clean(previousURL),history_length_before:previousHistoryLength,
        target_ancestors:ancestors,status:navigationLink?'blocked_navigation_link':'checkpointed_before_click'});
      row.detail_opening_evidence_json=JSON.stringify({...openingEvidence(item,target,0),stage:'before_click'});
      await checkpoint(row,{force:true}); // Must reach storage before a navigation can destroy this script.
    }
    if(navigationLink||target.closest('a[href]'))throw new Error('comment_entry_has_navigation_link');
    if(!item.node.isConnected||!target.isConnected||!item.node.contains(target)||resource(item.node)?.key!==item.key||!visible(target))throw new Error('source_post_changed_before_open');
    const rect=target.getBoundingClientRect(),hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
    if(!hit||!(hit===target||target.contains(hit)))throw new Error('comment_entry_occluded_or_outside_viewport');
    // A verified comment control can still call location.assign from its site handler.
    // Cancel only full-document navigation to this resource or Facebook home during this action.
    let blockedNavigation=null;
    const navigationGuard=event=>{
      if(!event.cancelable||event.defaultPrevented||event.destination?.sameDocument||event.userInitiated||event.downloadRequest)return;
      const destination=clean(event.destination?.url||'');
      if(!destination||(comments.postKey(destination)!==item.key&&new URL(destination).pathname!=='/'))return;
      event.preventDefault();
      blockedNavigation={post_key:item.key,destination_url:destination,status:'full_document_navigation_cancelled',at_utc:new Date().toISOString()};
    };
    const nav=globalThis.navigation;
    nav?.addEventListener('navigate',navigationGuard);
    let started=clock();
    try {
      // Hit the actual visible icon/text at its screen coordinates, rather than
      // HTMLElement.click() on the wrapper (which has no pointer coordinates).
      // These are explicitly untrusted DOM events, not a browser/user gesture.
      const activation={method:'verified_comment_hit_pointer_mouse_sequence',events_trusted:false,
        client_x:rect.left+rect.width/2,client_y:rect.top+rect.height/2,
        hit_tag:hit.tagName,hit_role:hit.getAttribute('role')||'',steps:[]};
      const eventInit={bubbles:true,cancelable:true,composed:true,view:window,
        clientX:activation.client_x,clientY:activation.client_y,button:0};
      if(row){row.comment_entry_activation_evidence_json=JSON.stringify(activation);await checkpoint(row,{force:true});}
      for(const [type,pointer,buttons] of [['pointerover',true,0],['mouseover',false,0],
        ['pointerdown',true,1],['mousedown',false,1],['pointerup',true,0],['mouseup',false,0],['click',false,0]]){
        await gate();
        if(blockedNavigation||matchingDialog(item))break; // A press handler may already have opened it.
        if(!isProfile()||dialogs().length)throw new Error('page_changed_during_comment_activation');
        if(!target.isConnected||!hit.isConnected||!item.node.contains(target)||resource(item.node)?.key!==item.key)
          throw new Error('source_post_changed_during_comment_activation');
        const currentRect=target.getBoundingClientRect();
        const currentHit=document.elementFromPoint(activation.client_x,activation.client_y);
        if(!currentHit||!(currentHit===target||target.contains(currentHit))||
          currentHit.closest('a[href]')||Math.abs(currentRect.left-rect.left)>2||Math.abs(currentRect.top-rect.top)>2)
          throw new Error('comment_entry_moved_or_occluded_during_activation');
        const event=pointer?new PointerEvent(type,{...eventInit,pointerId:1,pointerType:'mouse',isPrimary:true,buttons}):new MouseEvent(type,{...eventInit,buttons});
        currentHit.dispatchEvent(event);
        activation.steps.push({type,hit_tag:currentHit.tagName,default_prevented:event.defaultPrevented,at_utc:new Date().toISOString()});
        if(row)row.comment_entry_activation_evidence_json=JSON.stringify(activation);
      }
      if(row)await checkpoint(row,{force:true});
      // The wait budget starts after activation/persistence, which can be slow in a large batch.
      started=clock();
      // Same-document routing and verified comment dialogs remain allowed.
      while(clock()-started<12000) {
        await delay(250);await gate();
        if(blockedNavigation) {
          if(row){row.unexpected_viewer_navigation_json=JSON.stringify(blockedNavigation);await checkpoint(row,{force:true});}
          throw new Error('comment_entry_full_navigation_blocked');
        }
        if(matchingDialog(item)&&clock()-started>=2500)break;
      }
    } finally {nav?.removeEventListener('navigate',navigationGuard);}
    item.openingEvidence=openingEvidence(item,target,clock()-started);
    if(row){row.detail_opening_evidence_json=JSON.stringify(item.openingEvidence);await checkpoint(row);}
    if(!dialogs().length&&!matchingDialog(item)&&comments.postKey(location.href)===item.key) {
      const canReturn=history.length===previousHistoryLength+1;
      if(row){row.unexpected_viewer_navigation_json=JSON.stringify({post_key:item.key,observed_url:clean(location.href),profile_url_before:clean(previousURL),history_length_before:previousHistoryLength,history_length_after:history.length,status:'standalone_viewer_detected',one_step_return_verified:canReturn});await checkpoint(row,{force:true});}
      if(canReturn) {
        phase='returning_from_unexpected_viewer';history.back();const returning=clock();
        const restored=()=>isProfile()&&!dialogs().length&&discover().items.some(candidate=>candidate.key===item.key);
        while(!restored()&&clock()-returning<6000){await delay(100);await gate();}
        if(restored()) {
          activeItem=null;phase='profile';
          if(row){row.unexpected_viewer_navigation_json=JSON.stringify({post_key:item.key,status:'returned_to_original_profile',observed_url:clean(location.href)});await checkpoint(row,{force:true});}
          throw new Error('comment_entry_opened_viewer_restored_profile');
        }
      }
      throw new Error('comment_entry_opened_standalone_viewer');
    }
    if(!matchingDialog(item))throw new Error(dialogs().length?'post_detail_identity_unconfirmed':'post_detail_dialog_not_opened');
    phase='expected_detail_open';return matchingDialog(item);
  }
  async function close(dialog) {
    await gate();
    if(activeItem){dialog=matchingDialog(activeItem);if(!dialog)throw new Error('dialog_identity_changed_before_close');}
    if(!dialog?.isConnected)throw new Error('dialog_detached_before_close');
    const button=[...dialog.querySelectorAll('button,[role="button"]')].find(n=>visible(n)&&/^(关闭|Close)$/.test(n.getAttribute('aria-label')||text(n)));
    if(!button)throw new Error('dialog_close_control_not_identified');
    button.click();await stepWait(document.body,'__wait_for_close__');
    if(dialogs().length)throw new Error('dialog_remained_open');
    if(!isProfile())throw new Error('profile_url_not_restored_after_close');
    activeItem=null;phase='profile';
  }
  async function readPublicationTime(root,row,item) {
    await gate();const isDialogRoot=root.matches('[role="dialog"]');
    const assertRoot=async()=>{
      if(!root.isConnected||resource(root)?.key!==item.key) {
        let refreshed;
        if(isDialogRoot) {
          const started=clock();let polls=0;
          refreshed=matchingDialog(item);
          while((!refreshed||resource(refreshed)?.key!==item.key)&&clock()-started<2500) {
            await gate();
            if(dialogs().some(node=>resource(node)&&resource(node).key!==item.key))throw new Error('dialog_identity_changed');
            await delay(100);polls++;refreshed=matchingDialog(item);
          }
          row.publication_time_dialog_recovery_json=JSON.stringify({post_key:item.key,elapsed_ms:clock()-started,polls,
            status:refreshed&&resource(refreshed)?.key===item.key?'same_post_date_recovered':'same_post_date_unavailable'});
        }
        else try {refreshed=(await locateSource(item,row,'publication_time_rerender')).node;}
        catch(error){if(error.message==='source_post_no_longer_discoverable')throw new Error('publication_time_resource_changed');throw error;}
        if(!refreshed)throw new Error('publication_time_resource_changed');root=refreshed;
      }
      if(resource(root)?.key!==item.key)throw new Error('publication_time_resource_changed');
      if(dialogs().length&&matchingDialog(item)!==root)throw new Error('dialog_identity_changed');
    };
    await assertRoot();let date=resource(root).anchor;
    date.scrollIntoView({block:'center',behavior:'instant'});
    await delay(80);
    await assertRoot();date=resource(root).anchor;
    const prior=new Map([...document.querySelectorAll('[role="tooltip"]')].filter(visible).map(n=>[n,n.innerText]));
    const observed=new Map(),associated=new Set(),attempts=[];
    const fullDateTips=()=>[...document.querySelectorAll('[role="tooltip"]')].filter(n=>visible(n)&&/(?:19|20)\d{2}/.test(n.innerText)).map(n=>n.innerText);
    let lifecycle={status:'not_attempted'};
    const stage=root.matches('[role="dialog"]')?'detail':'profile_list';
    const previous=JSON.parse(row.publication_time_hover_evidence_json||'[]').filter(e=>e.stage!==stage);
    const captureDate=async()=>{
      await gate();await assertRoot();date=resource(root).anchor;
      for(const id of (date.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean)) {
        const node=document.getElementById(id);if(node&&visible(node))associated.add(node.innerText);
      }
      for(const node of document.querySelectorAll('[role="tooltip"]'))if(visible(node)&&prior.get(node)!==node.innerText&&/(?:19|20)\d{2}/.test(node.innerText))
        observed.set(node.innerText,{text:node.innerText,association:'new_or_changed_after_date_hover_not_verified'});
      row.publication_time_hover_evidence_json=JSON.stringify([...previous,{source:'own_post_date_anchor',stage,post_url:item.url,text:date.innerText,
        title:date.getAttribute('title'),aria_label:date.getAttribute('aria-label'),
        date_attributes:{datetime:date.getAttribute('datetime'),unix_time:date.getAttribute('data-utime')},
        time_elements:timeEvidence(root),structured_times:structuredTimes(item),
        associated_tooltips:[...associated],new_tooltips:[...observed.values()],hover_attempts:attempts,tooltip_lifecycle:lifecycle,
        hover_method:'script_pointer_then_mouse_over_visible_descendant_untrusted',browser_time_zone:Intl.DateTimeFormat().resolvedOptions().timeZone,
        timezone_status:'browser_zone_is_not_proof_of_platform_display_zone'}]);
      await checkpoint(row);
    };
    await captureDate();
    for(const method of ['pointer','mouse']) {
      await assertRoot();date=resource(root).anchor;
      const r=date.getBoundingClientRect(),event={bubbles:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2,relatedTarget:null};
      const target=document.elementFromPoint(event.clientX,event.clientY);
      // Dispatch to the visible text descendant as a real hit test would; never
      // send hover through a covering dialog or the collector panel.
      if(!target||!(target===date||date.contains(target))) {
        attempts.push({method,status:'date_center_occluded_or_outside_viewport'});await captureDate();break;
      }
      attempts.push({method,status:'dispatched',target_tag:target.tagName,events_trusted:false});
      const enter=()=>{
        if(method==='pointer') {
          target.dispatchEvent(new PointerEvent('pointerover',{...event,pointerType:'mouse'}));
          target.dispatchEvent(new PointerEvent('pointerenter',{...event,bubbles:false,pointerType:'mouse'}));
        } else {
          target.dispatchEvent(new MouseEvent('mouseover',event));
          target.dispatchEvent(new MouseEvent('mouseenter',{...event,bubbles:false}));
          target.dispatchEvent(new MouseEvent('mousemove',event));
        }
      };
      const leave=()=>{
        if(method==='pointer') {
          target.dispatchEvent(new PointerEvent('pointerout',{...event,pointerType:'mouse'}));
          target.dispatchEvent(new PointerEvent('pointerleave',{...event,bubbles:false,pointerType:'mouse'}));
        } else {
          target.dispatchEvent(new MouseEvent('mouseout',event));
          target.dispatchEvent(new MouseEvent('mouseleave',{...event,bubbles:false}));
        }
      };
      const baseline=fullDateTips();let first=[];
      try {
        enter();await stepWait(document.body,'__date_hover__',captureDate);await captureDate();first=fullDateTips();
      } finally {leave();}
      if(!associated.size&&observed.size) {
        lifecycle={status:'checking',post_url:item.url,method,anchor_text:date.innerText,
          baseline_full_dates:baseline,first_full_dates:first,stable_interval_ms:750};
        // Repeat only one uniquely visible full-date tooltip. A global tooltip
        // is not assigned merely because it appeared after an event.
        const settle=async predicate=>{
          const started=clock();let stable=clock();
          while(clock()-started<2500) {
            await delay(100);await gate();await assertRoot();
            const values=fullDateTips();if(!predicate(values))stable=clock();
            if(clock()-stable>=750)return {values,stable:true};
          }
          return {values:fullDateTips(),stable:false};
        };
        if(baseline.length||first.length!==1||!observed.has(first[0]))lifecycle.status='baseline_or_first_tooltip_ambiguous';
        else {
          const departed=await settle(values=>values.length===0);
          lifecycle.after_leave_full_dates=departed.values;lifecycle.after_leave_stable=departed.stable;
          if(!departed.stable||departed.values.length)lifecycle.status='tooltip_did_not_disappear';
          else if(!target.isConnected||resource(root).anchor!==date||document.elementFromPoint(event.clientX,event.clientY)!==target)
            lifecycle.status='hover_target_changed_or_occluded';
          else {
            try {
              enter();const repeated=await settle(values=>values.length===1&&values[0]===first[0]);
              lifecycle.repeated_full_dates=repeated.values;lifecycle.repeat_stable=repeated.stable;
            } finally {leave();}
            const departedAgain=await settle(values=>values.length===0);
            lifecycle.after_repeat_leave_full_dates=departedAgain.values;lifecycle.after_repeat_leave_stable=departedAgain.stable;
            lifecycle.status=lifecycle.repeat_stable&&lifecycle.after_repeat_leave_stable&&lifecycle.repeated_full_dates.length===1&&lifecycle.repeated_full_dates[0]===first[0]&&
              !lifecycle.after_repeat_leave_full_dates.length?'repeat_hover_lifecycle_confirmed':'repeat_hover_not_confirmed';
          }
        }
        await captureDate();
      }
      if(associated.size||observed.size)break;
    }
  }
  async function readDetail(dialog,row,item) {
    const actions=[],saved=new Map();let sort='not_verified';
    async function remember() {
      if(restriction())throw new Error(restriction());
      const current=matchingDialog(item);if(!current)throw new Error('dialog_identity_changed');dialog=current;
      for(const c of comments.read(dialog))saved.set(comments.commentKey(c),c);
      row.raw_dialog_visible_comments_json=JSON.stringify([...saved.values()]);
      row.visible_comment_records_saved=saved.size;
      row.matching_public_post_dialog_text_raw=dialog.innerText;
      row.raw_detail_evidence_json=JSON.stringify({links:linkEvidence(dialog,true),times:timeEvidence(dialog),controls:controlEvidence(dialog),
        labels:[...dialog.querySelectorAll('[aria-label]')].filter(n=>visible(n)&&own(dialog,n)).map(n=>n.getAttribute('aria-label')),
        body:body(dialog),structured_times:structuredTimes(item),collected_at_utc:new Date().toISOString()});
      row.comment_sort_status=sort;row.comment_expansion_actions_json=JSON.stringify(actions);
      await checkpoint(row);
    }
    try {
      await remember();
      if(resource(dialog))try {await readPublicationTime(dialog,row,item);}
      catch(error) {
        if(error.message!=='publication_time_resource_changed')throw error;
        await gate();const confirmed=matchingDialog(item);if(!confirmed)throw error;
        dialog=confirmed;row.publication_time_read_status='resource_changed_in_detail_date_unavailable';
        actions.push({action:'skip_unavailable_detail_date',reason:error.message,at_utc:new Date().toISOString()});
        await remember(); // Continue only inside the same independently verified post.
      }
      await remember();
      // Expand only the explicit post message, never a recommended video or a Reply action.
      for(let i=0;i<5;i++) {
        const message=[...dialog.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-testid="post_message"]')].find(n=>visible(n)&&own(dialog,n));
        const button=message&&messageControls(message)[0];
        if(!button)break;await gate();const before=dialog.innerText;button.click();actions.push({action:'expand_post_body'});
        if(await stepWait(dialog,before,remember)==='unchanged')break;
      }
      const sortNodes=comments.controls(dialog,comments.patterns.sort).filter(n=>!n.closest('[role="menu"],[role="listbox"]'));
      if(sortNodes.some(n=>comments.names(n).some(s=>comments.patterns.selected.test(s)))) {
        sort='all_comments_visible_selected';row.comment_sort_selection_origin='already_selected_on_entry';
      } else {
        let trigger=sortNodes.filter(n=>!sortNodes.some(c=>c!==n&&n.contains(c)));
        if(trigger.length!==1) {sort='sort_control_not_uniquely_identified';return;}
        await gate();const beforeNodes=new Set(comments.visibleMenuNodes()),attempts=[];let options=[];
        const state=()=>{
          const node=trigger[0],r=node.getBoundingClientRect(),expanded=node.closest('[aria-expanded]');
          return {tag:node.tagName,role:node.getAttribute('role')||'',text:comments.text(node),aria_label:node.getAttribute('aria-label')||'',
            connected:node.isConnected,aria_expanded:expanded?.getAttribute('aria-expanded')||'',aria_haspopup:node.getAttribute('aria-haspopup')||'',
            rect:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}};
        };
        for(const method of ['click','pointer']) {
          await gate();await remember();
          const fresh=comments.controls(dialog,comments.patterns.sort).filter(n=>!n.closest('[role="menu"],[role="listbox"]'));
          trigger=fresh.filter(n=>!fresh.some(child=>child!==n&&n.contains(child)));
          if(trigger.length!==1){sort='sort_control_not_uniquely_identified';return;}
          if(trigger.some(node=>comments.names(node).some(value=>comments.patterns.selected.test(value)))){
            sort='all_comments_visible_selected';row.comment_sort_selection_origin='selected_after_rerender';break;
          }
          const before=state();if(!before.connected){sort='sort_trigger_replaced';return;}
          if(method==='pointer'&&(before.aria_expanded==='true'||comments.menuEvidence(beforeNodes).menus.length))break;
          trigger[0].scrollIntoView({block:'nearest',behavior:'instant'});
          comments.activateReadControl(trigger[0],{method});actions.push({action:'open_comment_sort',method,at_utc:new Date().toISOString()});
          await stepWait(document.body,'__menu__',remember);
          const selectedAfter=()=>comments.controls(dialog,comments.patterns.selected).some(n=>!n.closest('[role="menu"],[role="listbox"]'));
          options=comments.allOptions(beforeNodes);const until=clock()+1500;
          while(!selectedAfter()&&!options.length&&clock()<until) {await new Promise(r=>setTimeout(r,250));await gate();options=comments.allOptions(beforeNodes);}
          const evidence=comments.menuEvidence(beforeNodes);
          attempts.push({method,before,after:state(),menu:evidence});
          row.comment_sort_attempts_json=JSON.stringify(attempts);row.comment_sort_menu_evidence_json=JSON.stringify(evidence);await remember();
          if(selectedAfter()){sort='all_comments_visible_selected';row.comment_sort_selection_origin='selected_after_trigger';break;}
          if(options.length||evidence.menus.length||state().aria_expanded==='true')break;
        }
        if(sort!=='all_comments_visible_selected') {
          if(options.length!==1) {sort=options.length?'all_comments_option_ambiguous':'all_comments_option_not_found';return;}
          await gate();const before=dialog.innerText;comments.activateReadControl(options[0]);actions.push({action:'select_all_comments',at_utc:new Date().toISOString()});
          await stepWait(dialog,before,remember);
          sort=comments.controls(dialog,comments.patterns.selected).some(n=>!n.closest('[role="menu"],[role="listbox"]'))?'all_comments_visible_selected':'selection_not_confirmed';
          row.comment_sort_selection_origin='programmatic_menu_attempt';
        }
      }
      if(sort!=='all_comments_visible_selected')return;
      row.dialog_comment_expansion_status='no_more_controls_observed_not_proof_of_complete';
      const expansionLimit=commentExpansionLimit();row.comment_expansion_limit=expansionLimit;
      for(let i=0;i<expansionLimit;i++) {
        await gate();await remember();const before=dialog.innerText;
        const more=comments.controls(dialog,comments.patterns.more)[0]||comments.fullTextControls(dialog)[0];
        if(more) {more.click();actions.push({action:'expand_comment_or_reply',label:text(more)});}
        else {
          const scrollers=[dialog,...dialog.querySelectorAll('div')].filter(n=>visible(n)&&n.scrollHeight>n.clientHeight+100&&/(auto|scroll)/.test(getComputedStyle(n).overflowY));
          const scroller=scrollers.sort((a,b)=>b.scrollHeight-a.scrollHeight)[0];
          if(!scroller)break;scroller.scrollTo({top:scroller.scrollHeight,behavior:'instant'});actions.push({action:'scroll_comment_container'});
        }
        const changed=await stepWait(dialog,before,remember);
        if(changed==='unchanged'){row.dialog_comment_expansion_status='no_new_content_observed_not_proof_of_complete';break;}
        row.dialog_comment_expansion_status=i===expansionLimit-1?'expansion_limit_reached_incomplete':'expanded_subset';
      }
    } finally {
      row.comment_sort_status=sort;
      if(sort!=='all_comments_visible_selected')row.comment_collection_warning=sort;
      if(!restriction()&&matchingDialog(item))await remember();
    }
  }
  return {setTarget,getTarget:()=>target,visible,restriction,isProfile,clean,comments,resource,heading,discover,profile,readProfile,snapshot,readListImage,dialogs,matchingDialog,currentDialogItem,open,close,readDetail,readPublicationTime,stepWait,waitForFeedGrowth,
    bindDetail:item=>{activeItem=item;phase='expected_detail_open';},
    navigationEvidence:()=>({phase,expected_post_key:activeItem?.key||'',expected_post_url:activeItem?.url||'',observed_public_url:clean(location.href)})};
};
