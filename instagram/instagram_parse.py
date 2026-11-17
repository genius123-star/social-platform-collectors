"""Conservative mappings verified against the first Chinese-UI DOM diagnostic."""
import hashlib
import json
import re
from datetime import datetime, timezone, timedelta
from urllib.parse import urlsplit
from common import number

VERSION = '0.4.2'
VERIFIED_IDENTITIES = {'account_permalink_and_caption_author_match','account_permalink_and_header_match_caption_missing'}
BJT = timezone(timedelta(hours=8))
START = datetime(2025, 10, 16, 16, tzinfo=timezone.utc)
END = datetime(2026, 10, 17, 16, tzinfo=timezone.utc)
METRICS = ['like_count','comment_count','share_count','repost_count','favorite_count','view_count','play_count']


def parse_time(raw):
    try:
        result = datetime.fromisoformat(raw.replace('Z','+00:00'))
        return result.astimezone(timezone.utc) if result.tzinfo else None
    except (ValueError, TypeError, AttributeError):
        return None


def time_fields(raw):
    parsed = parse_time(raw)
    return dict(time_raw=raw or '', created_at_utc=parsed.isoformat() if parsed else '',
        created_at_bjt=parsed.astimezone(BJT).isoformat() if parsed else '',
        time_status='html_time_datetime' if parsed else 'timestamp_missing_or_ambiguous',
        period_status='date_pending' if not parsed else 'in_range' if START <= parsed < END else 'out_of_range')


def numeric(row, field, raw, locator, reason='not_available_from_captured_source'):
    value = number(raw)
    row.update({field: '' if value is None else value, field+'_raw':'' if raw is None else raw,
        field+'_status':'missing' if value is None else 'explicit_zero' if value == 0 else 'observed',
        field+'_precision':'' if value is None else 'rounded_display' if re.search('[KkMmBb万亿]',str(raw)) else 'exact_display',
        field+'_source':locator,field+'_missing_reason':reason if value is None else ''})


def content_link(url):
    page = urlsplit(url)
    if page.netloc != 'www.instagram.com' or page.scheme != 'https':
        return None
    match = re.fullmatch(r'/(?:(?P<owner>[A-Za-z0-9._]+)/)?(?P<route>p|reel|reels)/(?P<code>[A-Za-z0-9_-]+)/?', page.path)
    return match.groupdict() if match else None


def normalize(snapshot, account, snapshot_index):
    if snapshot.get('collection',{}).get('phase')=='detail_rejected':
        return [],[],[],[]  # Retained as raw evidence, never promoted to a successful post.
    observed = parse_time(snapshot['collected_at_utc'])
    base = dict(entity=account['entity'],entity_assignment_source=account['entity_assignment_source'],
        ownership_status=account['ownership_status'],platform='instagram',account_key=account['key'],
        account_language='und',username=account['username'],collected_at_utc=observed.isoformat(),
        collected_at_bjt=observed.astimezone(BJT).isoformat(),parser_version=VERSION,
        snapshot_index=snapshot_index,source='chrome_visible_dom',source_page_url=snapshot['page_url'])
    text = snapshot['visible_text']
    username = account['username']
    profiles, posts, comments, discoveries = [], [], [], []
    if snapshot['page_kind'] == 'profile':
        profile = dict(base,profile_url=account['url'],account_id='',display_name='',
            identity_status='profile_url_matches',bio_status='not_parsed')
        # This exact header layout is observed; other locales/layouts remain missing.
        header = re.match(r'^'+re.escape(username)+r'\n([^\n]+)\n([\d,.KkMm万亿]+)\n帖子\n([\d,.KkMm万亿]+)\n粉丝\n([\d,.KkMm万亿]+)\n关注(?:\n|$)',text)
        profile['display_name'] = header[1] if header else ''
        for field, group in [('total_post_count',2),('follower_count',3),('following_count',4)]:
            numeric(profile,field,header[group] if header else None,'visible_text.profile_header')
        profiles.append(profile)
        candidates = {}
        for index, link in enumerate(snapshot['links']):
            parsed = content_link(link['url'])
            if parsed and parsed['owner'] == username:
                candidates.setdefault(parsed['code'],dict(base,shortcode=parsed['code'],
                    content_url=link['url'],route_label=parsed['route'],source_locator=f'links[{index}]',
                    discovery_status='account_scoped_link_not_detail_verified',created_at_utc='',period_status='date_pending'))
        discoveries.extend(candidates.values())
        return profiles, posts, comments, discoveries

    code = snapshot['shortcode']
    permalinks = [(i,l,content_link(l['url'])) for i,l in enumerate(snapshot['links'])]
    permalinks = [(i,l,p) for i,l,p in permalinks if p and p['code']==code and p['owner']==username]
    matching_times = {t['datetime'] for t in snapshot['times']
                      if t.get('datetime') and any(l['text'] and l['text']==t['text'] for _,l,_ in permalinks)}
    raw_date = next(iter(matching_times)) if len(matching_times)==1 else ''
    # A displayed author block must contain its own time suffix, not a comment time.
    caption_candidates = []
    caption_times = {t['text'] for t in snapshot['times'] if raw_date and t.get('datetime')==raw_date and t.get('text')}
    for index, control in enumerate(snapshot['controls']):
        value = control.get('text','')
        if control.get('text_truncated'):
            continue
        if not value.startswith(username+'\n'):
            continue
        for time_text in caption_times:
            suffix = re.search(r'\n'+re.escape(time_text)+r'(?:\n查看翻译)?$',value)
            if suffix:
                caption_candidates.append((index,value[len(username)+1:suffix.start()]))
    caption_candidates = list(dict.fromkeys(caption_candidates))
    header_match = text.splitlines()[:1]==[username]
    author_linked = any(l.get('text')==username and l.get('url') in
                        (f'https://www.instagram.com/{username}/',f'https://www.instagram.com/{username}')
                        for l in snapshot['links'])
    caption_scoped_times = snapshot['controls'][caption_candidates[0][0]].get('times',[]) if len(caption_candidates)==1 else []
    caption_identity = (len(caption_candidates)==1 and parse_time(raw_date) is not None and author_linked
                        and len(caption_scoped_times)==1
                        and parse_time(caption_scoped_times[0].get('datetime'))==parse_time(raw_date))
    verified = bool(permalinks and (header_match or caption_identity))
    identity_status = ('account_permalink_and_caption_author_match' if len(caption_candidates)==1
                       else 'account_permalink_and_header_match_caption_missing') if verified else 'identity_pending'
    post = dict(base,content_id=code,content_id_kind='shortcode',platform_numeric_id='',
        content_url=f'https://www.instagram.com/p/{code}/',
        content_type='reel' if any(p['route'] in ('reel','reels') for _,_,p in permalinks) else 'unverified',
        identity_status=identity_status,
        identity_strategy='unconfirmed' if not verified else 'account_permalink_and_header' if header_match
                          else 'account_permalink_caption_author_and_scoped_time',
        caption=caption_candidates[0][1] if len(caption_candidates)==1 else '',
        caption_status='observed_author_block' if len(caption_candidates)==1 else 'missing_or_ambiguous',
        caption_source=f'controls[{caption_candidates[0][0]}].text' if len(caption_candidates)==1 else '',
        **time_fields(raw_date))
    post['comment_load_more_visible'] = any(c.get('label')=='加载更多评论' for c in snapshot['controls'])
    post['comments_coverage'] = 'partial_load_more_visible' if post['comment_load_more_visible'] else 'visible_fragments_only_completeness_unverified'
    if permalinks:
        post['content_url'] = permalinks[0][1]['url']
    post['content_type_source'] = 'account_scoped_reel_permalink' if post['content_type']=='reel' else 'not_verified'
    media = snapshot.get('media_evidence', {})
    if post['content_type']=='unverified' and media.get('type') in ('carousel','video'):
        post['content_type'] = media['type']
        post['content_type_source'] = media.get('source','')
    post['auto_run_id'] = snapshot.get('collection',{}).get('run_id','')
    post['comments_stop_reason'] = snapshot.get('collection_result',{}).get('stop_reason','')
    post['comments_complete'] = False
    post['replies_complete'] = False
    post['hashtags'] = json.dumps(re.findall(r'(?<!\w)#([^\s#]+)',post['caption']),ensure_ascii=False)
    post['hashtags_source'] = 'derived_from_caption'
    # A comment's like button must not be mistaken for post likes.
    authors = {l['text'] for l in snapshot['links'] if l['text'] and l['text']!=username
               and urlsplit(l['url']).path.rstrip('/')=='/'+l['text']}
    first_comment = next((i for i,c in enumerate(snapshot['controls'])
                          if c.get('text','').partition('\n')[0] in authors),len(snapshot['controls']))
    caption_position = caption_candidates[0][0] if len(caption_candidates)==1 else first_comment
    like_controls = [(i,c) for i,c in enumerate(snapshot['controls'][:caption_position])
                     if c.get('tag')=='DIV' and re.fullmatch(r'[\d,.KkMm万亿]+次赞',c.get('text',''))]
    for field in METRICS:
        numeric(post,field,None,'', 'not_available_from_captured_source')
    if verified and len(like_controls)==1:
        i,c = like_controls[0]
        numeric(post,'like_count',c['text'][:-2],f'controls[{i}].text')
    for field in ('comment_count','view_count','play_count'):
        evidence = [e for e in snapshot.get('metric_evidence',[])
                    if e.get('field')==field and e.get('source')=='confirmed_detail_outside_comment_items']
        values = {e.get('raw','') for e in evidence}
        if verified and len(values)==1:
            numeric(post,field,next(iter(values)),evidence[0].get('label',''))
    posts.append(post)
    if not verified:
        return profiles, posts, comments, discoveries

    seen_controls = set()
    for index, control in enumerate(snapshot['controls']):
        value = control.get('text','')
        if (control.get('tag')!='DIV' or value in seen_controls or control.get('text_truncated')
                or len(control.get('times',[]))>1):
            continue
        author, separator, rest = value.partition('\n')
        if not separator or author not in authors:
            continue
        matches = []
        for time_item in control.get('times') or snapshot['times']:
            time_text = time_item.get('text','')
            if not time_text or not time_item.get('datetime') or time_item['datetime']==raw_date:
                continue
            body, found, tail = rest.rpartition('\n'+time_text)
            suffix = re.fullmatch(r'(?:(?P<likes>[\d,.KkMm万亿]+)次赞)?回复(?:\n查看翻译)?',tail)
            if found and body and suffix:
                matches.append((body,time_item['datetime'],suffix['likes'],time_text))
        matches = list(dict.fromkeys(matches))
        bodies = {(body,likes,time_text) for body,_,likes,time_text in matches}
        if len(bodies)!=1:
            continue
        body,likes,time_text = next(iter(bodies))
        candidate_dates = sorted({date for _,date,_,_ in matches})
        comment_date = candidate_dates[0] if len(candidate_dates)==1 else ''
        comment = dict(base,content_id=code,content_url=post['content_url'],comment_id='',parent_comment_id='',reply_to_id='',
            comment_id_status='not_available_from_diagnostic',relation_status='not_available_from_diagnostic',
            author_username=author,body=body,source_locator=f'controls[{index}].text',
            comment_observation_id=hashlib.sha256(f'{snapshot_index}:{index}:{value}'.encode()).hexdigest(),
            content_period_status=post['period_status'],**time_fields(comment_date))
        comment['display_time_raw'] = time_text
        comment['time_candidates_json'] = json.dumps(candidate_dates)
        if comment_date and control.get('times'):
            comment['time_status'] = 'control_time_datetime'
        if not comment_date:
            comment['time_raw'] = time_text
            comment['time_status'] = 'ambiguous_relative_label_no_dom_association'
        numeric(comment,'like_count',likes,f'controls[{index}].text',reason='like_count_not_displayed')
        evidence = [e for e in snapshot.get('comment_evidence',[]) if
                    e.get('author_username')==author and e.get('datetime')==comment_date
                    and body in e.get('text','') and re.fullmatch(r'\d+',e.get('comment_id',''))]
        if len({e['comment_id'] for e in evidence})==1:
            comment['comment_id'] = evidence[0]['comment_id']
            comment['comment_id_status'] = 'explicit_public_comment_link'
            parents = {e['parent_comment_id'] for e in evidence if e.get('parent_comment_id')}
            comment['parent_comment_id'] = next(iter(parents)) if len(parents)==1 else ''
            comment['relation_status'] = 'dom_parent_verified' if comment['parent_comment_id'] else 'unverified'
        comment['auto_run_id'] = post['auto_run_id']
        comments.append(comment)
        seen_controls.add(value)
    return profiles, posts, comments, discoveries
