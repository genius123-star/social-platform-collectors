"use strict";
// Adapted from Piazza's scoped read-control / growth-wait approach.
// Upstream: Mic-Fundraiser/piazza @ 94d47079aa342bc709adea8b0aa5ad2adb8cd1cd.
// Copyright (c) 2026 Michelangelo Gigli. See PIAZZA_LICENSE.txt.
globalThis.localPandaCommentReader = function ({visible, restricted, cleanLink}) {
  const clock=()=>globalThis.localPandaTiming?.clock()??performance.now();
  const delay=ms=>globalThis.localPandaTiming?.delay(ms)??new Promise(resolve=>setTimeout(resolve,ms));
  const text = node => (node.innerText || '').replace(/[\s\uFEFF]+/g, ' ').trim();
  const names = node => [node.getAttribute('aria-label'), text(node)].filter(Boolean)
    .map(t => t.replace(/[\s\uFEFF]+/g, ' ').trim());
  const patterns = {
    sort:/^(最相关|最相关评论|最新评论|最新|由新到旧|所有评论|全部评论|Most relevant|Top comments|Newest|All comments)[\s·]*$/i,
    all:/^(所有评论|全部评论|All comments)(?:\s|$)/i,
    selected:/^(所有评论|全部评论|All comments)[\s·]*$/i,
    more:/^(?:查看更多评论|查看之前的评论|查看更多回复|查看之前的回复|查看(?:另外\s*)?\d+\s*条(?:评论|回复)|(?:See|View|Load)\s+(?:(?:\d+|more|previous|another)\s+)*(?:comments|replies)|\d+\s+replies)$/i,
    full:/^[\s.…·]*(?:展开|查看更多|显示更多|See more|Show more|Read more|See full comment)[\s.…·]*$/i
  };
  const controls = (root, pattern) => [...root.querySelectorAll('button,[role="button"]')]
    .filter(n => visible(n) && names(n).some(t => pattern.test(t)));
  const menuSelector='[role="menuitem"],[role="menuitemradio"],[role="option"],button,[role="button"],[role="menu"] [tabindex],[role="listbox"] [tabindex]';
  const visibleMenuNodes = () => [...document.querySelectorAll(menuSelector)].filter(visible);
  const allOptions = before => {
    // Facebook may use ordinary buttons, or nested wrappers for one option.
    // Only newly visible controls or explicit menu choices; never the old sort trigger.
    const candidates=visibleMenuNodes().filter(n =>
      (!before.has(n) || n.matches('[role="menuitem"],[role="menuitemradio"],[role="option"]')) &&
      names(n).some(t => patterns.all.test(t)));
    for (const menu of document.querySelectorAll('[role="menu"],[role="listbox"]')) {
      if (!visible(menu)) continue;
      for (const label of menu.querySelectorAll('span')) {
        if (!visible(label) || !names(label).some(t => patterns.selected.test(t))) continue;
        const target=label.closest('[role="menuitem"],[role="menuitemradio"],[role="option"],button,[role="button"],[tabindex]') || label;
        if (menu.contains(target) && !before.has(target)) candidates.push(target);
      }
    }
    const unique=[...new Set(candidates)];
    return unique.filter(n => !unique.some(other => other!==n && n.contains(other)));
  };
  const menuEvidence = before => ({
    matching_count:allOptions(before).length,
    menus:[...document.querySelectorAll('[role="menu"],[role="listbox"]')].filter(visible)
      .map(n=>({role:n.getAttribute('role'),text:text(n).slice(0,1200)})).slice(0,4),
    candidates:visibleMenuNodes().filter(n => !before.has(n) ||
      n.matches('[role="menuitem"],[role="menuitemradio"],[role="option"]')).slice(0,40)
      .map(n => ({tag:n.tagName,role:n.getAttribute('role') || '',
        text:text(n).slice(0,250),aria_label:(n.getAttribute('aria-label') || '').slice(0,250)}))
  });
  function activateReadControl(node,{method='click'}={}) {
    if (restricted()) throw new Error('access_or_verification_required');
    if (!visible(node) || !names(node).some(t=>patterns.sort.test(t) || patterns.all.test(t))) {
      throw new Error('not_a_verified_comment_sort_control');
    }
    // One activation method per observed attempt. Sending pointerdown and click
    // together can open then close a toggle menu. Events remain untrusted.
    if(method==='click'){node.click();return;}
    if(method!=='pointer')throw new Error('unsupported_sort_activation_method');
    const r=node.getBoundingClientRect(), init={bubbles:true,cancelable:true,view:window,
      clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0};
    node.dispatchEvent(new PointerEvent('pointerdown',{...init,pointerId:1,pointerType:'mouse',isPrimary:true,buttons:1}));
    node.dispatchEvent(new PointerEvent('pointerup',{...init,pointerId:1,pointerType:'mouse',isPrimary:true,buttons:0}));
  }
  const postKey = raw => {
    try {
      const u=new URL(raw, location.href);
      if (!['facebook.com','www.facebook.com'].includes(u.hostname)) return '';
      const m=u.pathname.match(/\/(posts|videos|reel|permalink)\/([^/]+)/);
      if (m) return m[1]+':'+m[2];
      const photo=u.pathname.match(/\/photos\/(?:[^/]+\/)?(\d+)\/?$/);
      if(photo)return 'photo:'+photo[1];
      if(u.pathname==='/photo.php'&&u.searchParams.get('fbid'))return 'photo:'+u.searchParams.get('fbid');
      const id=u.searchParams.get('story_fbid');
      return id ? 'story:'+id+':'+(u.searchParams.get('id') || '') : '';
    } catch {return '';}
  };
  const commentKey = comment => {
    const ids=new Set(comment.links.map(x => {
      // Profile links sometimes carry an encoded comment token; use resource links only.
      if (!postKey(x.url)) return null;
      const u=new URL(x.url); return u.searchParams.get('reply_comment_id') || u.searchParams.get('comment_id');
    }).filter(Boolean));
    return ids.size===1 ? 'id:'+ [...ids][0] : 'raw:'+JSON.stringify(comment.links)+comment.text;
  };
  const read = root => [...root.querySelectorAll('[role="article"]')].filter(visible)
    .filter(n => [...n.querySelectorAll('a[href]')].some(a => a.closest('[role="article"]')===n && /[?&](?:reply_)?comment_id=/.test(a.href)))
    .map(n => {
      const ownLinks=[...n.querySelectorAll('a[href]')].filter(a => a.closest('[role="article"]')===n);
      let body=n.innerText;
      for (const child of n.querySelectorAll('[role="article"]')) {
        if (child.innerText) body=body.replace(child.innerText, '');
      }
      const messages=[...n.querySelectorAll('[data-testid="comment_message"]')].filter(m=>m.closest('[role="article"]')===n&&visible(m));
      return {text:body, raw_container_including_replies:n.innerText,
        message_text:messages.length===1?messages[0].innerText:'',message_status:messages.length===1?'explicit_comment_message':'raw_container_only',
        time_elements:[...n.querySelectorAll('time,abbr[data-utime]')].filter(t=>t.closest('[role="article"]')===n)
          .map(t=>({text:t.innerText,datetime:t.getAttribute('datetime'),unix_time:t.getAttribute('data-utime')})),
        image_alt_labels:[...n.querySelectorAll('img[alt]')]
          .filter(img=>img.closest('[role="article"]')===n && visible(img))
          .map(img=>img.getAttribute('alt')).filter(Boolean),
        links:ownLinks.map(a => ({url:cleanLink(a.href),text:a.innerText,
          aria_label:a.getAttribute('aria-label') || '',title:a.getAttribute('title') || ''})).filter(x => x.url),
        controls:[...n.querySelectorAll('button,[role="button"]')]
          .filter(b => visible(b) && b.closest('[role="article"]')===n)
          .map(b => ({text:b.innerText,aria_label:b.getAttribute('aria-label') || ''}))};
    });
  // Only exact, short expansion labels within a comment article; never bare Reply.
  const fullTextControls = root => {
    const result=new Set(), walker=document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node=walker.nextNode())) {
      const label=(node.nodeValue || '').trim(), parent=node.parentElement;
      if (!label || label.length>35 || !patterns.full.test(label) || !parent) continue;
      const article=parent.closest('[role="article"]');
      if (!article || !root.contains(article)) continue;
      const hasComment=[...article.querySelectorAll('a[href]')].some(a =>
        a.closest('[role="article"]')===article && /[?&](?:reply_)?comment_id=/.test(a.href));
      if (!hasComment) continue;
      const clickable=parent.closest('button,[role="button"],[tabindex]') || parent;
      if (!root.contains(clickable) || clickable.closest('a[href],input,textarea,[contenteditable="true"]')) continue;
      if (visible(clickable) && names(clickable).some(t => patterns.full.test(t))) result.add(clickable);
    }
    return [...result];
  };
  // Fixed minimum interval, then observe the scoped content; bounded at 6 seconds.
  async function waitForChange(root, before, capture=()=>{}) {
    const started=clock(); let changed=false;
    while (clock()-started<6000) {
      await delay(250);
      if (restricted()) return 'restricted';
      if (!root.isConnected) return 'detached';
      await capture();
      changed ||= root.innerText!==before;
      if (changed && clock()-started>=2500) return 'changed';
    }
    return 'unchanged';
  }
  return {text,names,patterns,controls,visibleMenuNodes,allOptions,menuEvidence,activateReadControl,
    postKey,commentKey,read,fullTextControls,waitForChange};
};
