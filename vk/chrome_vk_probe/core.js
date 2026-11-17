"use strict";
// VK-owned helpers: no Facebook selectors, time assumptions or storage keys.
globalThis.VKProbeCore = (() => {
  const VERSION = "0.5.0";
  const PREFIX = "vk_probe_";
  const MAX_BYTES = 8000000;
  const hosts = new Set(["vk.ru", "www.vk.ru", "vk.com", "www.vk.com"]);
  function target(raw) {
    try {
      const u = new URL(raw);
      if (u.protocol !== "https:" || !hosts.has(u.hostname) || u.username || u.password ||
          !/^\/chinaorgcn\/?$/i.test(u.pathname)) return null;
      // Domains are retained separately until actual identity evidence proves equivalence.
      return {entry_url: u.origin + "/chinaorgcn", host: u.hostname,
        account_key: "chinaorgcn_vk_ru", account_language: "ru", identity_status: "unverified"};
    } catch { return null; }
  }
  function resource(raw, base = "https://vk.ru/chinaorgcn") {
    try {
      const u = new URL(raw, base);
      if (u.protocol !== "https:" || !hosts.has(u.hostname) || u.username || u.password) return null;
      const routes = [u.pathname.slice(1), u.searchParams.get("w") || "", u.searchParams.get("z") || ""];
      const found = routes.map(r => r.match(/^(wall|video|photo|clip)(-?\d+)_(\d+)(?:$|[/?])/)).filter(Boolean);
      const unique = [...new Set(found.map(m => `${m[1]}${m[2]}_${m[3]}`))];
      if (unique.length !== 1) return null;
      const m = found[0];
      const result = {type: m[1], owner_id: m[2], id: m[3], key: unique[0], url: `${u.origin}/${unique[0]}`};
      for (const name of ["reply", "thread"]) {
        const val = u.searchParams.get(name);
        if (val && /^\d+$/.test(val)) result[name] = val;
      }
      return result;
    } catch { return null; }
  }
  function publicLink(raw, base) {
    const r = resource(raw, base);
    if (r) return {url:r.url, resource:r};
    try {
      const u = new URL(raw, base);
      if (u.protocol !== "https:" || !hosts.has(u.hostname) || u.username || u.password) return null;
      // Only public identity/entry paths; never retain arbitrary queries, access keys or fragments.
      if (!/^\/(?:chinaorgcn|(?:club|public|id)-?\d+|videos-?\d+|clips-?\d+)\/?$/i.test(u.pathname)) return null;
      return {url:u.origin+u.pathname};
    } catch { return null; }
  }
  function cell(value) {
    let s = String(value ?? "");
    if (/^[\s\uFEFF]*[=+@-]/u.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  }
  function csv(rows, fields) {
    return "\uFEFF" + [fields, ...rows.map(r => fields.map(k => r[k]))].map(row => row.map(cell).join(",")).join("\r\n");
  }
  function validate(snapshot) {
    if (!snapshot || snapshot.schema_version !== 1 || !["0.1.0", "0.2.0", "0.2.1", "0.2.2", "0.3.0", "0.4.0", VERSION].includes(snapshot.version) ||
        !target(snapshot.entry_url) || !Array.isArray(snapshot.candidates) || snapshot.candidates.length > 1000 ||
        !Array.isArray(snapshot.entry_links) || snapshot.entry_links.length > 20 ||
        !Array.isArray(snapshot.rejected) || typeof snapshot.title !== "string" ||
        !Number.isFinite(Date.parse(snapshot.collected_at))) throw new Error("诊断格式或版本不匹配，未保存。");
    if (new TextEncoder().encode(JSON.stringify(snapshot)).length > MAX_BYTES) throw new Error("storage_batch_limit_8MB_export_required");
    return snapshot;
  }
  function report(snapshot) {
    return [{批次:snapshot.run_id,版本:snapshot.version,账号:snapshot.account_key,
      主页:snapshot.entry_url,身份状态:snapshot.identity_status,诊断时间:snapshot.collected_at,
      候选帖子数:snapshot.candidates.length,拒绝样本数:snapshot.rejected.length,
      状态:snapshot.status,研究起日:"2025-10-17",研究止日:"2026-10-17",
      覆盖说明:"仅当前已渲染且有尺寸的公开候选区域；未滚动、未展开、未核验身份、未执行采集"}];
  }
  // Project policy supplied by the researcher: missing year=2026, unspecified zone=UTC+8.
  function projectDate(raw) {
    const text=String(raw||'').trim();
    let m=text.match(/(?:^|\s)(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/u);
    if(!m){const iso=text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/);if(iso)m=iso;}
    if(!m)return null;
    const year=Number(m[1]||2026),month=Number(m[2]),day=Number(m[3]),hour=Number(m[4]||0),minute=Number(m[5]||0),second=Number(m[6]||0);
    if(year<1900||year>2100||month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour>23||minute>59||second>59)return null;
    const date=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const range=date>='2025-10-17'&&date<='2026-10-17'?'in_range':'out_of_range';
    const status=`research_assumed_UTC+8${m[1]?'_explicit_year':'_default_year_2026'}`;
    if(m[4]===undefined)return {raw:text,utc:'',bjt:date,status:status+'_day_precision',range,precision:'day'};
    const utc=new Date(Date.UTC(year,month-1,day,hour-8,minute,second)).toISOString();
    return {raw:text,utc,bjt:new Date(Date.parse(utc)+28800000).toISOString().replace('Z','+08:00'),status,range,precision:m[6]?'second':'minute'};
  }
  return {VERSION, PREFIX, MAX_BYTES, target, resource, publicLink, cell, csv, validate, report, projectDate};
})();
