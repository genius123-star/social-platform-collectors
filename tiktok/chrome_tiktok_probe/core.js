/* Shared source for two separately installed extensions. No network or page-code evaluation. */
globalThis.MediaCore = (() => {
  'use strict';
  const VERSION='0.6.5', SCHEMA='media_run_v1';
  const labels={running:'采集中',paused:'已暂停',stopped:'已停止',profile:'读取账号资料',wait_profile:'等待账号资料',discover:'发现内容',select:'处理待采队列',wait_detail:'读取详情',created:'批次已建立',started:'采集已启动',resumed:'已从断点恢复',imported_backup:'已导入为独立批次',user_pause:'用户暂停',user_stop:'用户停止',sample_budget_reached:'试采预算已用完',session_time_budget_reached:'本轮运行时限已到，可从断点继续',consecutive_detail_failures:'连续详情读取失败，已暂停保护数据',list_stalled_history_end_unverified:'列表暂时没有新增，历史完整性尚未核验',all_segments_attempted_coverage_unverified:'日期段已尝试，覆盖完整性尚未核验',background_list_not_advancing:'后台页面未追加内容，请显示列表页后继续',list_frozen_or_discarded:'列表页被冻结或丢弃，请恢复页面后继续',visible_cards_all_rejected:'页面有内容但身份核验均未通过，请诊断',list_route_recovery_budget:'目标页面恢复次数已达上限',task_ownership_changed:'标签页或账号由其他批次接管',storage_write_failed:'存储失败，已停止推进；请立即导出可用备份',browser_restart_requires_manual_resume:'浏览器已重启，请手动恢复批次',extension_reloaded_requires_manual_resume:'扩展已重载，请手动恢复批次',version_changed_export_before_resume:'版本已变化，请先备份并核对迁移',list_tab_closed:'列表标签页已关闭',login_required:'需要正常登录',login_or_verification_required:'需要登录或验证',verification_required:'需要用户处理验证',private_account_stop:'私密账号，已停止读取',access_restricted:'访问受限，已暂停',stalled_unverified:'暂无新增，结束位置未核验',visible_empty_search:'页面明确显示无搜索结果',pending:'待处理',split_parent_unverified:'高密度日期段已拆分'};
  labels.stable_account_id_changed='账号唯一标识发生变化，已暂停以免混入其他账号';
  labels.capture_reader_version_mismatch_refresh_page='采集脚本已更新，请刷新账号主页后恢复原批次';
  labels.capture_bridge_unavailable='页面监听结果未能传回，已暂停；请导出当前页诊断';
  Object.assign(labels,{profile_fields_not_ready:'账号资料未完整加载，请回到账号主页后恢复',x_latest_not_confirmed:'尚未确认Latest最新页签，已暂停避免采集热门结果'});
  Object.assign(labels,{open_detail:'在当前页打开作品',return_list:'返回原列表',return_to_profile_required:'请手动回到目标账号主页或搜索列表后恢复原批次',target_card_not_loaded:'目标作品卡片尚未加载，请回到列表后恢复'});
  const label=value=>labels[value]||'读取异常，请查看诊断记录';
  const hosts=p=>p==='tiktok'?['www.tiktok.com','tiktok.com']:['x.com','www.x.com','twitter.com','www.twitter.com'];
  function target(platform, reference) {
    let name=String(reference||'').trim(), original=name;
    if(name.includes('://')) {
      const u=new URL(name);
      if(u.protocol!=='https:'||!hosts(platform).includes(u.hostname))throw Error('目标网址不属于当前平台');
      if(platform==='x'&&u.pathname==='/search') {
        const authors=[...(u.searchParams.get('q')||'').matchAll(/(?:^|\s)from:([A-Za-z0-9_]{1,15})(?=\s|$)/g)];
        if(authors.length!==1)throw Error('搜索页必须只绑定一个from:账号');
        name=authors[0][1];
      } else name=u.pathname.replace(/^\/@?/,'').replace(/\/$/,'');
    }
    name=name.replace(/^@/,'');
    if(!(platform==='tiktok'?/^[\w.]{1,24}$/:/^\w{1,15}$/).test(name)||
       (platform==='x'&&/^(home|search|explore|settings|messages|notifications|i|login|logout|intent)$/i.test(name)))throw Error('请使用账号主页或用户名');
    return {platform,username:name,key:name.toLowerCase(),original_url:original,
      url:platform==='tiktok'?`https://www.tiktok.com/@${name}`:`https://x.com/${name}`};
  }
  function post(platform, value, account) {
    const u=new URL(value),m=u.pathname.match(platform==='tiktok'?/^\/@([\w.]+)\/(video|photo)\/(\d+)\/?$/:/^\/(\w+)\/status\/(\d+)\/?$/);
    if(u.protocol!=='https:'||!hosts(platform).includes(u.hostname)||!m||m[1].toLowerCase()!==account.toLowerCase())throw Error('作品ID或作者与批次不符');
    const id=platform==='tiktok'?m[3]:m[2];
    return {id,url:platform==='tiktok'?`https://www.tiktok.com/@${account}/${m[2]}/${id}`:`https://x.com/${account}/status/${id}`,type:platform==='tiktok'?m[2]:'post'};
  }
  function pageTarget(platform,value) {
    try{return target(platform,value);}catch{}
    const u=new URL(value),m=u.pathname.match(platform==='tiktok'?/^\/@([\w.]+)\/(?:video|photo)\/\d+\/?$/:/^\/(\w+)\/status\/\d+\/?$/);
    if(!m)throw Error('请打开目标账号主页、日期搜索或作品详情页');post(platform,value,m[1]);return target(platform,m[1]);
  }
  function dateInput(day) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)throw Error('日期无效');
    return Date.parse(day+'T00:00:00+08:00');
  }
  function time(raw) {
    if(raw===null||raw===undefined||raw==='')return '';
    if(typeof raw!=='number'&&typeof raw!=='string')return '';
    if(typeof raw==='string'&&!/([zZ]|[+-]\d{2}:\d{2})$|(?:^|\s)[+-]\d{4}(?:\s|$)|\b(?:GMT|UTC)\b/.test(raw))return '';
    const value=typeof raw==='number'?new Date(raw<1e12?raw*1000:raw):new Date(raw);
    return Number.isFinite(+value)?value.toISOString():'';
  }
  const bjt=raw=>time(raw)?new Date(Date.parse(time(raw))+28800000).toISOString().slice(0,19).replace('T',' '):'';
  function period(raw, config) {
    const value=time(raw);
    return !value?'date_pending':Date.parse(value)<dateInput(config.start)||Date.parse(value)>=dateInput(config.end)+86400000?'out_of_range':'in_range';
  }
  function metric(raw,source='') {
    const text=raw===undefined||raw===null?'':String(raw).trim(),m=text.replace(/[\s,\u00a0\u202f]/g,'').match(/^(\d+(?:\.\d+)?)([KMB万亿]?)$/i);
    if(!m)return {raw:text,value:'',precision:'missing',source};
    const value=Number(m[1])*({'':1,k:1e3,m:1e6,b:1e9,'万':1e4,'亿':1e8}[m[2].toLowerCase()]);
    return {raw:text,value:Number.isSafeInteger(value)?value:'',precision:m[2]?'rounded':'exact',source};
  }
  const shown=m=>m?.precision==='rounded'?m.raw:m?.value??'';
  function segments(account,config) {
    if(account.platform!=='x')return [{url:account.url,status:'pending',seen:[],idle:0,scrolls:0}];
    let at=Date.parse(new Date(dateInput(config.start)).toISOString().slice(0,10)+'T00:00:00Z');
    const stop=Math.ceil((dateInput(config.end)+86400000)/86400000)*86400000,rows=[];
    while(at<stop) {
      const until=Math.min(at+7*86400000,stop),from=new Date(at).toISOString().slice(0,10),to=new Date(until).toISOString().slice(0,10);
      rows.push({url:'https://x.com/search?'+new URLSearchParams({q:`from:${account.username} since:${from} until:${to}`,src:'typed_query',f:'live'}),
        since:from,until:to,status:'pending',seen:[],idle:0,scrolls:0});
      at=until;
    }
    return rows;
  }
  function create(platform,reference,settings={},id) {
    const account=target(platform,reference),config={start:'2025-10-17',end:'2026-10-17',mode:'sample3',hours:6,entity:'',...settings};
    if(dateInput(config.start)>dateInput(config.end)||!['sample3','sample10','formal','here'].includes(config.mode)||!Number.isFinite(+config.hours)||+config.hours<=0||+config.hours>24)throw Error('任务模式、日期或运行时限无效');
    const now=new Date().toISOString();
    return {schema:SCHEMA,version:VERSION,platform,run_id:id||crypto.randomUUID(),target:account,config,created_at:now,updated_at:now,
      status:'paused',reason:'created',stage:'profile',queue:[],rows:{},observations:[],profiles:[],segments:segments(account,config),segment:0,
      current_id:'',last_id:'',detail_attempts:0,consecutive_failures:0,recoveries:0,scrolls:0,logs:[],coverage_complete:false,
      from_here:config.mode==='here',excluded_above:[],runtime_ms:0,session_started_at:now,versions:{engine:VERSION,reader:VERSION,exporter:VERSION}};
  }
  function validate(row,run) {
    const own=post(run.platform,row.url,run.target.username);
    if(own.id!==String(row.id)||String(row.author||'').toLowerCase()!==run.target.key)throw Error('读取对象身份不一致');
    if(run.target.account_id&&row.author_id&&String(run.target.account_id)!==String(row.author_id))throw Error('stable_account_id_changed');
    if(!time(row.collected_at))throw Error('观察时间缺失');
    return {...row,id:own.id,url:own.url,created_at:time(row.created_at),period:period(row.created_at,run.config)};
  }
  const quality=r=>r?(r.created_at?3:0)+(r.text_status==='full'||r.text_status==='empty'?3:0)+Object.values(r.metrics||{}).filter(m=>m.precision!=='missing').length:0;
  function observe(run,value) {
    const row=validate(value,run),old=run.rows[row.id];
    run.observations.push(row);
    if(!old||quality(row)>quality(old)||(quality(row)===quality(old)&&row.collected_at>=old.collected_at))run.rows[row.id]=row;
    return row;
  }
  function addProfile(run,value) {
    if(!value)return;
    if(String(value.username||'').toLowerCase()!==run.target.key)throw Error('账号资料身份不一致');
    if(!time(value.collected_at))throw Error('粉丝快照时间缺失');
    if(run.target.account_id&&value.account_id&&run.target.account_id!==String(value.account_id))throw Error('stable_account_id_changed');
    if(value.account_id)run.target.account_id=String(value.account_id);
    run.profiles.push(value);
  }
  function checkpoint(run) {
    const id=run.current_id||run.last_id||run.queue.at(-1)?.id,row=run.rows[id],q=run.queue.find(v=>v.id===id);
    return id?{id,url:q?.url||row?.url||'',time:bjt(row?.created_at||q?.created_at),text:(row?.text||q?.text||'').slice(0,160),stage:run.stage,retry:q?.status!=='done'}:null;
  }
  function counts(run) {
    const rows=Object.values(run.rows);
    return {discovered:run.queue.length,saved:rows.length,details:run.queue.filter(q=>q.status==='done').length,
      partial:run.queue.filter(q=>q.status==='partial').length,failed:run.queue.filter(q=>q.status==='failed').length,
      pending:run.queue.filter(q=>q.status==='pending'||q.status==='reading').length,
      in_range:rows.filter(r=>r.period==='in_range').length,date_pending:rows.filter(r=>r.period==='date_pending').length};
  }
  function csv(fields,rows) {
    const cell=value=>{
      let text=String(value??'');
      if(/^[\s\u0000-\u001f]*[=+@-]/.test(text))text="'"+text;
      return '"'+text.replaceAll('"','""')+'"';
    };
    return '\uFEFF'+[fields,...rows.map(r=>fields.map(f=>r[f]))].map(row=>row.map(cell).join(',')).join('\r\n');
  }
  function parseCSV(raw) {
    const lines=[],line=[];let value='',quoted=false;
    raw=raw.replace(/^\uFEFF/,'');
    for(let i=0;i<raw.length;i++) {
      const c=raw[i];
      if(c==='"'){if(quoted&&raw[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
      else if(!quoted&&(c===','||c==='\n')){line.push(value);value='';if(c==='\n'){lines.push(line.splice(0));}}
      else if(c!=='\r'||quoted)value+=c;
    }
    if(quoted)throw Error('CSV引号未闭合');
    if(value||line.length){line.push(value);lines.push(line);}
    const fields=lines.shift()||[];
    return lines.filter(r=>r.some(Boolean)).map(r=>Object.fromEntries(fields.map((f,i)=>[f,r[i]??''])));
  }
  function exportRows(run) {
    const profileScore=p=>(p.bio!==null&&p.bio!==undefined?1:0)+(typeof p.verified==='boolean'?1:0)+(p.followers?.precision!=='missing'&&p.followers?2:0);
    const profiles=[...run.profiles].sort((a,b)=>profileScore(a)-profileScore(b)||a.collected_at.localeCompare(b.collected_at)),p=profiles.at(-1)||{};
    const fields=['主体','平台','账号','账号名称','账号链接','账号简介','是否认证','认证类型','粉丝数','粉丝快照时间（北京时间）','内容类型','内容链接',
      '发布时间（北京时间）','正文','正文完整性','标签','点赞数','评论数','转发数','引用数','收藏数','帖子浏览数','视频播放量','互动采集时间（北京时间）','是否在研究期','详情状态'];
    const rows=Object.values(run.rows).filter(r=>r.source!=='list_link'&&['done','partial','failed','skipped'].includes(run.queue.find(q=>q.id===r.id)?.status))
      .sort((a,b)=>(a.created_at||'').localeCompare(b.created_at||'')).map(r=>{
      const m=r.metrics||{},q=run.queue.find(q=>q.id===r.id);
      return {'主体':run.config.entity,'平台':run.platform==='tiktok'?'TikTok':'X','账号':'@'+run.target.username,'账号名称':p.name||r.name||'',
        '账号链接':run.target.url,'账号简介':p.bio??'','是否认证':p.verified===true?'是':p.verified===false?'否':'','认证类型':p.verification_type||'',
        '粉丝数':shown(p.followers),'粉丝快照时间（北京时间）':p.followers?.precision&&p.followers.precision!=='missing'?bjt(p.collected_at):'','内容类型':r.type||'','内容链接':r.url,
        '发布时间（北京时间）':bjt(r.created_at),'正文':r.text??'','正文完整性':{full:'完整',empty:'未填写',truncated:'可能截断',missing:'未取得'}[r.text_status]||'待核验',
        '标签':(r.tags||[]).map(s=>'#'+String(s).replace(/^#/, '')).join(' '),'点赞数':shown(m.likes),'评论数':shown(m.comments),'转发数':shown(m.shares),
        '引用数':shown(m.quotes),'收藏数':shown(m.bookmarks),'帖子浏览数':shown(m.views),'视频播放量':shown(m.plays),
        '互动采集时间（北京时间）':bjt(r.collected_at),'是否在研究期':{in_range:'是',out_of_range:'否',date_pending:'待核验'}[r.period]||'待核验',
        '详情状态':{done:'已读取',partial:'部分信息',failed:'待补采',pending:'待读取',reading:'读取中',skipped:'已跳过'}[q?.status]||'待核验'};
    });
    return {fields,rows};
  }
  function report(run) {
    const c=counts(run),missing={};
    for(const row of Object.values(run.rows))for(const [key,value]of Object.entries(row.metrics||{}))if(value.precision==='missing')missing[key]=(missing[key]||0)+1;
    return {batch:run.run_id,platform:run.platform,account:run.target.username,window:run.config.start+'至'+run.config.end,
      status:run.status,reason:run.reason,counts:c,checkpoint:checkpoint(run),segments:run.segments.map(({seen,...s})=>({...s,discovered:seen.length})),
      missing_metrics:missing,from_current_position:run.from_here,coverage_complete:run.coverage_complete,
      coverage_note:'无新增、预算耗尽或搜索分段已尝试均不代表全部历史完整。',versions:run.versions};
  }
  function splitSegment(segment,account) {
    const a=Date.parse(segment.since+'T00:00:00Z'),b=Date.parse(segment.until+'T00:00:00Z');
    if(!Number.isFinite(a)||b-a<=86400000)return [];
    const mid=a+Math.floor((b-a)/86400000/2)*86400000;
    return [[a,mid],[mid,b]].map(([lo,hi])=>{const since=new Date(lo).toISOString().slice(0,10),until=new Date(hi).toISOString().slice(0,10);
      return {since,until,url:'https://x.com/search?'+new URLSearchParams({q:`from:${account.username} since:${since} until:${until}`,src:'typed_query',f:'live'}),status:'pending',seen:[],idle:0,scrolls:0};});
  }
  return {VERSION,SCHEMA,label,target,pageTarget,post,time,bjt,period,metric,shown,segments,splitSegment,create,validate,observe,addProfile,checkpoint,counts,csv,parseCSV,exportRows,report,quality};
})();
if(typeof module!=='undefined')module.exports=globalThis.MediaCore;
