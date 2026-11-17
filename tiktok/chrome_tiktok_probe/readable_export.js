// Same research-facing fields as readable_export.py; no raw payload in CSV.
function readableTikTokRows(snapshots, type) {
  const posts=['平台','账号','账号名称','发布时间（北京时间）','帖子链接','正文','标签','内容类型','点赞数','评论数','转发数','引用数','收藏数','帖子浏览数','视频播放量','采集时间（北京时间）'];
  const profiles=['平台','账号','账号名称','账号链接','简介','是否认证','认证类型','粉丝数','采集时间（北京时间）'];
  const followers=['平台','账号','粉丝数','采集时间（北京时间）'];
  const bjt=raw=>{const d=new Date(raw);return Number.isFinite(+d)?new Date(+d+8*3600000).toISOString().slice(0,19).replace('T',' '):'';};
  const data=snapshots.filter(s=>s.status==='observed').sort((a,b)=>a.collected_at_utc.localeCompare(b.collected_at_utc));
  const name=data.at(-1)?.username || snapshots.at(-1)?.username || '';
  const common=s=>({'平台':'TikTok','账号':'@'+s.username,'采集时间（北京时间）':bjt(s.collected_at_utc)});
  if(type==='profile'||type==='followers') {
    const rows=data.filter(s=>s.profile?.user || s.profile?.visible?.username).map(s=>{
      const p=s.profile,u=p.user||{},v=p.visible||{};
      return {...common(s),'账号名称':u.nickname??v.display_name??'','账号链接':'https://www.tiktok.com/@'+s.username,
        '简介':u.signature??v.bio_raw??'','是否认证':u.verified===true?'是':u.verified===false?'否':'','认证类型':'',
        '粉丝数':p.stats?.followerCount??v.follower_count_raw??''};
    });
    return {fields:type==='profile'?profiles:followers,rows:type==='profile'?rows.slice(-1):rows,username:name};
  }
  const unique=new Map();
  for(const s of data) {
    // Prefer the current schema, as in the Python importer.
    const candidates=[...(s.items||[])].sort((a,b)=>(a.script!=='__UNIVERSAL_DATA_FOR_REHYDRATION__')-(b.script!=='__UNIVERSAL_DATA_FOR_REHYDRATION__'));
    const c=candidates.find(c=>String(c.item?.id)===s.content_id && c.item?.author?.uniqueId?.toLowerCase()===s.username.toLowerCase());
    if(!c)continue;
    const i=c.item,m=i.statsV2&&Object.keys(i.statsV2).length?i.statsV2:i.stats||{};
    const time=bjt(Number(i.createTime)*1000), day=time.slice(0,10);
    if((type==='posts'&&(!time||day<'2025-10-17'||day>'2026-10-17')) || (type==='outside'&&(!time||(day>='2025-10-17'&&day<='2026-10-17'))))continue;
    unique.set(s.content_id,{...common(s),'账号名称':i.author?.nickname??s.profile?.user?.nickname??'',
      '发布时间（北京时间）':time,'帖子链接':s.page_url,'正文':i.desc??'',
      '标签':Array.isArray(i.textExtra)?[...new Set(i.textExtra.filter(t=>t.hashtagName).map(t=>'#'+t.hashtagName))].join(' '):'',
      '内容类型':s.page_url.includes('/photo/')?'图片':'视频','点赞数':m.diggCount??'','评论数':m.commentCount??'',
      '转发数':m.shareCount??'','引用数':'','收藏数':m.collectCount??'','帖子浏览数':'','视频播放量':m.playCount??''});
  }
  return {fields:posts,rows:[...unique.values()].sort((a,b)=>a['发布时间（北京时间）'].localeCompare(b['发布时间（北京时间）'])),username:name};
}
if(typeof module!=='undefined')module.exports={readableTikTokRows};
