(()=>{
  const $=id=>document.getElementById(id),C=MediaCore,P=MEDIA_CONFIG.platform;
  $('title').textContent=`${P==='x'?'X':'TikTok'} 通用账号采集 v${C.VERSION}`;
  $('show-detail').textContent='显示采集标签页';
  if(P==='x')$('mode').querySelector('[value="here"]').remove();
  else $('x-segment-controls').hidden=true;
  const send=async message=>{const result=await chrome.runtime.sendMessage(message);if(!result?.ok)throw Error(result?.error||'后台无响应，请保留数据后检查扩展');return result.value;};
  const activeTab=async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab)throw Error('请先打开目标账号页');return tab;};
  const config=()=>({start:$('start').value,end:$('end').value,mode:$('mode').value,hours:Number($('hours').value),entity:$('entity').value.trim()});
  async function list(selected) {
    const entries=await send({type:'list'}),id=selected||$('runs').value;
    $('runs').replaceChildren(new Option('请选择批次',''));
    for(const r of entries.slice().reverse())$('runs').add(new Option(`@${r.username} · ${r.run_id.slice(0,8)} · ${C.label(r.status)}`,r.run_id));
    if(entries.some(r=>r.run_id===id))$('runs').value=id;
  }
  async function status() {
    const id=$('runs').value;if(!id)return;
    const s=await send({type:'get',run_id:id}),c=s.counts,p=s.checkpoint;
    $('status').textContent=`账号 @${s.username}\n批次 ${s.run_id}\n状态 ${C.label(s.status)}；原因 ${C.label(s.reason)}\n阶段 ${C.label(s.stage)} · 日期段 ${Math.min(s.segment+1,s.segments)}/${s.segments}\n唯一发现 ${c.discovered}；详情成功 ${c.details}；部分信息 ${c.partial}；失败 ${c.failed}；待处理 ${c.pending}\n研究期内 ${c.in_range}；日期待核验 ${c.date_pending}\n断点 ${p?.time||'尚无准确时间'}\n${p?.text||''}\n最近保存 ${C.bjt(s.updated_at)}`;
    $('checkpoint').textContent=p?.url?'打开断点内容':'';if(p?.url)$('checkpoint').href=p.url;else $('checkpoint').removeAttribute('href');
    if(P==='x') {const previous=$('segment-choice').value;$('segment-choice').replaceChildren();for(const segment of s.segments_info||[])$('segment-choice').add(new Option(`${segment.since}至${segment.until}（UTC，右侧日期不含）· ${C.label(segment.status)}`,segment.key));
      if((s.segments_info||[]).some(v=>v.key===previous))$('segment-choice').value=previous;}
    $('status').textContent+=`\n最近成功进展 ${s.last_progress_at?C.bjt(s.last_progress_at):'尚无详情成功进展'}`;
  }
  async function download(name,text,mime) {
    const url=URL.createObjectURL(new Blob([text],{type:mime}));
    try{await chrome.downloads.download({url,filename:name,saveAs:true});}finally{setTimeout(()=>URL.revokeObjectURL(url),60000);}
  }
  const actions={
    'start-run':async()=>{const tab=await activeTab(),r=await send({type:'start',tab_id:tab.id,reference:$('target').value||tab.url,config:config()});await list(r.run_id);await status();},
    refresh:async()=>{await list();await status();},
    diagnose:async()=>{const tab=await activeTab();$('error').textContent=JSON.stringify(await send({type:'diagnose',tab_id:tab.id,reference:$('target').value||tab.url}),null,2);$('error').scrollIntoView({block:'nearest'});},
    'diagnostic-file':async()=>{const tab=await activeTab(),data=await send({type:'diagnose',tab_id:tab.id,reference:$('target').value||tab.url});await download(`${P}_${data.target.username}_诊断_${Date.now()}.json`,JSON.stringify(data,null,2),'application/json');},
    csv:async()=>{const run=await send({type:'get',run_id:$('runs').value,full:true}),data=C.exportRows(run);await download(`${P}_${run.target.username}_${run.run_id.slice(0,8)}_数据.csv`,C.csv(data.fields,data.rows),'text/csv;charset=utf-8');},
    report:async()=>{const run=await send({type:'get',run_id:$('runs').value,full:true}),report=C.report(run);const text=`账号：@${report.account}\n研究期：${report.window}\n状态：${C.label(report.status)}\n停止原因：${C.label(report.reason)}\n发现${report.counts.discovered}；详情成功${report.counts.details}；部分${report.counts.partial}；失败${report.counts.failed}；待处理${report.counts.pending}\n完整性：尚未核验\n${report.coverage_note}\n\n详细运行记录：\n${report.segments.map((s,i)=>`${i+1}. ${s.since||'主页'} 至 ${s.until||'历史列表'}：${C.label(s.status)}，发现${s.discovered}条`).join('\n')}\n\n字段缺失统计：\n${Object.entries(report.missing_metrics).map(([k,v])=>`${({likes:'点赞',comments:'评论',shares:'转发',quotes:'引用',bookmarks:'收藏',views:'帖子浏览',plays:'视频播放'})[k]||k}：${v}条`).join('\n')}\n详细技术证据请另行导出原始记录与断点备份。`;await download(`${P}_${run.target.username}_${run.run_id.slice(0,8)}_运行报告.txt`,text,'text/plain;charset=utf-8');},
    backup:async()=>{const run=await send({type:'get',run_id:$('runs').value,full:true});await download(`${P}_${run.target.username}_${run.run_id.slice(0,8)}_原始记录与断点.json`,JSON.stringify(run,null,2),'application/json');},
    legacy:async()=>{const data=await send({type:'legacy'});await download(`${P}_旧版存储备份.json`,JSON.stringify(data,null,2),'application/json');},
    import:async()=>{
      const account=C.target(P,$('target').value),groups=[];
      for(const file of $('files').files) {
        const raw=await file.text(),data=file.name.toLowerCase().endsWith('.csv')?C.parseCSV(raw):JSON.parse(raw.replace(/^\uFEFF/,''));
        if(data.schema==='media_seed_v1') {
          if(data.platform!==P||data.username?.toLowerCase()!==account.key)throw Error('种子文件平台或账号不符');
          if(!$('entity').value.trim()&&data.entity)$('entity').value=data.entity;
        }
        if(data.schema===C.SCHEMA) {
          if(![C.VERSION,'0.6.0','0.6.1','0.6.2','0.6.3','0.6.4'].includes(data.version)||data.platform!==P||data.target?.key!==account.key)throw Error('备份版本、平台或账号不符；旧文件保留，请先明确迁移');
          groups.push({platform:P,rows:data.observations?.length?data.observations:Object.values(data.rows||{}),profiles:data.profiles||[],links:data.queue||[]});
        } else if(data.schema==='legacy_media_storage_v1') {
          const values=Object.values(data.entries||{}).flatMap(v=>Array.isArray(v)?v:[v]).filter(v=>v.username?.toLowerCase()===account.key&&
            (v.schema==='public_history_discovery_v1'?v.platform===P:P==='tiktok'&&v.schema==='tiktok_page_probe_v1'));
          if(!values.length)throw Error('旧版备份中没有当前平台和账号的数据');
          groups.push(MediaReader.importData(values,account));
        } else if(Array.isArray(data)&&data[0]?.payload){for(const row of data)groups.push(MediaReader.importData(JSON.parse(row.payload),account));}
        else if(Array.isArray(data)&&data[0]?.content_url){groups.push({links:data.map(r=>({...C.post(P,r.content_url,account.username),author:account.username,created_at:r.created_at_utc||''}))});}
        else groups.push(MediaReader.importData(data,account));
      }
      if(!groups.length)throw Error('请先选择原始记录或链接文件');
      const result=await send({type:'import',reference:account.url,config:config(),groups});await list(result.run_id);await status();
    }
  };
  for(const type of ['resume','retry','skip','pause','stop','show_detail','retry_segment'])actions[type.replace('_','-')]=async()=>{const tab=await activeTab();const r=await send({type,run_id:$('runs').value,tab_id:tab.id,entity:$('entity').value.trim(),content_id:$('retry-id').value.trim(),segment_key:$('segment-choice').value});await list(r.run_id);await status();};
  for(const [id,action]of Object.entries(actions))$(id).addEventListener('click',async()=>{try{$('error').textContent='';await action();}catch(error){$('error').textContent=error.message;$('error').scrollIntoView({block:'nearest'});}});
  $('runs').addEventListener('change',()=>status().catch(e=>$('error').textContent=e.message));
  (async()=>{const selected=new URL(location.href).searchParams.get('run');await list(selected);try{const tab=await activeTab();$('target').value=C.pageTarget(P,tab.url).url;}catch{}await status();})().catch(e=>$('error').textContent=e.message);
  setInterval(()=>status().catch(()=>{}),3000);
})();
