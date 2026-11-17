"use strict";
// Read-only bounded sample reader. Structure evidence: user's 20261023T160642 diagnosis.
// Field acceptance is separate from discovery; raw candidates are never all counted as complete posts.
globalThis.VKProbeDiagnostics = (options={}) => {
  const C = VKProbeCore;
  const fixed = C.target(location.href);
  if (!fixed) throw new Error("请在 https://vk.ru/chinaorgcn 主页执行结构诊断。");
  const forbidden = "input,textarea,select,[contenteditable],script,style,noscript,nav,aside,header,footer,[role=navigation]";
  const rendered = el => {
    if (!el || el.closest(forbidden) || el.closest('[hidden],[aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const allowedText = (root, limit) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let result="", n;
    while ((n = walker.nextNode()) && result.length < limit) {
      if (n.nodeType===Node.TEXT_NODE && rendered(n.parentElement)) result += n.textContent + "\n";
      else if (n.nodeType===Node.ELEMENT_NODE && n.matches('img.emoji[alt]') && rendered(n)) result += n.getAttribute('alt');
    }
    return result.trim().slice(0, limit);
  };
  const shape = el => ({tag:el.tagName.toLowerCase(),
    classes:[...el.classList].filter(s=>/^[\w-]{1,90}$/.test(s)).slice(0,8),
    role:el.getAttribute("role") || ""});
  // id=post_text... is a body wrapper, not a new post. A prefix alone is never a boundary.
  const postKey = el => {
    const keys=[el.getAttribute('data-post-id'),el.id].filter(Boolean)
      .map(raw=>raw.match(/^(?:post|wall)?(-?\d+)_(\d+)$/)).filter(Boolean)
      .map(m=>`wall${m[1]}_${m[2]}`);
    return new Set(keys).size>1?'conflicting_resource_ids':keys[0]||null;
  };
  const nearestPost = el => {
    for(let p=el;p&&p!==document.documentElement;p=p.parentElement)if(postKey(p))return p;
    return null;
  };
  const root = [...document.querySelectorAll('main,[role="main"],#page_body,#content')].find(rendered);
  const out = {schema_version:1,version:C.VERSION,...fixed,title:document.title.slice(0,160),
    collected_at:new Date().toISOString(),source:"rendered_public_DOM_diagnostic",
    identity_status:"unverified",status:"structure_pending",main_found:!!root,
    page_state:{visibility:document.visibilityState,scroll_y:Math.round(scrollY),
      viewport_height:innerHeight,loaded_height:document.documentElement.scrollHeight},
    headings:[],entry_links:[],candidates:[],rejected:[],truncated:false,
    coverage:{wall:"not_collected",video:"not_checked",clips:"not_checked",comments:"not_collected"}};
  const live=[];
  if (!root) {out.status="main_not_found"; return options.live?{snapshot:out,items:live}:out;}
  out.headings=[...root.querySelectorAll("h1,h2,[role=heading]")].filter(rendered).slice(0,12).map(el=>allowedText(el,160));
  out.entry_links=[...root.querySelectorAll('a[href]')].filter(rendered)
    .map(a=>({element:a,link:C.publicLink(a.getAttribute('href'),location.href)}))
    .filter(x=>x.link && !x.link.resource).slice(0,20)
    .map(x=>({...x.link,text:allowedText(x.element,100)}));
  const seen=new Set(), seenContainers=new Set();
  // Public post IDs and observed resource links are hints, never identity proof.
  const anchors=[...root.querySelectorAll('a[href]')].filter(rendered);
  for (const a of anchors) {
    const resource=C.resource(a.getAttribute("href"),location.href);
    if (!resource || resource.type!=="wall" || resource.reply || resource.thread || seen.has(resource.key) ||
      options.onlyKey&&resource.key!==options.onlyKey || options.skipKeys?.includes(resource.key)) continue;
    const container=nearestPost(a);
    if(container&&options.minimumY!==undefined&&container.getBoundingClientRect().bottom+scrollY<options.minimumY)continue;
    if (!container || !root.contains(container) || container===root || !rendered(container)) {
      if(out.rejected.length<12)out.rejected.push({resource,reason:"no_bounded_public_post_container",anchor:shape(a)});
      continue;
    }
    if (container.closest('[role=dialog]') && !root.contains(container.closest('[role=dialog]'))) continue;
    if (seenContainers.has(container)) continue;
    const declared=container.getAttribute("data-post-id") || container.id || "";
    const idMatch=declared.match(/^(?:post|wall)?(-?\d+)_(\d+)$/);
    if(postKey(container)!==resource.key || !idMatch) {
      if(out.rejected.length<12)out.rejected.push({resource,reason:"container_resource_mismatch",container:shape(container)});
      continue;
    }
    seen.add(resource.key);seenContainers.add(container);
    const links=[...container.querySelectorAll('a[href]')].filter(rendered).slice(0,100)
      .map(el=>({el,link:C.publicLink(el.getAttribute('href'),location.href)})).filter(x=>x.link)
      .slice(0,32).map(x=>({...x.link,text:allowedText(x.el,100)}));
    const times=[...container.querySelectorAll('time,[datetime],a[title]')].filter(rendered).slice(0,12)
      .map(el=>({element:shape(el),text:allowedText(el,100),datetime:el.getAttribute("datetime")||"",
        title:(el.getAttribute("title")||"").slice(0,160)}));
    const controls=[...container.querySelectorAll('button,[role=button]')].filter(rendered).slice(0,24)
      .map(el=>({...shape(el),text:allowedText(el,100),label:(el.getAttribute("aria-label")||"").slice(0,140),
        disabled:el.hasAttribute("disabled")||el.getAttribute("aria-disabled")==="true"}));
    // Restrict each field to this post's outer object, excluding nested posts and comments.
    const ownership = el => {
      let aliases=0;
      for(let p=el;p;p=p.parentElement) {
        if(p===container)return {accepted:true,reason:'same_resource_path_verified',same_key_wrappers:aliases};
        if(p.matches('[id^="reply"],[data-reply-id],[data-comment-id],.reply,.wall_reply'))
          return {accepted:false,reason:'comment_boundary',same_key_wrappers:aliases};
        const key=postKey(p);
        if(key&&key!==resource.key)return {accepted:false,reason:'foreign_or_conflicting_resource_boundary',owner_key:key,same_key_wrappers:aliases};
        if(key===resource.key)aliases++;
      }
      return {accepted:false,reason:'outside_source_container',same_key_wrappers:aliases};
    };
    const own = el => ownership(el).accepted;
    const bodyCandidates=[...container.querySelectorAll('.vkitInternalFeedShowMoreTextTextClamp')];
    const bodyNodes=bodyCandidates.filter(el=>rendered(el)&&own(el));
    const bodyNode=bodyNodes.length===1?bodyNodes[0]:null;
    const showMore=[...container.querySelectorAll('span[role="button"]')].filter(el=>rendered(el)&&own(el)&&
      /^(显示更多|Показать полностью|Show more)$/iu.test(allowedText(el,80).trim()));
    const headerLinks=[...container.querySelectorAll('h3 a[href]')].filter(el=>rendered(el)&&own(el)&&
      (!bodyNode || !!(el.compareDocumentPosition(bodyNode)&Node.DOCUMENT_POSITION_FOLLOWING)))
      .map(el=>({link:C.publicLink(el.getAttribute('href'),location.href),text:allowedText(el,100)}))
      .filter(x=>x.link&&!x.link.resource).map(x=>({...x.link,text:x.text}));
    const timeLinks=[...container.querySelectorAll('a[href]')].filter(el=>rendered(el)&&own(el))
      .filter(el=>{const r=C.resource(el.getAttribute('href'),location.href);return r?.key===resource.key&&!r.reply&&!r.thread;});
    const timeEvidence=timeLinks.slice(0,8).map(el=>({resource_key:resource.key,
      text:allowedText(el,160),title:(el.getAttribute('title')||'').slice(0,200),
      datetime:el.getAttribute('datetime')||'',aria_label:(el.getAttribute('aria-label')||'').slice(0,200),
      explicit_times:[...el.querySelectorAll('time[datetime]')].filter(rendered).map(t=>t.getAttribute('datetime')),
      // Preserve public DOM attributes as candidates; their meaning is not assumed.
      public_time_attributes:Object.fromEntries(['data-timestamp','data-date','data-time']
        .filter(name=>el.hasAttribute(name)).map(name=>[name,el.getAttribute(name).slice(0,120)])),
      element:shape(el)}));
    const fieldLabels=[...container.querySelectorAll('[aria-label],[title],svg title')].filter(el=>rendered(el)&&own(el)&&
      !(bodyNode&&bodyNode.contains(el))).slice(0,90).map(el=>({element:shape(el),
        label:(el.getAttribute('aria-label')||el.getAttribute('title')||'').slice(0,200),
        text:allowedText(el,160)}));
    const buttons=[...container.querySelectorAll('button,[role=button]')].filter(el=>rendered(el)&&own(el));
    const commentButtons=buttons.filter(el=>/^\d+(?:[ \u00a0\u202f]\d{3})*\s*(?:条评论|comments?|комментари(?:й|я|ев))$/iu.test(el.getAttribute('aria-label')||''));
    const shareButtons=buttons.filter(el=>/^\d+(?:[ \u00a0\u202f]\d{3})*\s*(?:分享|shares?|репост(?:а|ов)?)$/iu.test(el.getAttribute('aria-label')||''));
    let interactionBar=null;
    if(commentButtons.length===1&&shareButtons.length===1) {
      for(let p=commentButtons[0].parentElement;p&&p!==container;p=p.parentElement) {
        if(p.contains(shareButtons[0])) {
          if(!p.querySelector('h3,.vkitInternalFeedShowMoreTextTextClamp,.attachmentCarousel,video,[data-post-id]'))interactionBar=p;
          break;
        }
      }
    }
    const interaction={status:interactionBar?'comment_share_common_ancestor_verified':'unverified',
      labels:interactionBar?[...interactionBar.querySelectorAll('[aria-label],[title]')].filter(rendered)
        .slice(0,45).map(el=>({element:shape(el),label:(el.getAttribute('aria-label')||el.getAttribute('title')||'').slice(0,200),
          text:allowedText(el,160)})):[],
      text:interactionBar?allowedText(interactionBar,1000):'',
      structure:interactionBar?[...interactionBar.querySelectorAll('*')].filter(rendered).slice(0,60).map(shape):[]};
    if(interactionBar){
      for(const el of interactionBar.querySelectorAll('button,[role="button"]')){
        if(!rendered(el)||!own(el))continue;
        const name=el.getAttribute('aria-label')||el.getAttribute('title')||'';
        const value=(el.innerText||'').trim();
        if(/^(?:发送回应喜欢|点赞|赞|Нравится|Like)$/iu.test(name)&&/^\d+(?:[ \u00a0\u202f]\d{3})*$/.test(value))
          interaction.labels.push({element:shape(el),label:value+' 次赞',text:value,source:'numeric_text_in_explicitly_named_like_control',original_label:name});
      }
    }
    const mediaLinks=[...container.querySelectorAll('a[href]')].filter(el=>rendered(el)&&own(el))
      .map(el=>({link:C.publicLink(el.getAttribute('href'),location.href),text:allowedText(el,120)}))
      .filter(x=>x.link?.resource&&['video','photo','clip'].includes(x.link.resource.type))
      .slice(0,24).map(x=>({...x.link,text:x.text}));
    const nested=[...new Set([...container.querySelectorAll('[data-post-id],.wl_post,[id^="post"]')]
      .filter(rendered).map(postKey).filter(key=>key&&key!==resource.key))];
    const fields={reader_strategy:'vk_resource_ancestor_path_v3',header_links:headerLinks,
      body_discovery:bodyCandidates.slice(0,8).map(el=>({element:shape(el),rendered:rendered(el),
        owner_key:postKey(nearestPost(el)||el),...ownership(el),
        nearest_prefix_is_resource_boundary:!!postKey(el.closest('[data-post-id],.wl_post,[id^="post"]')||el)})),
      body:{text:bodyNode?allowedText(bodyNode,20000):'',status:bodyNodes.length===1?'visible_text_only':bodyNodes.length?'ambiguous_body':'body_not_found',
        show_more_present:!!showMore.length,truncated:bodyNode?allowedText(bodyNode,20001).length>20000:false,
        emoji_count:bodyNode?bodyNode.querySelectorAll('img.emoji[alt]').length:0},
      publication_times:timeEvidence,field_labels:fieldLabels,interaction_bar:interaction,media_links:mediaLinks,
      attachment_carousel:!!container.querySelector('.attachmentCarousel'),
      nested_post_containers:nested.length};
    const descendants=[...container.querySelectorAll('*')].slice(0,500).filter(rendered);
    out.candidates.push({resource,acceptance:"candidate_only_identity_and_fields_unverified",
      container:shape(container),public_id_attribute:idMatch?declared:"",
      text:allowedText(container,7000),links,times,controls,fields,observed_at:out.collected_at,
      structure:descendants.slice(0,65).map(shape),
      truncated:descendants.length>=500||container.querySelectorAll('a[href]').length>100});
    if(options.live)live.push({key:resource.key,node:container,bodyNode,showMore,timeLinks,own,rendered,
      interactionBar,commentButtons,candidate:out.candidates[out.candidates.length-1]});
    if(out.candidates.length===12){out.truncated=true;break;}
  }
  if (!out.candidates.length) out.status="no_confirmed_structure_candidates";
  // No page-wide text/HTML, input values, cookies, hidden state, events or network responses are read.
  return options.live?{snapshot:out,items:live}:out;
};
