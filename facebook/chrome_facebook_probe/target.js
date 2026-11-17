"use strict";
globalThis.localPandaTarget=(()=>{
  const reserved=new Set('home feed watch reel reels videos posts photos photo.php story.php permalink.php groups events marketplace gaming notifications messages friends search settings help login logout checkpoint challenge two_step_verification share sharer.php pages people policies privacy business ads'.split(' '));
  function parse(raw){
    try{
      const u=new URL(raw);
      if(u.protocol!=='https:'||!['www.facebook.com','facebook.com'].includes(u.hostname)||u.port||u.username||u.password)return null;
      let slug,key,url;
      if(u.pathname==='/profile.php'){
        const id=u.searchParams.get('id');if(!/^\d+$/.test(id||''))return null;
        slug=id;key='id:'+id;url='https://www.facebook.com/profile.php?id='+id;
      }else{
        const parts=u.pathname.split('/').filter(Boolean);
        if(parts.length!==1||! /^[A-Za-z0-9.]+$/.test(parts[0])||reserved.has(parts[0].toLowerCase()))return null;
        slug=parts[0];key=slug.toLowerCase();url='https://www.facebook.com/'+slug+'/';
      }
      const known={localpanda02:'cd_fb_en',localpanda03:'cd_fb_fr',localpanda04:'cd_fb_es',localpanda01:'cd_fb_pt'};
      return {profile_url:url,account_key:known[key]||'fb_'+key.replace(':','_'),name:slug,identity:key};
    }catch{return null;}
  }
  const same=(raw,target)=>{const a=parse(raw),b=parse(target?.profile_url||target);return !!a&&!!b&&a.identity===b.identity;};
  const isStoryLink=raw=>{try{const u=new URL(raw);return ['www.facebook.com','facebook.com'].includes(u.hostname)&&/^\/stories(?:\/|$)/i.test(u.pathname);}catch{return false;}};
  function fromState(state){
    const rows=Object.values(state?.rows||{});
    const urls=[state?.target?.profile_url,...rows.map(r=>r.profile_url)].filter(Boolean);
    const target=urls.length?parse(urls[0]):null;
    if(!target||!urls.every(url=>same(url,target)))throw new Error('saved_target_missing_or_mixed');
    if(state.target?.account_key&&state.target.account_key!==target.account_key)throw new Error('saved_account_key_mismatch');
    if(rows.some(row=>row.account_key&&row.account_key!==target.account_key))throw new Error('saved_rows_account_mismatch');
    return {...target,name:state.target?.name||target.name};
  }
  async function migrateLegacyFrench(){
    const all=await chrome.storage.local.get(null),updates={};
    for(const [key,value]of Object.entries(all)){
      if(key==='lp_fb_fr_run_'+value?.run_id&&!all['lp_fb_run_'+value.run_id]){
        const target=fromState(value);
        updates['lp_fb_run_'+value.run_id]={...value,target,status:['running','paused','recovering'].includes(value.status)?'interrupted':value.status,
          heartbeat:0,owner:'',migration_note:'法语专用扩展批次已迁移，请手动恢复；原记录保留'};
      }
      if(key==='lp_fb_fr_supervisor_'+value?.tab_id&&value.enabled)updates[key]={...value,enabled:false,phase:'unified_upgrade_requires_manual_resume'};
    }
    if(Object.keys(updates).length)await chrome.storage.local.set(updates);
  }
  return {parse,same,isStoryLink,fromState,migrateLegacyFrench};
})();
