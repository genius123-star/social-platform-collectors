"use strict";
// Same normalizer is used by browser CSV export and offline import of real diagnostic evidence.
globalThis.VKProbeSamples = (() => {
  const C=VKProbeCore, OWNER="-42692593", EXPORT_VERSION='0.5.1';
  const schemas={
    account:['批次','主体','平台','账号键','登记语种','墙ID','显示名称','主页','粉丝数','粉丝原文','粉丝状态','身份状态','采集时间UTC','采集时间北京时间'],
    posts:['批次','帖子主键','墙ID','帖子ID','链接','归属状态','原始显示时间','发布时间UTC','发布时间北京时间','时间状态','期间分类','正文','正文状态','正文展开状态','自动提示状态','处理状态','处理错误','话题标签','点赞数','点赞原文','点赞状态','评论数','评论原文','评论状态','分享数','分享原文','分享状态','墙帖浏览数','浏览原文','浏览状态','浏览采集时间UTC','内容类型证据','转发状态','评论明细状态','卡片可见原文','采集时间UTC','读取策略'],
    media:['批次','媒体主键','类型','所有者ID','媒体ID','链接','标题或链接文字','视频播放数','播放状态','采集时间UTC'],
    relations:['批次','帖子主键','媒体主键','观察次序','关系状态'],
    comments:['批次','所属资源主键','评论ID','父评论ID','回复关系状态','作者链接','正文','点赞数','原始时间','时间UTC','时间北京时间','时间状态','采集时间UTC','状态'],
    report:['批次','采集版本','导出版本','目标','研究起日','研究止日','时间口径','候选数','独立样本数','严格归属通过数','拒绝数','期间内数','期间外数','日期待核验数','正文缺失数','点赞缺失数','评论数字段明确零数','分享字段明确零数','评论明细条数','媒体记录数','时间提示记录数','试采阶段','已处理数','正文展开确认数','自动提示成功数','部分处理数','扫描起点','恢复次数','断点时间UTC','滚动次数','连续无增长次数','单次帖子预算','单次时间预算分钟','覆盖状态','停止原因','来源'],
    tooltip:['批次','帖子主键','提示原文','关联状态','交互来源','采集时间UTC','日期状态'],
    rejected:['批次','资源','原因']
  };
  const bjt=raw=>{const d=new Date(raw);return Number.isFinite(+d)?new Date(+d+28800000).toISOString().replace('Z','+08:00'):'';};
  function count(raw) {
    const text=String(raw||'').trim();
    if(!/^\d+(?:[ \u00a0\u202f]\d{3})*$/.test(text))return null;
    const value=Number(text.replace(/[ \u00a0\u202f]/g,''));
    return Number.isSafeInteger(value)?value:null;
  }
  function metric(candidate,name) {
    // Only explicit, whole labels with known meanings; never infer zero from an empty icon.
    const patterns={comment:/^(\d+(?:[ \u00a0\u202f]\d{3})*)\s*(?:条评论|comments?|комментари(?:й|я|ев))$/iu,
      share:/^(\d+(?:[ \u00a0\u202f]\d{3})*)\s*(?:分享|shares?|репост(?:а|ов)?)$/iu,
      like:/^(?:(\d+(?:[ \u00a0\u202f]\d{3})*)\s*(?:次赞|个赞|点赞|likes?|отметок «Нравится»)|(?:赞|点赞|Нравится|Like)\s*[:：]?\s*(\d+(?:[ \u00a0\u202f]\d{3})*))$/iu,
      view:/^(\d+(?:[ \u00a0\u202f]\d{3})*)\s*(?:次浏览|次查看|views?|просмотр(?:а|ов)?)$/iu};
    const bar=candidate.fields?.interaction_bar;
    const source=bar?.status==='comment_share_common_ancestor_verified'?bar.labels:
      !candidate.fields&&['comment','share'].includes(name)?candidate.controls||[]:[];
    const labels=source.map(v=>v.label||'');
    const observed=[...new Set(labels)].map(raw=>({raw,match:raw.trim().match(patterns[name])})).filter(v=>v.match)
      .map(v=>({raw:v.raw,value:count(v.match[1]||v.match[2])})).filter(v=>v.value!==null);
    if(!observed.length)return {value:'',raw:'',status:'missing_no_explicit_label'};
    if(new Set(observed.map(v=>v.value)).size!==1)return {value:'',raw:observed.map(v=>v.raw).join(' | '),status:'conflicting_labels'};
    return {value:observed[0].value,raw:observed.map(v=>v.raw).join(' | '),status:'explicit_label'};
  }
  function publication(candidate) {
    const records=(candidate.fields?.publication_times||[]).filter(v=>v.resource_key===candidate.resource.key);
    const raw=[...new Set([...records.map(v=>v.text),...(candidate.links||[])
      .filter(v=>v.resource?.key===candidate.resource.key&&!v.resource.reply&&!v.resource.thread).map(v=>v.text)].filter(Boolean))].join(' | ');
    const iso=[];
    for(const v of records)for(const text of [v.datetime,...(v.explicit_times||[])]) {
      if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text||''))continue;
      const [year,month,day]=text.slice(0,10).split('-').map(Number);
      if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate())continue;
      const time=Date.parse(text);if(Number.isFinite(time))iso.push(time);
    }
    const unique=[...new Set(iso)];
    if(unique.length!==1){
      if(!unique.length){
        const dates=records.flatMap(v=>[v.datetime,v.title,v.aria_label,v.text,...(v.explicit_times||[])]).map(C.projectDate).filter(Boolean);
        const distinct=[...new Set(dates.map(d=>d.bjt))];
        if(distinct.length===1)return {...dates[0],raw};
        if(distinct.length>1)return {raw,utc:'',bjt:'',status:'date_pending_conflict',range:'date_pending'};
      }
      return {raw,utc:'',bjt:'',status:unique.length?'date_pending_conflict':'date_pending_no_calendar_date',range:'date_pending'};
    }
    const t=unique[0],utc=new Date(t).toISOString();
    return {raw,utc,bjt:bjt(utc),status:'explicit_datetime_with_offset',
      range:t>=Date.parse('2025-10-16T16:00:00Z')&&t<Date.parse('2026-10-17T16:00:00Z')?'in_range':'out_of_range'};
  }
  function build(snapshot) {
    C.validate(snapshot);
    if(!/^\d{8}T\d{6}_[-\w]{8,}$/.test(snapshot.run_id||''))throw new Error('来源批次编号无效。');
    const result={account:[],posts:[],media:[],relations:[],comments:[],report:[],rejected:[],tooltip:[]};
    const run=snapshot.run_id,seen=new Set(),mediaSeen=new Set();
    for(const candidate of snapshot.candidates) {
      const r=C.resource(candidate.resource?.url,snapshot.entry_url);
      if(!r||r.type!=='wall'||r.owner_id!==OWNER||r.key!==candidate.resource.key||
        !new RegExp(`^(?:post|wall)?${OWNER}_${r.id}$`).test(candidate.public_id_attribute||'')) {
        result.rejected.push({批次:run,资源:r?.key||'',原因:'wall_resource_or_public_id_not_confirmed'});continue;
      }
      if(seen.has(r.key))continue;seen.add(r.key);
      const f=candidate.fields||{},headers=f.header_links||[];
      const identity=headers.length>0&&headers.every(h=>C.target(h.url)?.entry_url===snapshot.entry_url)
        ?'header_author_and_wall_verified':'wall_id_consistent_author_position_unverified';
      const date=publication(candidate),body=f.body||{};
      const metrics=Object.fromEntries(['like','comment','share','view'].map(k=>[k,metric(candidate,k)]));
      const bodyStatus=body.status==='visible_text_only'?(body.truncated?'diagnostic_limit_truncated':
        body.show_more_present?'show_more_not_expanded':'visible_text_only_not_completeness_proof'):'body_not_separated';
      const item={批次:run,帖子主键:r.key,墙ID:r.owner_id,帖子ID:r.id,链接:r.url,归属状态:identity,
        原始显示时间:date.raw,发布时间UTC:date.utc,发布时间北京时间:date.bjt,时间状态:date.status,期间分类:date.range,
        正文:body.text||'',正文状态:bodyStatus,话题标签:(body.text?.match(/#[\p{L}\p{N}_\-\u200b]+/gu)||[]).join(' | '),
        内容类型证据:f.attachment_carousel?'image_carousel_present':candidate.structure?.some(x=>x.classes?.includes('attachmentCarousel'))?'image_carousel_structure_observed':'type_unverified',
        转发状态:f.nested_post_containers?'nested_structure_requires_review':'repost_not_verified',
        评论明细状态:f.comments?.status||'not_collected',卡片可见原文:candidate.text||'',采集时间UTC:candidate.observed_at||snapshot.collected_at,
        读取策略:f.reader_strategy||'legacy_diagnostic_card_only'};
      const auto=snapshot.auto_run?.results?.[r.key];
      if(!f.comments?.status&&auto?.comments)item.评论明细状态=auto.comments;
      item.正文展开状态=auto?.body_expansion||'not_attempted';item.自动提示状态=auto?.tooltip||'not_attempted';
      item.处理状态=auto?.status||'snapshot_only';item.处理错误=auto?.error||'';
      for(const [key,label] of [['like','点赞'],['comment','评论'],['share','分享'],['view','浏览']]) {
        item[label==='浏览'?'墙帖浏览数':label+'数']=metrics[key].value;
        item[label+'原文']=metrics[key].raw;item[label+'状态']=metrics[key].status;
      }
      const hovers=(snapshot.hover_observations||[]).filter(h=>h.resource_key===r.key&&
        C.resource(h.resource_url)?.key===r.key&&h.association_status==='hover_lifecycle_confirmed'&&
        h.stable_samples>=2&&h.disappeared_after_leave===true&&typeof h.text==='string'&&h.text.length<=240&&
        Number.isFinite(Date.parse(h.collected_at))).sort((a,b)=>Date.parse(a.collected_at)-Date.parse(b.collected_at));
      for(const h of hovers)result.tooltip.push({批次:run,帖子主键:r.key,提示原文:h.text,关联状态:h.association_status,
        交互来源:h.source||'source_unrecorded',采集时间UTC:h.collected_at,日期状态:C.projectDate(h.text)?.status||'date_pending_no_calendar_date'});
      const last=hovers[hovers.length-1];
      if(last){
        item.原始显示时间 += ' | 悬停提示：'+last.text;
        if(!item.发布时间UTC&&item.时间状态!=='date_pending_conflict'){
          const assumed=C.projectDate(last.text);
          if(assumed){
            if(date.bjt&&date.bjt.slice(0,10)!==assumed.bjt.slice(0,10)){
              item.发布时间UTC='';item.发布时间北京时间='';item.时间状态='date_pending_conflict';item.期间分类='date_pending';
            }else{item.发布时间UTC=assumed.utc;item.发布时间北京时间=assumed.bjt;item.时间状态=assumed.status;item.期间分类=assumed.range;}
          }
        }
        const match=last.text.match(/(?:^|\n)\s*(\d+(?:[ \u00a0\u202f]\d{3})*)\s*浏览\s*(?:\n|$)/u);
        const views=match?count(match[1]):null;
        if(item.墙帖浏览数===''&&views!==null){item.墙帖浏览数=views;item.浏览原文=last.text;
          item.浏览状态='explicit_hover_label_lifecycle_confirmed';item.浏览采集时间UTC=last.collected_at;}
      }
      result.posts.push(item);
      for(const comment of f.comments?.items||[]){
        if(!/^\d+$/.test(comment.id||'')||comment.resource_key!==r.key||typeof comment.text!=='string')continue;
        if(result.comments.some(c=>c.所属资源主键===r.key&&c.评论ID===comment.id))continue;
        const t=publication({resource:{key:r.key},fields:{publication_times:[{resource_key:r.key,datetime:comment.time_raw,text:comment.time_raw}]}});
        result.comments.push({批次:run,所属资源主键:r.key,评论ID:comment.id,父评论ID:comment.parent_id||'',
          回复关系状态:comment.parent_status||'unverified',作者链接:comment.author_url||'',正文:comment.text,点赞数:comment.like_count??'',
          原始时间:comment.time_raw||'',时间UTC:t?.utc||'',时间北京时间:t?.bjt||'',时间状态:t?.status||'date_pending',
          采集时间UTC:comment.observed_at||candidate.observed_at,状态:'public_resource_scoped_DOM'});
      }
      let ordinal=0;
      for(const link of f.media_links||[]) {
        const m=C.resource(link.url,snapshot.entry_url);if(!m||!['video','photo','clip'].includes(m.type))continue;
        ordinal++;
        if(!result.relations.some(x=>x.帖子主键===r.key&&x.媒体主键===m.key))result.relations.push({批次:run,帖子主键:r.key,媒体主键:m.key,观察次序:ordinal,关系状态:'outer_post_public_link_only'});
        if(mediaSeen.has(m.key))continue;mediaSeen.add(m.key);
        result.media.push({批次:run,媒体主键:m.key,类型:m.type,所有者ID:m.owner_id,媒体ID:m.id,链接:m.url,
          标题或链接文字:link.text||'',视频播放数:'',播放状态:'not_read',采集时间UTC:candidate.observed_at||snapshot.collected_at});
      }
    }
    const followers=(snapshot.headings||[]).map(s=>({raw:s,m:s.match(/^(?:粉丝|Followers|Подписчики)\s+(\d+(?:[ \u00a0\u202f]\d{3})*)$/iu)})).filter(x=>x.m);
    const followerCounts=[...new Set(followers.map(x=>count(x.m[1])).filter(v=>v!==null))];
    result.account.push({批次:run,主体:'中国网',平台:'VK',账号键:'chinaorgcn_vk_ru',登记语种:'ru',
      墙ID:result.posts.length?OWNER:'',显示名称:snapshot.title,主页:snapshot.entry_url,
      粉丝数:followerCounts.length===1?followerCounts[0]:'',粉丝原文:followers.map(x=>x.raw).join(' | '),
      粉丝状态:followerCounts.length===1?'explicit_heading_snapshot':'missing_or_conflicting',
      身份状态:result.posts.length?'page_and_wall_observed_not_official_authentication':'unverified',
      采集时间UTC:snapshot.collected_at,采集时间北京时间:bjt(snapshot.collected_at)});
    result.report.push({批次:run,采集版本:snapshot.version,导出版本:EXPORT_VERSION,目标:snapshot.entry_url,
      研究起日:'2025-10-17',研究止日:'2026-10-17',时间口径:'explicit_offset_first; research_assumed_UTC+8; missing_year_2026',候选数:snapshot.candidates.length,独立样本数:result.posts.length,
      严格归属通过数:result.posts.filter(p=>p.归属状态==='header_author_and_wall_verified').length,
      拒绝数:result.rejected.length+(snapshot.rejected||[]).length,
      期间内数:result.posts.filter(p=>p.期间分类==='in_range').length,期间外数:result.posts.filter(p=>p.期间分类==='out_of_range').length,
      日期待核验数:result.posts.filter(p=>p.期间分类==='date_pending').length,正文缺失数:result.posts.filter(p=>!p.正文).length,
      点赞缺失数:result.posts.filter(p=>p.点赞数==='').length,
      评论数字段明确零数:result.posts.filter(p=>p.评论数===0).length,分享字段明确零数:result.posts.filter(p=>p.分享数===0).length,
      评论明细条数:result.comments.length,媒体记录数:result.media.length,时间提示记录数:result.tooltip.length,覆盖状态:snapshot.auto_run?.mode==='history'?'bounded_wall_history; comments_scope_reported_per_post; standalone_video_clips_not_collected':'current_loaded_samples_only; wall_history_video_clips_comments_not_collected',
      试采阶段:snapshot.auto_run?.phase||'not_automatic',已处理数:snapshot.auto_run?.processed_keys?.length||0,
      正文展开确认数:Object.values(snapshot.auto_run?.results||{}).filter(r=>r.body_expansion==='show_more_removed_after_same_post_click').length,
      自动提示成功数:Object.values(snapshot.auto_run?.results||{}).filter(r=>r.tooltip==='tooltip_saved').length,
      部分处理数:Object.values(snapshot.auto_run?.results||{}).filter(r=>r.status==='partial').length,
      扫描起点:snapshot.auto_run?.scan_origin||'loaded_snapshot',恢复次数:snapshot.auto_run?.resume_count||0,
      断点时间UTC:snapshot.auto_run?.heartbeat_at||snapshot.collected_at,
      滚动次数:snapshot.auto_run?.discovery_state?.scrolls||0,连续无增长次数:snapshot.auto_run?.discovery_state?.stalls||0,
      单次帖子预算:snapshot.auto_run?.mode==='history'?200:snapshot.auto_run?.keys?.length||0,
      单次时间预算分钟:snapshot.auto_run?.mode==='history'?30:3,
      停止原因:snapshot.auto_run?(snapshot.auto_run.stop_reason||'running_or_interrupted_checkpoint'):'one_read_only_snapshot',来源:snapshot.auto_run?'automatic_three_loaded_post_trial_evidence':'diagnostic_evidence_normalization_no_new_network_collection'});
    return result;
  }
  // Research-facing tables contain only readable values; internal evidence stays in JSON.
  const readableSchemas={
    posts:['账号','帖子ID','帖子链接','发布时间（北京时间）','正文','内容类型','原创或转发','话题标签','点赞数','评论数','分享数','帖子浏览数','是否在研究期内','采集时间（北京时间）','备注'],
    account:['主体','平台','账号','账号语种','主页链接','粉丝数','采集时间（北京时间）','备注'],
    comments:['所属帖子链接','评论ID','父评论ID','作者链接','评论正文','点赞数','发布时间（北京时间）','采集时间（北京时间）','备注'],
    media:['媒体编号','类型','媒体链接','标题','视频播放数','采集时间（北京时间）','备注'],
    relations:['帖子链接','媒体链接','附件顺序'],
    tooltip:['帖子链接','页面时间提示','采集时间（北京时间）','备注'],
    rejected:['帖子链接','说明'],
    report:['账号','研究开始日期','研究结束日期','发现帖子数','研究期内帖子数','研究期外帖子数','日期待核验帖子数','已处理帖子数','部分取得帖子数','正文缺失帖子数','点赞缺失帖子数','评论回复数','恢复次数','最近保存时间（北京时间）','运行状态','停止说明','覆盖说明']
  };
  const readableTime=raw=>String(raw||'').replace('T',' ').replace(/\.\d+(?=[Z+-]|$)/,'').replace(/(?:Z|[+-]\d{2}:\d{2})$/,'');
  const localTime=raw=>raw?readableTime(bjt(raw)):'';
  const link=key=>/^wall-?\d+_\d+$/.test(key||'')?'https://vk.ru/'+key:'';
  const ranges={in_range:'是',out_of_range:'否',date_pending:'日期待核验'};
  const reasons={three_post_trial_budget_completed:'3帖试采结束',loaded_trial_queue_exhausted:'已加载队列处理完毕',
    user_stopped:'用户暂停',user_stopped_page_unavailable:'用户停止时页面已关闭',one_read_only_snapshot:'仅保存当前页面样本',
    running_or_interrupted_checkpoint:'尚未结束或已中断，已有结果已保存',trial_time_budget_exhausted:'本次运行时间已用完，可继续',
    time_budget_exhausted:'本次运行时间已用完，可继续',page_hidden_trial_paused:'标签页隐藏，已暂停',
    unexpected_dialog_trial_paused:'页面出现弹窗，已暂停',no_new_verified_posts_after_six_scrolls_partial:'连续6轮未发现新增，保存部分结果',
    session_200_posts_budget_partial_resume_available:'本次200帖预算已用完，可继续',scroll_budget_partial:'本次滚动预算已用完，可继续'};
  function readable(kind,rows){
    if(!readableSchemas[kind])throw new Error('没有对应的可读导出格式。');
    return rows.map(row=>{
      if(kind==='posts'){
        const notes=[];
        for(const name of ['点赞','评论','分享'])if(row[name+'数']===''||row[name+'数']===undefined)notes.push(name+'数未取得');
        if(row.墙帖浏览数===''||row.墙帖浏览数===undefined)notes.push('浏览数未取得');
        if(String(row.时间状态).includes('default_year_2026'))notes.push('未显示年份，按2026年记录');
        if(String(row.时间状态).includes('research_assumed'))notes.push('时间按北京时间解释');
        if(row.正文状态==='show_more_not_expanded'||row.正文状态==='diagnostic_limit_truncated')notes.push('正文尚未完整展开');
        if(!row.正文)notes.push('正文未取得');
        if(!row.发布时间北京时间)notes.push('发布时间待核验');
        return {账号:'China.org.cn(Russian)',帖子ID:row.帖子ID,帖子链接:row.链接,
          '发布时间（北京时间）':readableTime(row.发布时间北京时间),正文:row.正文||'',
          内容类型:['image_carousel_present','image_carousel_structure_observed'].includes(row.内容类型证据)?'图片轮播':'未确认',
          原创或转发:row.转发状态==='nested_structure_requires_review'?'存在嵌套内容，待核实':'未核实',话题标签:row.话题标签||'',
          点赞数:row.点赞数??'',评论数:row.评论数??'',分享数:row.分享数??'',帖子浏览数:row.墙帖浏览数??'',
          是否在研究期内:ranges[row.期间分类]||'日期待核验','采集时间（北京时间）':localTime(row.采集时间UTC),备注:notes.join('；')};
      }
      if(kind==='account')return {主体:row.主体,平台:row.平台,账号:'China.org.cn(Russian)',账号语种:'俄语',主页链接:row.主页,
        粉丝数:row.粉丝数??'','采集时间（北京时间）':localTime(row.采集时间UTC),备注:row.粉丝数===''?'粉丝数未取得':''};
      if(kind==='comments')return {所属帖子链接:link(row.所属资源主键),评论ID:row.评论ID,父评论ID:row.父评论ID,作者链接:row.作者链接,
        评论正文:row.正文,点赞数:row.点赞数??'','发布时间（北京时间）':readableTime(row.时间北京时间),
        '采集时间（北京时间）':localTime(row.采集时间UTC),备注:[!row.时间北京时间?'发布时间待核验':'',row.回复关系状态==='parent_unverified'?'回复关系未核实':''].filter(Boolean).join('；')};
      if(kind==='media')return {媒体编号:row.媒体主键,类型:({photo:'图片',video:'视频',clip:'短视频'})[row.类型]||'未确认',媒体链接:row.链接,
        标题:row.标题或链接文字,视频播放数:row.视频播放数??'','采集时间（北京时间）':localTime(row.采集时间UTC),备注:row.类型==='photo'?'':'播放数未取得'};
      if(kind==='relations')return {帖子链接:link(row.帖子主键),媒体链接:'https://vk.ru/'+row.媒体主键,附件顺序:row.观察次序};
      if(kind==='tooltip')return {帖子链接:link(row.帖子主键),页面时间提示:row.提示原文,'采集时间（北京时间）':localTime(row.采集时间UTC),备注:'页面公开提示'};
      if(kind==='rejected')return {帖子链接:link(row.资源),说明:'未确认该内容属于目标账号，未纳入研究表'};
      return {账号:'China.org.cn(Russian)',研究开始日期:row.研究起日,研究结束日期:row.研究止日,发现帖子数:row.独立样本数,
        研究期内帖子数:row.期间内数,研究期外帖子数:row.期间外数,日期待核验帖子数:row.日期待核验数,已处理帖子数:row.已处理数,
        部分取得帖子数:row.部分处理数,正文缺失帖子数:row.正文缺失数,点赞缺失帖子数:row.点赞缺失数,评论回复数:row.评论明细条数,
        恢复次数:row.恢复次数,'最近保存时间（北京时间）':localTime(row.断点时间UTC),
        运行状态:({trial_finished:'试采结束',paused:'已暂停',stopped:'已停止',not_automatic:'页面样本'})[row.试采阶段]||'采集中或已中断，请核对进度',
        停止说明:reasons[row.停止原因]||'已保存当前结果，具体原因见原始记录',
        覆盖说明:'仅包含实际发现并保存的内容；未证明全年完整，独立视频和短视频未覆盖'};
    });
  }
  return {schemas,build,count,metric,publication,bjt,readableSchemas,readable,EXPORT_VERSION};
})();
