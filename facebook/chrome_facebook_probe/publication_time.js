"use strict";
  // Parse civil time explicitly: never let Date.parse apply the computer's zone.
globalThis.localPandaPublicationTime=function(row,settings) {
    const decode=(value,fallback)=>{try{return JSON.parse(value||'')||fallback;}catch{return fallback;}};
    const key=value=>{try{const u=new URL(value);if(!['facebook.com','www.facebook.com'].includes(u.hostname)||u.searchParams.has('comment_id')||u.searchParams.has('reply_comment_id'))return '';const m=u.pathname.match(/\/(reel|videos|posts|permalink)\/([^/]+)/);return m?m[1]+':'+m[2]:u.searchParams.get('fbid')?'photo:'+u.searchParams.get('fbid'):u.searchParams.get('story_fbid')?'posts:'+u.searchParams.get('story_fbid'):'';}catch{return '';}};
    const identity=key(row.post_url),facts=[],explicit=new Set();
    const parse=value=>{
      const raw=String(value??'').trim();
      const m=raw.match(/^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(?:(?:星期|周)[一二三四五六日天]\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(北京时间|(?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?)?$/)||raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
      if(!m)return null;
      const [year,month,day,hour,minute,second]=m.slice(1,7).map(v=>Number(v||0));
      const fraction=raw.match(/[T ]\d{2}:\d{2}:\d{2}\.(\d+)/);
      const civil=Date.UTC(year,month-1,day,hour,minute,second,fraction?Number((fraction[1]+'000').slice(0,3)):0),date=new Date(civil);
      if(year<1900||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||hour>23||minute>59||second>59)return null;
      let offset=480,zone=m[7]||'',assumed=!zone;
      if(zone&&zone!=='北京时间'&&zone!=='Z') {
        const z=zone.replace(/^(UTC|GMT)\s*/,'').match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
        if(!z||Number(z[2])>23||Number(z[3]||0)>59)return null;
        offset=(Number(z[2])*60+Number(z[3]||0))*(z[1]==='+'?1:-1);
      } else if(zone==='Z')offset=0;
      return {raw,civil,utc_ms:civil-offset*60000,assumed,precision:m[6]?'second':'minute'};
    };
    const observe=(value,source)=>{const fact=parse(value);if(fact){facts.push({...fact,source});if(!fact.assumed)explicit.add(fact.utc_ms);}};
    const detail=decode(row.raw_detail_evidence_json,{});
    const times=[...decode(row.raw_post_only_time_elements_json,[]),...(detail.times||[]),...(detail.structured_times||[])];
    for(const link of [...decode(row.raw_links_json,[]),...(detail.links||[])])if(identity&&key(link.url)===identity)
      for(const field of ['text','title','aria_label'])observe(link[field],'own_date_link.'+field);
    for(const evidence of decode(row.publication_time_hover_evidence_json,[])) {
      if(!identity||key(evidence.post_url)!==identity)continue;
      times.push(...(evidence.time_elements||[]),...(evidence.structured_times||[]));if(evidence.date_attributes)times.push(evidence.date_attributes);
      for(const field of ['text','title','aria_label'])observe(evidence[field],'own_hover_anchor.'+field);
      for(const value of evidence.associated_tooltips||[])observe(value,'aria_describedby');
      const lifecycle=evidence.tooltip_lifecycle||{},first=lifecycle.first_full_dates||[];
      const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
      const confirmed=lifecycle.status==='repeat_hover_lifecycle_confirmed'&&key(lifecycle.post_url)===identity&&same(lifecycle.baseline_full_dates,[])&&first.length===1&&same(lifecycle.repeated_full_dates,first)&&same(lifecycle.after_leave_full_dates,[])&&same(lifecycle.after_repeat_leave_full_dates,[])&&lifecycle.stable_interval_ms>=750&&['after_leave_stable','repeat_stable','after_repeat_leave_stable'].every(k=>lifecycle[k]===true);
      if(confirmed)for(const tip of evidence.new_tooltips||[])if(tip.text===first[0])observe(tip.text,'repeat_hover_lifecycle');
    }
    if(identity)for(const time of times) {
      if(time.unix_time!==null&&time.unix_time!==undefined&&String(time.unix_time).trim()!==''&&/^\d+(?:\.\d+)?$/.test(String(time.unix_time)))explicit.add(Number(time.unix_time)*1000);
      const fact=parse(time.datetime);if(fact&&!fact.assumed)explicit.add(fact.utc_ms);
    }
    const civilDates=new Set(facts.map(f=>f.civil));let stamp=null,status='date_pending';
    if(explicit.size===1){stamp=[...explicit][0];status='explicit_resource_time';}
    else if(!explicit.size&&civilDates.size===1&&settings.display_timezone_policy==='user_assumed_Asia_Shanghai') {stamp=facts[0].utc_ms;status='full_display_date_user_assumed_BJT_not_platform_verified';}
    const start=Date.parse(settings.start_date_bjt+'T00:00:00+08:00'),end=Date.parse(settings.end_date_bjt+'T00:00:00+08:00')+86400000;
    const valid=stamp!==null&&Number.isFinite(stamp)&&Number.isFinite(start)&&Number.isFinite(end);
    return {status,raw_candidates:facts,start_utc:new Date(start).toISOString(),end_exclusive_utc:new Date(end).toISOString(),
      publication_time_utc:valid?new Date(stamp).toISOString():'',publication_time_bjt:valid?new Date(stamp+28800000).toISOString().replace('Z','+08:00'):'',
      range:valid?(stamp<start?'before_start':stamp>=end?'after_end':'in_range'):'date_pending',timestamp_ms:valid?stamp:null};
  };
