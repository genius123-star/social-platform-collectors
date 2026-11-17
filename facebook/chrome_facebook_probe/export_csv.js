"use strict";
globalThis.localPandaRawExport = state => {
  const target=localPandaTarget.fromState(state);
  const observations=state.observations||[];
  const versions=[...new Set([...observations,...Object.values(state.rows)].map(row=>row.version).filter(Boolean))];
  const collectionVersion=versions.length===1?versions[0]:versions.length>1?'mixed':state.collector_version||'';
  const metadata={record_type:'run_metadata',account_key:target.account_key,profile_url:target.profile_url,
    run_id:state.run_id,version:collectionVersion,exporter_version:'0.6.9',collection_versions_json:JSON.stringify(versions),exported_at_utc:new Date().toISOString(),raw_profile_evidence_json:Object.keys(state.profile||{}).length?JSON.stringify(state.profile):'',
    run_state_json:JSON.stringify({...state,rows:undefined,profile:undefined,observations:undefined}),source:'Chrome_extension_public_DOM'};
  const rows=[metadata,...observations.map(r=>({...r,record_type:'post_observation',observation_role:'previous_attempt',run_id:state.run_id})),
    ...Object.values(state.rows).map(r=>({...r,record_type:'post',observation_role:'selected_observation',run_id:state.run_id}))];
  const fields=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  const cell=v=>'"'+String(v??'').replaceAll('"','""')+'"';
  const csv='\uFEFF'+[fields,...rows.map(r=>fields.map(k=>r[k]))].map(r=>r.map(cell).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');
  a.href=url;a.download=('facebook_'+target.account_key+'_raw_'+(state.config?.collection_scope==='formal'?'full_':'probe_'))+new Date().toISOString().replace(/[:.]/g,'-')+'.csv';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
};

globalThis.localPandaExport=state=>localPandaReadable.download(state,'posts');
