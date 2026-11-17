if(!globalThis.MediaPageUI||MediaPageUI.version!==MediaCore.VERSION)globalThis.MediaPageUI=(()=>{
  const version=MediaCore.VERSION,token=crypto.randomUUID();let hidden=false,container,last;
  const send=type=>chrome.runtime.sendMessage({type,run_id:last.run_id}).catch(()=>{});
  function render(state) {
    last=state;
    if(!container?.isConnected) {
      document.getElementById('media-research-panel')?.remove();
      container=document.createElement('section');container.id='media-research-panel';
      Object.assign(container.style,{position:'fixed',right:'12px',bottom:'12px',zIndex:'2147483646',background:'#fff',color:'#18212b',border:'1px solid #b9c2cb',borderRadius:'8px',padding:'10px',font:'13px/1.5 sans-serif',width:'290px',maxHeight:'40vh',overflow:'auto',boxShadow:'0 2px 12px #0003'});
      document.documentElement.append(container);
    }
    container.replaceChildren();
    const title=document.createElement('strong');title.textContent=`${state.platform==='x'?'X':'TikTok'} @${state.username}`;container.append(title);
    const toggle=document.createElement('button');toggle.textContent=hidden?'展开':'隐藏';toggle.style.marginLeft='12px';toggle.onclick=()=>{hidden=!hidden;render(last);};container.append(toggle);
    if(hidden)return;
    const text=document.createElement('div'),c=state.counts,p=state.checkpoint;
    text.style.whiteSpace='pre-wrap';text.textContent=`批次 ${state.run_id.slice(0,8)} · ${MediaCore.label(state.status)}\n阶段：${MediaCore.label(state.stage)}；${MediaCore.label(state.reason)}\n发现 ${c.discovered}｜详情成功 ${c.details}｜部分 ${c.partial}｜待处理 ${c.pending}\n日期段 ${Math.min(state.segment+1,state.segments)}/${state.segments}\n断点：${p?.time||'日期待核验'}\n${p?.text||''}`;container.append(text);
    if(p?.url){const a=document.createElement('a');a.href=p.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent='查看断点内容';container.append(a);}
    for(const [label,type]of [['暂停','pause'],['停止','stop'],['导出／批次管理','open_export']]){const button=document.createElement('button');button.textContent=label;button.style.margin='5px 3px 0 0';button.onclick=()=>send(type);container.append(button);}
  }
  return {version,token,render};
})();
