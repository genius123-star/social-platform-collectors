"use strict";
// Research-facing tables: selected observations only; evidence stays in raw export.
globalThis.localPandaReadable=(()=>{
  const missing='无法获取';
  const decode=(value,fallback)=>{if(!value)return fallback;try{return JSON.parse(value);}catch{throw new Error('导出遇到损坏的原始记录，请先导出原始证据。');}};
  function number(raw){
    const s=String(raw??'').trim().replace(/,/g,'').replace(/\s/g,'');
    const m=s.match(/^(\d+(?:\.\d+)?)([KMB万亿]?)$/i);
    return m?Number(m[1])*({'':1,K:1000,M:1e6,B:1e9,'万':1e4,'亿':1e8}[m[2].toUpperCase()]):null;
  }
  function metrics(controls=[],labels=[],scoped=false){
    const values={};const observe=(k,raw,note='页面明确显示')=>{const value=number(raw);if(value!==null)(values[k]??=[]).push({value,raw,note});};
    const rules={like:[/^(?:赞|Likes?)[：:]\s*([\d,. KMB万亿]+)(?:位用户|people)?$/i,/^([\d,. KMB万亿]+)\s+likes?$/i],
      reaction:[/^(?:总反应|所有心情|全部心情|All reactions|Reactions)[：:]?\s*([\d,. KMB万亿]+)$/i],
      comment:[/^(?:评论|Comments)[：:]\s*([\d,. KMB万亿]+)$/i,/^([\d,. KMB万亿]+)\s*(?:条评论|comments)$/i],
      share:[/^(?:分享|Shares)[：:]\s*([\d,. KMB万亿]+)$/i,/^([\d,. KMB万亿]+)\s*(?:次分享|shares)$/i]};
    for(const text of [...labels,...controls.flatMap(c=>[c.aria_label||'',c.text||''])])for(const [key,patterns]of Object.entries(rules))for(const pattern of patterns){const m=String(text).trim().match(pattern);if(m)observe(key,m[1]);}
    for(const c of controls){if(/^(发表评论|Comment|Comments)$/.test(c.aria_label||''))observe('comment',c.text);if((c.aria_label||'').startsWith('分享，'))observe('share',c.text);}
    const result={};for(const [key,all]of Object.entries(values))if(new Set(all.map(x=>x.value)).size===1)result[key]=all[0];
    if(scoped){
      const boundary=controls.findIndex(c=>/^(查看更多评论|View more comments)$/.test((c.text||'').trim()));
      const actions=boundary<0?controls:controls.slice(0,boundary);
      if(actions.some(c=>/^赞[：:]\s*[\d,.万亿KMBkmb\s]+位用户$/.test(c.aria_label||'')))delete result.like;
      const likes=actions.map((c,i)=>({c,i})).filter(x=>/^(赞|Like)$/.test(x.c.aria_label||'')&&number(x.c.text)!==null);
      const comments=actions.map((c,i)=>({c,i})).filter(x=>/^(发表评论|Comment|Comments)$/.test(x.c.aria_label||'')&&number(x.c.text)!==null);
      const shares=actions.map((c,i)=>({c,i})).filter(x=>comments.length===1&&x.i>comments[0].i&&/^(分享(?:，.*)?|Share)$/.test(x.c.aria_label||''));
      if(likes.length===1)result.like={value:number(likes[0].c.text),raw:likes[0].c.text,note:'页面互动栏显示数，可能包含其他反应'};
      if(likes.length===1&&comments.length===1&&shares.length===1&&likes[0].i<comments[0].i&&comments[0].i<shares[0].i&&!shares[0].c.aria_busy&&!shares[0].c.disabled){
        const raw=(shares[0].c.text||'').trim();
        if(number(raw)!==null)result.share={value:number(raw),raw,note:'页面明确显示'};
        else if(!raw&&!result.share)result.share={value:0,raw:'',note:'按完整的数字点赞/评论/空白分享栏推定为0'};
      }
    }
    return result;
  }
  function commentRows(row){
    const key=globalThis.localPandaCommentReader({}).postKey;
    const post=key(row.post_url),merged=new Map();
    const input=[...decode(row.raw_visible_comments_json,[]),...decode(row.raw_dialog_visible_comments_json,[])];
    input.forEach((c,index)=>{
      const own=(c.links||[]).filter(l=>key(l.url)===post&&/[?&](?:reply_)?comment_id=/.test(l.url));
      const identities=[...new Set(own.map(l=>{const q=new URL(l.url).searchParams;return q.get('reply_comment_id')||q.get('comment_id');}).filter(Boolean))];
      const id=identities.length===1?identities[0]:'';
      // Unidentified observations retain separate rows; don't guess identity from text.
      merged.set(id?'id:'+id:'unverified:'+index,{...c,id,own});
    });
    return [...merged.values()].map(c=>{
      const raw=c.text||'',m=raw.match(/\n\s*·\s*\n[^\n]+\n([\s\S]*?)\n回复(?:\n|$)/);
      const link=c.own.find(l=>{const q=new URL(l.url).searchParams;return (q.get('reply_comment_id')||q.get('comment_id'))===c.id;});
      const q=link?new URL(link.url).searchParams:null;
      return {序号:Number(row.sample_index)||'',帖子链接:row.post_url,评论ID:c.id||missing,父评论ID:q?.get('reply_comment_id')?q.get('comment_id')||missing:'不适用或未确认',
        评论作者显示文字:raw.split('\n').find(x=>x.trim())?.trim()||missing,评论正文:m?.[1]||missing,
        评论原文:raw||missing,评论显示时间:link?.aria_label||link?.text||missing,评论准确时间:missing,评论点赞数:missing,
        评论链接:link?.url||missing,提取状态:m?'按显示结构提取，待核验':'正文边界未确认，原文已保留'};
    });
  }
  function build(state){
    const target=localPandaTarget.fromState(state),posts=[],comments=[];
    const rows=Object.values(state.rows||{}).sort((a,b)=>Number(a.sample_index)-Number(b.sample_index));
    for(const row of rows){
      const detail=decode(row.raw_detail_evidence_json,{}),listBody=decode(row.raw_post_body_json,{});
      const body=detail.body?.text?detail.body:listBody;
      const scoped=!!row.raw_post_only_controls_json;
      const list=metrics(decode(row.raw_post_only_controls_json||row.raw_controls_json,[]),[],scoped);
      const dm=metrics(detail.controls||[],detail.labels||[],!!detail.body);
      const combined={...list,...dm};
      if(dm.share?.note.includes('推定')&&list.share&&!list.share.note.includes('推定'))combined.share=list.share;
      const date=localPandaPublicationTime(row,{...state.config,display_timezone_policy:'user_assumed_Asia_Shanghai'}),cr=commentRows(row);comments.push(...cr);
      const value=k=>combined[k]?.value??missing;
      const raw=k=>combined[k]?.raw|| (combined[k]?.value===0?'0':missing);
      const status=row.raw_detail_evidence_json?'已读取详情':row.post_content_kind==='image'?'仅主页数据（图片）':'仅主页数据（详情未获取）';
      posts.push({序号:Number(row.sample_index)||'',账号名称:state.profile?.name_raw||target.name,主页链接:target.profile_url,帖子链接:row.post_url,
        扫描范围:state.start_position?.mode==='current_viewport'?'从用户指定位置向下扫描；上方帖子不在本批范围':'按本批运行记录扫描，历史完整性未保证',
        发布时间_北京时间:date.publication_time_bjt||missing,时间说明:date.publication_time_bjt?'完整日期按约定解释为北京时间':'没有可确认的完整日期，未猜测',
        日期范围:({in_range:'研究期内',before_start:'早于研究期',after_end:'晚于研究期',date_pending:'日期待核验'})[date.range]||'日期待核验',
        正文:body.text||missing,正文完整性:body.status==='explicit_message_container'?'明确正文容器':body.text?'正文可能截断，需核验':missing,
        标签:(body.hashtags||[]).join(' '),点赞数:value('like'),点赞显示原文:raw('like'),反应总数:value('reaction'),
        反应明细_页面原文:[...new Set([...(detail.labels||[]),...(detail.controls||[]).map(c=>c.aria_label||''),...decode(row.raw_post_only_controls_json||row.raw_controls_json,[]).map(c=>c.aria_label||'')].filter(x=>/^(?:赞|大爱|关心|哈哈|哇|难过|怒|Like|Love|Care|Haha|Wow|Sad|Angry)[：:]\s*\d/i.test(x)))].join('；')||missing,
        评论数:value('comment'),评论显示原文:raw('comment'),分享数:value('share'),分享显示原文:raw('share'),分享说明:combined.share?.note||missing,
        已保存评论条数:cr.length,评论覆盖:row.comment_sort_status==='all_comments_visible_selected'?'已选择所有评论，全部加载未保证':'可见评论子集，完整性未确认',
        帖子识别策略:({'article_header':'标准帖子容器','article_localized_header':'帖子容器＋其他语言日期','message_ancestor_verified_comment_bar':'正文容器＋作者/日期/评论栏核验','verified_dialog_header':'已核验详情页'}[row.discovery_strategy]||row.discovery_strategy||'旧批次未记录'),
        详情状态:status,采集异常:row.collection_stop_reason||'无记录',播放量:missing,浏览量:missing});
    }
    return {posts,comments,target};
  }
  function save(rows,fields,name){
    const cell=v=>'"'+String(typeof v==='string'&&/^[=+@-]/.test(v)?"'"+v:v??'').replaceAll('"','""')+'"';
    const csv='\uFEFF'+[fields,...rows.map(r=>fields.map(f=>r[f]))].map(r=>r.map(cell).join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  function download(state,kind='posts'){
    const data=build(state),rows=data[kind];if(!rows)throw new Error('unsupported_export');
    const fields=kind==='posts'?Object.keys(rows[0]||{序号:'',账号名称:'',发布时间_北京时间:'',正文:'',点赞数:'',评论数:'',分享数:'',帖子链接:''}):Object.keys(rows[0]||{序号:'',帖子链接:'',评论ID:'',评论正文:'',评论原文:'',评论显示时间:''});
    save(rows,fields,'Facebook_'+data.target.account_key+'_'+(kind==='posts'?'帖子':'评论')+'_'+new Date().toISOString().replace(/[:.]/g,'-')+'.csv');
    return rows.length;
  }
  return {build,download};
})();
