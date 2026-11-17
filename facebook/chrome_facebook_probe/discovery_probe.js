"use strict";
// Read-only diagnostic of rendered public post headers. Does not start the runner.
globalThis.localPandaDiscoveryProbe=()=>{
  const target=localPandaTarget.parse(location.href);
  if(!target)throw new Error('请在目标账号主页保存识别诊断，不要打开详情或Reels页面');
  const main=document.querySelector('[role="main"],main');
  if(!main)throw new Error('未找到主页主区域，未读取其他区域');
  const blocked='script,style,template,iframe,input,textarea,select,[role="textbox"],[role="navigation"],[role="banner"],[data-pagelet*="Chat"],[contenteditable="true"],#local-panda-collector-panel';
  const shown=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'&&!n.closest('[hidden],[aria-hidden="true"],[inert],'+blocked);};
  const clean=raw=>{try{const u=new URL(raw,location.href);if(!['facebook.com','www.facebook.com'].includes(u.hostname))return '';const q=new URLSearchParams();for(const k of ['id','fbid','story_fbid','comment_id','reply_comment_id'])if(u.searchParams.has(k))q.set(k,u.searchParams.get(k));return 'https://www.facebook.com'+u.pathname+(q.size?'?'+q:'');}catch{return '';}};
  const key=localPandaCommentReader({}).postKey;
  const timeish=s=>/^(?:\d+\s*(?:天|小时|分钟|周|年|[smhdwy])|\d{1,4}[年月/.-]|昨天|刚刚|Yesterday|Just now|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))/i.test(s.trim());
  const attrs=n=>({tag:n.tagName,role:n.getAttribute('role')||'',data_pagelet:n.getAttribute('data-pagelet')||'',
    messages:n.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-testid="post_message"]').length,
    articles:n.querySelectorAll('[role="article"]').length});
  const link=a=>{const url=clean(a.href);return {url,text:(a.innerText||'').trim().slice(0,120),aria_label:(a.getAttribute('aria-label')||'').slice(0,180),
    title:(a.getAttribute('title')||'').slice(0,180),post_key:url?key(url):'',target_author_match:localPandaTarget.same(url,target)};};
  const heads=[...main.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(shown).slice(0,20).map(n=>({text:(n.innerText||'').trim().slice(0,140),...attrs(n)}));
  const postHead=[...main.querySelectorAll('h1,h2,h3,[role="heading"]')].find(n=>shown(n)&&/^(帖子|Posts)$/.test((n.innerText||'').trim())&&!n.closest('[role="article"],[role="dialog"]'));
  const roots=[...main.querySelectorAll('[role="article"]')].filter(n=>shown(n)&&!n.closest('[role="dialog"]'));
  const cards=roots.filter(n=>!n.parentElement.closest('[role="article"]')).slice(0,8).map(n=>{
    const own=[...n.querySelectorAll('a[href]')].filter(a=>shown(a)&&a.closest('[role="article"]')===n&&!/[?&](?:reply_)?comment_id=/.test(a.href));
    const links=own.map(link).filter(l=>l.url),authors=links.filter(l=>!l.post_key),dates=links.filter(l=>l.post_key&&[l.text,l.aria_label,l.title].some(timeish));
    const dateAnchor=own.find(a=>key(a.href)&&[a.innerText||'',a.getAttribute('aria-label')||'',a.getAttribute('title')||''].some(timeish));
    const selected=dateAnchor&&own.find(a=>!!(a.compareDocumentPosition(dateAnchor)&Node.DOCUMENT_POSITION_FOLLOWING)&&!key(a.href)&&!localPandaTarget.isStoryLink(a.href));
    return {...attrs(n),after_posts_heading:!!postHead&&!!(postHead.compareDocumentPosition(n)&Node.DOCUMENT_POSITION_FOLLOWING),
      first_non_resource_link:authors[0]||null,first_author_matches:!!authors[0]?.target_author_match,
      selected_header_author:selected?link(selected):null,selected_header_author_matches:!!selected&&localPandaTarget.same(selected.href,target),
      unique_dated_resource_count:new Set(dates.map(l=>l.post_key)).size,dated_links:dates.slice(0,8),header_links:links.slice(0,12)};
  });
  const messages=[...main.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-testid="post_message"]')].filter(shown).slice(0,6).map(n=>{
    const ancestors=[];let p=n.parentElement;
    for(let depth=1;p&&p!==main&&depth<=8;p=p.parentElement,depth++){
      const headerLinks=[...p.querySelectorAll('a[href]')].filter(a=>shown(a)&&!!(a.compareDocumentPosition(n)&Node.DOCUMENT_POSITION_FOLLOWING)).slice(0,10).map(link).filter(l=>l.url);
      ancestors.push({depth,...attrs(p),header_links:headerLinks});
    }
    return {...attrs(n),ancestors};
  });
  const fresh=localPandaPageReader();fresh.setTarget(target);const freshDiscovery=fresh.discover();
  let runtime;try{runtime=globalThis.localPandaCollector?.discoveryStatus?.()||{status:'runtime_discovery_method_unavailable',runner_version:globalThis.localPandaCollector?.version||'not_loaded'};}
  catch(error){runtime={status:'runtime_discovery_failed',error:String(error.message||error)};}
  const report={record_type:'post_discovery_diagnostic',version:'0.6.9',profile_url:target.profile_url,
    collected_at_utc:new Date().toISOString(),viewport_width:innerWidth,viewport_height:innerHeight,
    posts_heading_found:!!postHead,article_count:roots.length,top_level_cards_sampled:cards.length,
    headings_json:JSON.stringify(heads),card_filter_evidence_json:JSON.stringify(cards),message_ancestor_evidence_json:JSON.stringify(messages),
    fresh_discovery_json:JSON.stringify({error:freshDiscovery.error,evidence:freshDiscovery.evidence}),
    runtime_discovery_json:JSON.stringify(runtime),
    scope:'Rendered public header structure only; no clicks, scrolling, input values, cookies, scripts or hidden application data'};
  const fields=Object.keys(report),cell=v=>'"'+String(v??'').replaceAll('"','""')+'"';
  const csv='\uFEFF'+[fields,fields.map(f=>report[f])].map(row=>row.map(cell).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');
  const filename='facebook_discovery_'+target.account_key+'_'+report.collected_at_utc.replace(/[:.]/g,'-')+'.csv';
  a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  return {ok:true,filename,article_count:roots.length,sampled:cards.length,messages_sampled:messages.length};
};
