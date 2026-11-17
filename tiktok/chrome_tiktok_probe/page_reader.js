/* Video field extraction adapted from dfreelon/pyktok (BSD-3-Clause),
 * comment DOM selection adapted from cubernetes/TikTokCommentScraper (MIT).
 * See THIRD_PARTY_NOTICES.md and bundled licenses. No internal API calls. */
function readTikTokPage() {
  const version = '0.5.0';
  const cleanURL = value => { try { const u = new URL(value, location.href); return u.origin + u.pathname; } catch { return ''; } };
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const text = (selector, root = document) => {
    const el = [...root.querySelectorAll(selector)].find(visible);
    return el ? el.innerText.trim() : null;
  };
  const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj?.[k] !== undefined).map(k => [k, obj[k]]));
  const page = new URL(location.href);
  const match = page.pathname.match(/^\/@([\w.]+)(?:\/(video|photo)\/(\d+))?\/?$/);
  if (page.protocol !== 'https:' || !['www.tiktok.com', 'tiktok.com'].includes(page.hostname) || !match) throw Error('请打开TikTok账号主页或视频详情页');
  const result = {schema:'tiktok_page_probe_v1', version, page_url:cleanURL(location.href), username:match[1],
    content_id:match[3] || '', collected_at_utc:new Date().toISOString(), profile:{}, items:[], links:[], comments:[],
    scrolls_used:0, reply_clicks_used:0, discovery_link_limit:null, comments_status:'not_collected_by_scope', status:'observed'};
  const barrier = [...document.querySelectorAll('iframe[src*="captcha"], [id*="captcha"], [data-e2e="captcha-container"], input[type="password"], [id="loginModalContentContainer"]')].find(visible);
  const bodyText = document.body?.innerText || '';
  if (barrier || /这是私密账号|This account is private|此账号为私密账号/i.test(bodyText)) {
    result.status = barrier ? 'login_or_verification_required' : 'private_account_stop';
    result.comments_status = 'not_attempted'; return result;
  }
  const roots = {};
  for (const id of ['__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE']) {
    const node = document.getElementById(id);
    if (node) { try { roots[id] = JSON.parse(node.textContent); } catch { /* Report structure missing below. */ } }
  }
  const scope = roots.__UNIVERSAL_DATA_FOR_REHYDRATION__?.__DEFAULT_SCOPE__ || {};
  const userInfo = scope['webapp.user-detail']?.userInfo;
  const sigiUsers = Object.values(roots.SIGI_STATE?.UserModule?.users || {});
  const user = userInfo?.user || sigiUsers.find(u => u.uniqueId?.toLowerCase() === match[1].toLowerCase());
  if (user && user.uniqueId?.toLowerCase() === match[1].toLowerCase()) {
    result.profile = {user:pick(user, ['id','uniqueId','nickname','signature','verified','privateAccount']),
      stats:pick(userInfo?.stats || roots.SIGI_STATE?.UserModule?.stats?.[user.uniqueId] || {}, ['followerCount','followingCount','heartCount','videoCount']),
      source_locator:userInfo ? 'webapp.user-detail.userInfo' : 'SIGI_STATE.UserModule'};
    if (user.privateAccount === true) { result.status='private_account_stop'; return result; }
  }
  result.profile.visible = {username:text('[data-e2e="user-title"]'), display_name:text('[data-e2e="user-subtitle"]'),
    bio_raw:text('[data-e2e="user-bio"]'),
    follower_count_raw:text('[data-e2e="followers-count"]'), following_count_raw:text('[data-e2e="following-count"]'), total_likes_raw:text('[data-e2e="likes-count"]')};
  for (const [script, items] of [['__UNIVERSAL_DATA_FOR_REHYDRATION__', [scope['webapp.video-detail']?.itemInfo?.itemStruct]], ['SIGI_STATE', Object.values(roots.SIGI_STATE?.ItemModule || {})]]) {
    for (const item of items.filter(Boolean)) {
      // Never retain another video injected by a recommendation or stale SPA state.
      const author = typeof item.author === 'string' ? {uniqueId:item.author} : item.author;
      if (!match[3] || String(item.id) !== match[3] || author?.uniqueId?.toLowerCase() !== match[1].toLowerCase()) continue;
      if (author.privateAccount === true) { result.status='private_account_stop';result.items=[];return result; }
      if (!result.profile.user) {
        result.profile.user=pick(author,['id','uniqueId','nickname','signature','verified']);
        result.profile.stats=pick(item.authorStatsV2 || item.authorStats || {},['followerCount','followingCount','heartCount','videoCount']);
        result.profile.source_locator=script+'.itemStruct.author/authorStats';
      }
      result.items.push({script, item:{...pick(item,['id','createTime','desc','textExtra','isAd']),
        author:pick(author,['id','uniqueId','nickname','signature','verified']),
        stats:pick(item.stats,['playCount','diggCount','commentCount','shareCount','collectCount']),
        statsV2:pick(item.statsV2,['playCount','diggCount','commentCount','shareCount','collectCount']),
        video:pick(item.video,['duration'])}});
    }
  }
  if (!match[3]) {
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const u = new URL(a.href, location.href), m = u.pathname.match(/^\/@([^/]+)\/(video|photo)\/(\d+)\/?$/);
      if (!visible(a) || !m || m[1].toLowerCase() !== match[1].toLowerCase() || !['www.tiktok.com','tiktok.com'].includes(u.hostname) || seen.has(m[3])) continue;
      seen.add(m[3]); result.links.push({content_id:m[3],content_url:cleanURL(a.href),content_type:m[2],text:a.innerText,aria_label:a.getAttribute('aria-label')});
    }
  } else {
    result.visible_metrics = Object.fromEntries(['like-count','comment-count','share-count','collect-count','browse-video-desc','video-desc','browser-nickname'].map(key => [key,text(`[data-e2e="${key}"]`)]));
    for(const key of ['like-count','comment-count','share-count','collect-count'])if(result.visible_metrics[key]===null)result.visible_metrics[key]=text(`[data-e2e="browse-${key}"]`);
    const canonical = document.querySelector('link[rel="canonical"]')?.href;
    result.canonical_url = canonical ? cleanURL(canonical) : '';
    if (!result.items.length) result.status='detail_structure_unavailable';
  }
  result.discovery_link_limit_reached=false;
  return result;
}
