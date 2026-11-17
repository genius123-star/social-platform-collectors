"use strict";
const C=VKProbeCore,$=id=>document.getElementById(id);
async function command(type,extra={}) {
  const response=await chrome.runtime.sendMessage({type,...extra});
  if(!response?.ok)throw new Error(response?.error||"扩展后台没有响应，请重新打开小窗核对批次。");
  return response.value;
}
async function refresh(selected) {
  const runs=await command("vk_probe_list");
  const previous=selected||$("runs").value;
  $("runs").replaceChildren();
  for(const run of runs) {
    const o=document.createElement("option");o.value=run.run_id;
    o.textContent=`${run.collected_at} · ${run.auto_phase?run.processed+'/'+run.count+'已处理':run.count+'候选'} · ${run.auto_phase||run.status}`;
    $("runs").append(o);
  }
  if(runs.some(r=>r.run_id===previous))$("runs").value=previous;
  for(const key of ['raw','report','posts','account','research','outside','pending','comments','media','relations','tooltip'])$(key).disabled=!runs.length;
  $("resume").disabled=!runs.some(r=>r.run_id===$("runs").value&&r.auto_phase);
  $("stop").disabled=!runs.some(r=>r.run_id===$("runs").value&&r.auto_phase&&!['trial_finished','paused','stopped'].includes(r.auto_phase));
  if(!runs.length){const o=document.createElement("option");o.textContent="暂无批次";o.value="";$("runs").append(o);}
}
function download(name,text,type) {
  const url=URL.createObjectURL(new Blob([text],{type}));
  const a=document.createElement("a");a.href=url;a.download=name;document.body.append(a);a.click();a.remove();
  // No popup-lifetime timer is needed; its object URLs are released with the popup document.
}
$("capture").onclick=async()=>{
  $("capture").disabled=true;$("status").textContent="正在读取并保存当前公开结构……";
  try {
    const result=await command("vk_probe_capture");await refresh(result.run_id);
    $("status").textContent=`已保存${result.count}个候选结构，分离正文${result.body_count||0}条。\n批次：${result.run_id}\n${result.count?"正文是否完整、精确时间和缺失指标仍待核验。":"没有找到候选；请确认已经登录且主页帖子已显示。"}\n请选择导出结构诊断JSON。`;
  }catch(e){$("status").textContent=e.message;}finally{$("capture").disabled=false;}
};
$("auto").onclick=async()=>{
  for(const id of ['auto','capture','hover'])$(id).disabled=true;
  try{const r=await command('vk_probe_auto_start');await refresh(r.run_id);
    $("status").textContent='自动试采已启动。请关闭小窗，保持VK标签页可见并等待约20秒，再打开小窗刷新进度；不要手动移动页面。';
  }catch(e){$("status").textContent=e.message;await refresh().catch(()=>{});}
  finally{for(const id of ['auto','capture','hover'])$(id).disabled=false;}
};
$("history").onclick=async()=>{
  $("history").disabled=true;
  try{const r=await command('vk_probe_history_start',{from_current:$("current").checked});await refresh(r.run_id);
    $("status").textContent='连续采集已启动。关闭小窗并保持VK页可见；任务会按资源ID去重、保存期间外证据并继续寻找研究期帖子。暂停后可继续本批次。';
  }catch(e){$("status").textContent=e.message;}finally{$("history").disabled=false;}
};
$("resume").onclick=async()=>{
  $("resume").disabled=true;
  try{await command('vk_probe_auto_resume',{run_id:$("runs").value,from_current:$("current").checked});await progress();}
  catch(e){$("status").textContent=e.message;}finally{$("resume").disabled=false;}
};
async function progress(){
  await refresh();const id=$("runs").value;if(!id)return;
  const s=await command('vk_probe_get',{run_id:id}),a=s.auto_run;
  if(!a){$("status").textContent=`当前为结构诊断批次，时间提示${s.hover_observations?.length||0}条。`;return;}
  const phases={created:'已建立',post_started:'核验帖子',before_body_expand:'准备展开正文',body_expanded:'正文已展开',
    body_expand_partial:'正文部分取得',before_time_hover:'读取时间提示',post_processed:'本帖已处理',trial_finished:'试采结束',
    discovered:'发现新帖',before_history_scroll:'继续加载历史',history_scrolled:'历史已加载',comments_saved:'评论已保存',before_comment_expand:'展开评论',
    paused:'已暂停，成果已保存',stopped:'已停止',stop_requested:'正在停止'};
  const reasons={user_stopped:'用户暂停，可继续原批次',three_post_trial_budget_completed:'3帖试采预算正常结束',
    loaded_trial_queue_exhausted:'已加载队列处理完毕',session_200_posts_budget_partial_resume_available:'本次200帖预算已用完，可继续',
    trial_time_budget_exhausted:'本次时间预算已用完，可继续',time_budget_exhausted:'本次时间预算已用完，可继续',
    page_hidden_trial_paused:'VK标签页已隐藏，回到该页后可继续',unexpected_dialog_trial_paused:'出现未核验弹窗，处理后可继续',
    no_new_verified_posts_after_six_scrolls_partial:'页面连续6轮没有增长，已保留部分成果',scroll_budget_partial:'滚动预算已用完，已保留部分成果'};
  const report=VKProbeSamples.build(s).report[0];
  $("status").textContent=`${phases[a.phase]||a.phase}：已处理${a.processed_keys.length}/${a.keys.length}帖，时间提示${s.hover_observations?.length||0}条。\n期间内${report.期间内数}，期间外${report.期间外数}，日期待核验${report.日期待核验数}；评论回复${report.评论明细条数}条。\n当前帖子：${a.current_key||'无'}\n断点：${a.heartbeat_at||s.collected_at}\n${a.stop_reason?'结束原因：'+(reasons[a.stop_reason]||a.stop_reason):'可导出当前已保存成果。'}`;
}
$("progress").onclick=()=>progress().catch(e=>{$("status").textContent=e.message;});
$("runs").onchange=()=>progress().catch(e=>{$("status").textContent=e.message;});
$("stop").onclick=async()=>{try{await command('vk_probe_auto_stop',{run_id:$("runs").value});await progress();}catch(e){$("status").textContent=e.message;}};
$("hover").onclick=async()=>{
  $("hover").disabled=true;$("capture").disabled=true;
  try{
    const r=await command('vk_probe_arm_hover');await refresh(r.run_id);
    $("status").textContent='已开启时间提示记录。\n关闭小窗 → 在已加载帖子的时间上停留约2秒 → 移开鼠标并等约1秒 → 回来导出本批JSON。\n请直接导出，不再点“读取当前页”，以免新建另一个批次。';
  }catch(e){$("status").textContent=e.message;}
  finally{$("hover").disabled=false;$("capture").disabled=false;}
};
async function exportRun(kind) {
  try {
    const selected=$("runs").value;
    if(!selected)throw new Error("请先读取结构或选择已保存批次。");
    const snapshot=await command("vk_probe_get",{run_id:selected});
    if(kind==="raw")download(`VK_结构诊断_${selected}.json`,JSON.stringify(snapshot,null,2),"application/json;charset=utf-8");
    else {const samples=VKProbeSamples.build(snapshot),ranges={research:'in_range',outside:'out_of_range',pending:'date_pending'};
      const rows=ranges[kind]?samples.posts.filter(p=>p.期间分类===ranges[kind]&&(kind!=='research'||p.归属状态==='header_author_and_wall_verified')):samples[kind];
      const name={report:'采集摘要',posts:'全部帖子_可读版',account:'账号',research:'期间内帖子',outside:'期间外帖子',pending:'日期待核验帖子',comments:'评论回复',media:'媒体',relations:'附件关系',tooltip:'时间提示'}[kind];
      const table=ranges[kind]?'posts':kind;
      download(`VK_${name}_${selected}.csv`,C.csv(VKProbeSamples.readable(table,rows),VKProbeSamples.readableSchemas[table]),"text/csv;charset=utf-8");}
    $("status").textContent=`已请求下载所选批次：${selected}。\n本批时间提示记录：${snapshot.hover_observations?.length||0}条。请核对浏览器下载是否完成。`;
  }catch(e){$("status").textContent=e.message;}
}
$("raw").onclick=()=>exportRun("raw");$("report").onclick=()=>exportRun("report");
$("posts").onclick=()=>exportRun("posts");$("account").onclick=()=>exportRun("account");
for(const kind of ['research','outside','pending','comments','media','relations','tooltip'])$(kind).onclick=()=>exportRun(kind);
refresh().catch(e=>{$("status").textContent=e.message;});
