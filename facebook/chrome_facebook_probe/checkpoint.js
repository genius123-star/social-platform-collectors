"use strict";
// Shared by the resume selector and the user-facing checkpoint display.
globalThis.localPandaCheckpoint=(()=>{
  const decode=(raw,fallback)=>{try{return JSON.parse(raw||'')||fallback;}catch{return fallback;}};
  function select(state){
    const keyOf=localPandaCommentReader({}).postKey,rows=Object.values(state?.rows||{});
    const candidates=[state?.current_post,state?.last_interrupted_post,state?.resume_cursor?.post_key,state?.source_cursor?.post_key];
    let row,key;
    for(const candidate of candidates){
      const match=candidate&&rows.find(value=>keyOf(value.post_url)===candidate);
      if(match){row=match;key=candidate;break;}
    }
    if(!row&&rows.length){row=rows.slice().sort((a,b)=>Number(b.sample_index)-Number(a.sample_index))[0];key=keyOf(row.post_url);}
    if(!row)return null;
    const retry=!(state.completed||[]).includes(key)||[state.current_post,state.last_interrupted_post].filter(Boolean).includes(key);
    return {row,key,retry};
  }
  function summary(state){
    const selected=select(state);if(!selected)return null;
    const {row,key,retry}=selected;
    let date={};try{date=localPandaPublicationTime(row,{...state.config,display_timezone_policy:'user_assumed_Asia_Shanghai'});}catch{}
    const detail=decode(row.raw_detail_evidence_json,{}),body=detail.body?.text?detail.body:decode(row.raw_post_body_json,{});
    const ownLinks=decode(row.raw_links_json,[]).filter(link=>localPandaCommentReader({}).postKey(link.url)===key);
    const displayed=ownLinks.flatMap(link=>[link.title,link.aria_label,link.text]).find(value=>typeof value==='string'&&value.trim())||'';
    return {post_key:key,post_url:row.post_url,sample_index:Number(row.sample_index)||null,retry_post:retry,
      publication_time_bjt:date.publication_time_bjt||'',publication_time_status:date.status||'date_pending',
      displayed_time_raw:displayed.trim().slice(0,120),body_preview:(body.text||'').replace(/\s+/g,' ').trim().slice(0,160),
      saved_records:Object.keys(state.rows||{}).length,detail_records:Object.values(state.rows||{}).filter(value=>value.raw_detail_evidence_json).length};
  }
  function render(container,state){
    if(!container)return;
    container.replaceChildren();const info=state&&summary(state);
    if(!info){container.textContent='暂无已保存帖子，尚无可用断点。';return;}
    const text=document.createElement('div');text.style.whiteSpace='pre-wrap';
    const time=info.publication_time_bjt?info.publication_time_bjt.replace('T',' ').replace(/\.\d+\+08:00$/,''):'无法获取准确时间'+(info.displayed_time_raw?'；页面原文：'+info.displayed_time_raw:'');
    text.textContent=`断点定位参考：第${info.sample_index??'未知'}帖（${info.retry_post?'重试此帖':'定位后继续后续帖子'}）\n发布时间（北京时间）：${time}\n正文：${info.body_preview||'正文暂未获取'}\n已保存${info.saved_records}条记录，其中${info.detail_records}帖已读详情。`;
    container.append(text);
    if(info.post_key){
      const link=document.createElement('a');link.href=info.post_url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='查看断点帖链接';container.append(link);
    }
  }
  return {select,summary,render};
})();
