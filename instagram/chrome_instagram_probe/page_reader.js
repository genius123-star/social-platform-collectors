// Diagnostic reader only. No network requests, hidden state, credentials or inferred metrics.
function readInstagramPage(expectedUsername) {
  const allowed = ['dailyvideo.kg', 'chinaarabtv'];
  if (!allowed.includes(expectedUsername)) throw Error('账号未登记');
  const page = new URL(location.href);
  if (page.protocol !== 'https:' || !['instagram.com','www.instagram.com'].includes(page.hostname)) throw Error('仅支持 Instagram');
  const profile = page.pathname.match(/^\/([A-Za-z0-9._]+)\/?$/);
  const post = page.pathname.match(/^\/(?:(?:[A-Za-z0-9._]+)\/)?(p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/);
  if ((!profile || profile[1] !== expectedUsername) && !post) throw Error('请打开所选账号主页或一条帖子；不读取首页、私信和登录页');
  const visible = el => {
    const style = getComputedStyle(el);
    return !!el.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[aria-hidden="true"]');
  };
  const dialog = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  if (dialog.length > 1) throw Error('存在多个弹窗，请先关闭无关弹窗');
  const scope = dialog[0] || document.querySelector('main');
  if (!scope || !visible(scope)) throw Error('未找到可见正文区域，未保存；请确认登录及页面已加载');
  // Read live rendered text per node so hidden descendants do not leak through textContent.
  const excluded = 'input,textarea,[contenteditable],script,style,nav,[role="navigation"]';
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const parts = [];
  let node, textLength = 0, textTruncated = false;
  while ((node = walker.nextNode())) {
    if (!node.parentElement || node.parentElement.closest(excluded) || !visible(node.parentElement)) continue;
    const value = node.textContent.trim();
    if (!value) continue;
    if (textLength + value.length > 100000) { textTruncated = true; break; }
    parts.push(value); textLength += value.length;
  }
  const localUrl = value => {
    try {
      const u = new URL(value, page.origin);
      if (u.protocol !== 'https:' || !['instagram.com','www.instagram.com'].includes(u.hostname)) return '';
      if (!/^\/(?:(?:[A-Za-z0-9._]+)\/)?(?:p|reel|reels)\/[A-Za-z0-9_-]+\/?$/.test(u.pathname) && !/^\/[A-Za-z0-9._]+\/?$/.test(u.pathname)) return '';
      return 'https://www.instagram.com' + u.pathname;
    } catch { return ''; }
  };
  const anchors = [...scope.querySelectorAll('a[href]')].filter(visible);
  const links = anchors.slice(0,1000).map(a => ({url:localUrl(a.getAttribute('href')), text:a.innerText.slice(0,2000)})).filter(a => a.url);
  const authorLinkPresent = links.some(a => new URL(a.url).pathname.replaceAll('/','') === expectedUsername);
  if (post && !authorLinkPresent) throw Error('帖子正文没有找到所选账号的可见链接，停止以防保存其他账号内容');
  const times = [...scope.querySelectorAll('time')].filter(visible);
  const controls = [...scope.querySelectorAll('button,[role="button"],svg[aria-label]')].filter(visible);
  const commentEvidence=[];
  const commentId=a=>{
    try {
      const u=new URL(a.getAttribute('href'),page.origin);
      if(u.origin!==page.origin) return '';
      const match=u.pathname.match(/^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels)\/([A-Za-z0-9_-]+)\/c\/(\d+)\/?$/);
      if(match && match[1]===post?.[2]) return match[2];
      if(u.pathname.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/)?.[1]===post?.[2] && /^\d+$/.test(u.searchParams.get('comment_id') || '')) return u.searchParams.get('comment_id');
    }catch{}return '';
  };
  if(post) for(const anchor of anchors) {
    const id=commentId(anchor);if(!id) continue;
    let container=anchor.parentElement;
    for(let depth=0;container && container!==scope && depth<8;depth++,container=container.parentElement) {
      const ownTimes=[...container.querySelectorAll('time')].filter(visible);
      const people=[...container.querySelectorAll('a[href]')].filter(visible).filter(a=>{
        try {return new URL(a.href).pathname.replace(/\/$/,'')==='/'+a.innerText.trim() && /^[A-Za-z0-9._]+$/.test(a.innerText.trim());}catch{return false;}
      });
      if(ownTimes.length!==1 || !people.length) continue;
      const text=container.innerText || '';
      if(text.length>5000) break;
      const item=container.closest('li,[role="listitem"]');
      const outer=item?.parentElement?.closest('li,[role="listitem"]');
      const parentIds=outer ? [...outer.querySelectorAll('a[href]')].filter(a=>a.closest('li,[role="listitem"]')===outer).map(commentId).filter(other=>other && other!==id):[];
      commentEvidence.push({comment_id:id,parent_comment_id:new Set(parentIds).size===1?parentIds[0]:'',
        author_username:people[0].innerText.trim(),datetime:ownTimes[0].getAttribute('datetime') || '',text,
        source_url:new URL(anchor.getAttribute('href'),page.origin).href});break;
    }
  }
  // Media presence alone cannot distinguish a single image from the first slide of a carousel.
  const mediaLabels=controls.map(c=>c.getAttribute('aria-label') || '').filter(Boolean);
  const carousel=mediaLabels.some(label=>/^(轮播|Carousel)$/i.test(label));
  const video=!!scope.querySelector('video');
  const metricEvidence=[];
  if(post && dialog[0]) for(const el of scope.querySelectorAll('a,span')) {
    if(!visible(el) || el.closest('li,[role="listitem"]')) continue;
    const text=el.innerText?.trim() || '';
    for(const [field,pattern] of [['comment_count',/^查看全部\s*([\d,.万亿KkMm]+)\s*条评论$/],
      ['view_count',/^([\d,.万亿KkMm]+)\s*次观看$/],['play_count',/^([\d,.万亿KkMm]+)\s*次播放$/]]) {
      const m=text.match(pattern);if(m) metricEvidence.push({field,raw:m[1],label:text,source:'confirmed_detail_outside_comment_items'});
    }
  }
  return {
    schema:'instagram_dom_diagnostic_v1', version:'0.4.2',
    collected_at_utc:new Date().toISOString(), username:expectedUsername,
    page_url:'https://www.instagram.com' + page.pathname,
    page_kind:post ? 'post' : 'profile', shortcode:post?.[2] || '',
    identity_status:post ? 'target_link_present_author_not_yet_verified' : 'profile_url_matches',
    source:'chrome_visible_dom', status:'diagnostic_only', scope:dialog[0] ? 'visible_dialog' : 'main',
    visible_text:parts.join('\n'), links,
    comment_evidence:commentEvidence.slice(0,400),
    metric_evidence:metricEvidence.slice(0,30),
    media_evidence:{type:carousel?'carousel':video && !!dialog[0]?'video':'unverified',labels:mediaLabels.slice(0,40),
      source:carousel?'explicit_carousel_label':video && !!dialog[0]?'video_in_confirmed_dialog':'insufficient_type_evidence'},
    times:times.slice(0,200).map(t=>({text:t.innerText, datetime:t.getAttribute('datetime') || '', title:t.getAttribute('title') || ''})),
    controls:controls.slice(0,400).map(b=>({tag:b.tagName, text:(b.innerText || '').slice(0,5000), label:b.getAttribute('aria-label') || '',
      times:[...b.querySelectorAll('time')].filter(visible).slice(0,30).map(t=>({text:t.innerText,datetime:t.getAttribute('datetime') || '',title:t.getAttribute('title') || ''})),
      text_truncated:(b.innerText || '').length>5000})),
    truncation:{text:textTruncated,links:anchors.length>1000,times:times.length>200,controls:controls.length>400},
    coverage:'current_rendered_page_only', metrics_status:'not_mapped', comments_status:'not_parsed', history_complete:false
  };
}
