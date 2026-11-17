"""Import extension evidence without inventing dates, zeros or missing comments."""
import argparse
import csv
import hashlib
import json
import re
import shutil
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, urlencode
from common import ROOT, number, instant, BJT
from facebook_time import display_time

IMPORTER_VERSION = '0.6.0'


def post_identity(url):
    u = urlsplit(url)
    if u.hostname not in ('www.facebook.com', 'facebook.com'):
        return None
    match = re.search(r'/(reel|videos|posts|permalink)/([^/]+)', u.path)
    if match:
        return match[2], 'https://www.facebook.com' + u.path.rstrip('/') + '/', match[1]
    query = parse_qs(u.query)
    photo=re.search(r'/photos/(?:[^/]+/)?(\d+)/?$',u.path)
    if photo:
        return photo[1], 'https://www.facebook.com'+u.path.rstrip('/')+'/', 'photo'
    if u.path=='/photo.php' and 'fbid' in query:
        return query['fbid'][0], 'https://www.facebook.com/photo.php?'+urlencode({'fbid':query['fbid'][0]}), 'photo'
    if 'story_fbid' in query:
        rid = query['story_fbid'][0]
        keys = {key:query[key][0] for key in ('story_fbid','id') if key in query}
        return rid, 'https://www.facebook.com' + u.path + '?' + urlencode(keys), 'posts'
    return None


def write_csv(path, rows, fields):
    fields = list(dict.fromkeys([*fields,*(key for row in rows for key in row)]))
    with path.open('w',encoding='utf-8-sig',newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def comment_identity(url):
    query = parse_qs(urlsplit(url).query)
    parent = query.get('comment_id',[''])[0]
    reply = query.get('reply_comment_id',[''])[0]
    return (reply or parent, parent if reply else '')


def labelled_metrics(controls, labels=()):
    """Only explicit labels; a bare Like control is not a count or total."""
    patterns = {
        'like_count': [r'(?:赞|Likes?)[：:]\s*([\d,. KMB万亿]+)(?:位用户|people)?', r'([\d,. KMB万亿]+)\s+(?:likes?)'],
        'reaction_count': [r'(?:总反应|所有心情|全部心情|All reactions|Reactions)[：:]?\s*([\d,. KMB万亿]+)'],
        'comment_count': [r'(?:评论|Comments)[：:]\s*([\d,. KMB万亿]+)', r'([\d,. KMB万亿]+)\s*(?:条评论|comments)'],
        'share_count': [r'(?:分享|Shares)[：:]\s*([\d,. KMB万亿]+)', r'([\d,. KMB万亿]+)\s*(?:次分享|shares)'],
        'view_count': [r'(?:浏览量|Views)[：:]\s*([\d,. KMB万亿]+)', r'([\d,. KMB万亿]+)\s*(?:次浏览|views)'],
        'play_count': [r'(?:播放量|Plays)[：:]\s*([\d,. KMB万亿]+)', r'([\d,. KMB万亿]+)\s*(?:次播放|plays)'],
    }
    observed = {field:{} for field in patterns}
    texts = list(labels)
    for c in controls:
        label, raw = c.get('aria_label',''), c.get('text','').strip()
        texts.extend([label, raw])
        field = 'comment_count' if label in ('发表评论','Comment','Comments') else 'share_count' if label.startswith('分享，') else None
        if field and number(raw) is not None:
            observed[field][number(raw)] = (raw, label)
    for text in texts:
        for field, rules in patterns.items():
            for rule in rules:
                match = re.fullmatch(rule, text.strip(), re.I)
                if match and number(match[1]) is not None:
                    observed[field][number(match[1])] = (match[1], text)
    return {field:dict(value=next(iter(values)), raw=next(iter(values.values()))[0], label=next(iter(values.values()))[1])
            for field,values in observed.items() if len(values)==1}


def post_metrics(controls, labels=(), *, scoped=False):
    """Research likes use the post action's displayed count, not a reaction subtype.

    Only scoped own-post controls can establish a numeric Like/Comment/Share
    sequence. An empty Share in that sequence is an explicitly flagged inference.
    """
    result = labelled_metrics(controls, labels)
    if not scoped:
        return result
    boundary = next((i for i,c in enumerate(controls)
                     if c.get('text','').strip() in ('查看更多评论','View more comments')), len(controls))
    actions = controls[:boundary]
    likes = [(i,c) for i,c in enumerate(actions)
             if c.get('aria_label','') in ('赞','Like') and number(c.get('text','').strip()) is not None]
    comments = [(i,c) for i,c in enumerate(actions)
                if c.get('aria_label','') in ('发表评论','Comment','Comments') and number(c.get('text','').strip()) is not None]
    # The video player's own Share can precede the post's interaction row.
    shares = [(i,c) for i,c in enumerate(actions)
              if len(comments)==1 and i>comments[0][0] and
              (c.get('aria_label','').startswith('分享，') or c.get('aria_label','') in ('分享','Share'))]
    if any(re.fullmatch(r'赞[：:]\s*[\d,.万亿KMBkmb\s]+位用户',c.get('aria_label','')) for c in actions):
        result.pop('like_count',None)
    if len(likes)==1:
        like=likes[0][1]
        result['like_count'] = dict(value=number(like['text'].strip()),raw=like['text'].strip(),
            label=like['aria_label'],status='displayed_post_action_count',
            definition='research_like_count_includes_displayed_reactions')
    # Reject ambiguous duplicate controls rather than pairing unrelated counts.
    if len(likes) != 1 or len(comments) != 1 or len(shares) != 1:
        return result
    (li,like),(ci,comment),(si,share) = likes[0],comments[0],shares[0]
    if not li < ci < si or share.get('aria_busy') or share.get('disabled'):
        return result
    share_raw = share.get('text','').strip()
    if number(share_raw) is not None:
        result['share_count'] = dict(value=number(share_raw),raw=share_raw,
            label=share['aria_label'],status='explicit_displayed_count')
    elif share_raw == '' and 'share_count' not in result:
        result['share_count'] = dict(value=0,raw='',label=share['aria_label'],
            status='inferred_zero_from_blank_share_in_numeric_post_action_sequence')
    return result


def convert(source, output_root=None):
    csv.field_size_limit(max(csv.field_size_limit(),64*1024*1024))
    with source.open(encoding='utf-8-sig', newline='') as f:
        all_rows = list(csv.DictReader(f))
    metadata = next((r for r in all_rows if r.get('record_type')=='run_metadata'), {})
    rows = [r for r in all_rows if r.get('record_type')!='run_metadata']
    account_key = metadata.get('account_key') or next((row.get('account_key') for row in rows if row.get('account_key')), '')
    if not account_key or account_key in ('.', '..') or not re.fullmatch(r'[A-Za-z0-9_.-]+', account_key):
        raise ValueError('invalid_or_missing_account_key')
    profile_url = metadata.get('profile_url') or next((row.get('profile_url') for row in rows if row.get('profile_url')), '')
    def profile_identity(value):
        u = urlsplit(value)
        return u.hostname, u.path.rstrip('/').lower(), parse_qs(u.query).get('id', [''])[0]
    if not profile_url or any(row.get('account_key') != account_key or profile_identity(row.get('profile_url','')) != profile_identity(profile_url) for row in rows):
        raise ValueError('mixed_or_missing_target_account')
    registry = json.loads((ROOT/'accounts.json').read_text(encoding='utf-8-sig'))
    registered = next((a for a in registry if a.get('platform') == 'facebook' and a.get('key') == account_key), None)
    if registered and profile_identity(registered['url']) != profile_identity(profile_url):
        raise ValueError('registered_account_profile_mismatch')
    language = registered.get('language', 'unclassified') if registered else 'unclassified'
    posts, comments, profiles, errors = [], [], [], []
    def decode(raw, default, locator):
        try:
            value = json.loads(raw) if raw else default
            if not isinstance(value,type(default)):
                raise ValueError('unexpected JSON type')
            return value
        except (ValueError,TypeError) as error:
            errors.append(dict(action='parse_error',detail=locator+': '+str(error)))
            return default
    state=decode(metadata.get('run_state_json'),{},'run_state_json')
    if errors:
        raise ValueError('invalid_run_state_json')
    config = state.get('config')
    if config is None:
        config = json.loads((ROOT/'pilot_config.json').read_text(encoding='utf-8'))
    try:
        start, end = (date.fromisoformat(config[key]).isoformat() for key in ('start_date_bjt','end_date_bjt'))
        if start > end:
            raise ValueError('reversed date bounds')
    except (TypeError, KeyError, ValueError) as exc:
        raise ValueError('invalid_run_date_window') from exc
    parent = Path(output_root).resolve() if output_root is not None else ROOT/'outputs'/'facebook'/language/account_key
    out = parent/(datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'_extension_import')
    (out/'raw_data').mkdir(parents=True)
    shutil.copy2(source, out/'raw_data'/source.name)
    for row in rows:
        links = decode(row.get('raw_links_json'),[],'raw_links_json')
        controls = decode(row.get('raw_post_only_controls_json') or row.get('raw_controls_json'),[],'raw_controls_json')
        detail=decode(row.get('raw_detail_evidence_json'),{},'raw_detail_evidence_json')
        identities = {identity for x in links if (identity := post_identity(x['url']))}
        identity = next(iter(identities)) if len(identities) == 1 else ('','','')
        if row.get('post_url_status')=='own_time_link_resource':
            identity=post_identity(row.get('post_url','')) or ('','','')
        rid, url, content_type = identity
        # Read the observed post controls before comment actions; keep the original CSV too.
        boundary = next((i for i,c in enumerate(controls) if c.get('text') == '查看更多评论'),len(controls))
        post_controls = controls[:boundary]
        def button_value(predicate):
            values = {c['text'].strip() for c in post_controls if predicate(c.get('aria_label','')) and number(c.get('text')) is not None}
            return next(iter(values)) if len(values) == 1 else ''
        types = []
        for control in post_controls:
            match = re.fullmatch(r'(赞|大爱|抱抱|哈哈|哇|难过|怒)[：:]\s*([\d,.万亿KMBkmb\s]+)位用户',control.get('aria_label',''))
            if match:
                types.append((match[1], match[2], control['aria_label']))
        likes = {raw for label,raw,_ in types if label == '赞'}
        like_raw = next(iter(likes)) if len(likes) == 1 else ''
        reaction_raw = button_value(lambda label: label == '赞')
        # A numeric action labelled Like alone is insufficient proof of a total.
        reaction_verified = bool(reaction_raw and types and all(number(raw) is not None for _,raw,_ in types)
            and sum(number(raw) for _,raw,_ in types) == number(reaction_raw))
        comment_raw = button_value(lambda label:label == '发表评论')
        share_raw = button_value(lambda label:label.startswith('分享，'))
        date_links = [x for x in links if post_identity(x['url']) == identity and 'comment_id=' not in x['url'] and re.search(r'天|月|日|小时|分钟|年',x.get('text',''))]
        date_raw = date_links[0]['text'] if date_links else ''
        time_elements = decode(row.get('raw_post_only_time_elements_json'),[],'post_time_elements')+detail.get('times',[])+detail.get('structured_times',[])
        hover=decode(row.get('publication_time_hover_evidence_json'),[],'publication_time_hover_evidence_json')
        display_candidates=[]
        def observe_date(value,source,verified=True):
            fact=display_time(value)
            if fact['display_datetime']:
                display_candidates.append(dict(source=source,resource_association_verified=verified,**fact))
        for link in links+detail.get('links',[]):
            if post_identity(link.get('url',''))==identity and 'comment_id=' not in link.get('url',''):
                for key in ('text','title','aria_label'):observe_date(link.get(key),'own_post_date_link.'+key)
        for evidence in hover:
            if evidence.get('date_attributes'):time_elements.append(evidence['date_attributes'])
            time_elements.extend(evidence.get('time_elements',[]))
            time_elements.extend(evidence.get('structured_times',[]))
            for key in ('text','title','aria_label'):observe_date(evidence.get(key),'date_hover_anchor.'+key)
            for value in evidence.get('associated_tooltips',[]):observe_date(value,'aria_describedby_date_tooltip')
            lifecycle=evidence.get('tooltip_lifecycle',{})
            first=lifecycle.get('first_full_dates',[])
            lifecycle_confirmed=(lifecycle.get('status')=='repeat_hover_lifecycle_confirmed'
                and bool(rid) and post_identity(lifecycle.get('post_url',''))==identity
                and post_identity(evidence.get('post_url',''))==identity
                and lifecycle.get('baseline_full_dates')==[] and len(first)==1
                and lifecycle.get('repeated_full_dates')==first
                and lifecycle.get('after_leave_full_dates')==[] and lifecycle.get('after_repeat_leave_full_dates')==[]
                and all(lifecycle.get(key) is True for key in ('after_leave_stable','repeat_stable','after_repeat_leave_stable'))
                and isinstance(lifecycle.get('stable_interval_ms'),(int,float)) and lifecycle['stable_interval_ms']>=750)
            for tooltip in evidence.get('new_tooltips',[]):
                confirmed=lifecycle_confirmed and tooltip.get('text')==first[0]
                observe_date(tooltip.get('text'),'repeat_hover_lifecycle_same_post_date' if confirmed else 'new_tooltip_temporal_association_only',confirmed)
        timestamps = {dt.isoformat() for item in time_elements
                      for value in (item.get('unix_time'),item.get('datetime')) if (dt := instant(value))}
        timestamps.update(fact['utc'] for fact in display_candidates if fact['resource_association_verified'] and fact['utc'])
        exact_time = next(iter(timestamps)) if len(timestamps) == 1 else ''
        displayed={fact['display_datetime'] for fact in display_candidates if fact['resource_association_verified']}
        time_status='conflicting_explicit_resource_times' if len(timestamps)>1 else 'explicit_resource_time_evidence' if exact_time else 'conflicting_display_dates' if len(displayed)>1 else 'display_date_available_timezone_unverified' if len(displayed)==1 else 'unassociated_tooltip_requires_verification' if display_candidates else 'exact_year_time_and_timezone_not_verified'
        timezone_policy=row.get('publication_time_timezone_policy') or state.get('config',{}).get('display_timezone_policy','')
        if not timestamps and len(displayed)==1 and timezone_policy=='user_assumed_Asia_Shanghai':
            displayed_date=datetime.fromisoformat(next(iter(displayed)))
            if displayed_date.tzinfo is None:
                exact_time=displayed_date.replace(tzinfo=BJT).astimezone(timezone.utc).isoformat()
                time_status='full_display_date_user_assumed_BJT_not_platform_verified'
        post = dict(account_key=row['account_key'], post_id=rid, post_url=url,
            link_status='single_resource_ID_in_article' if rid else 'ambiguous_or_missing',
            content_type=content_type, publication_time_display_raw=date_raw,
            exact_publish_time_utc=exact_time, publication_time_status=time_status,
            publication_time_timezone_policy=timezone_policy,
            publication_time_display_full=next(iter(displayed)) if len(displayed)==1 else '',
            publication_time_candidates_json=json.dumps(display_candidates,ensure_ascii=False),
            publication_time_display_precision=next(iter({f['precision'] for f in display_candidates if f['resource_association_verified']})) if len(displayed)==1 and len({f['precision'] for f in display_candidates if f['resource_association_verified']})==1 else '',
            publication_time_precision='minute' if exact_time and any((f['utc']==exact_time or time_status=='full_display_date_user_assumed_BJT_not_platform_verified') and f['precision']=='minute' and f['resource_association_verified'] for f in display_candidates) else 'second' if exact_time else '',
            publication_time_hover_evidence_json=row.get('publication_time_hover_evidence_json',''),
            visible_article_text_raw=row['visible_article_text'], like_count=number(like_raw) if like_raw else '',
            like_count_raw=like_raw, like_source='reaction_type_accessibility_label' if like_raw else '',
            reaction_count=number(reaction_raw) if reaction_verified else '', reaction_count_raw=reaction_raw,
            reaction_source='post_action_count_matches_observed_reaction_breakdown' if reaction_verified else 'not_verified',
            reaction_types_raw=json.dumps(types,ensure_ascii=False),
            comment_count=number(comment_raw) if comment_raw else '', comment_count_raw=comment_raw,
            share_count=number(share_raw) if share_raw else '', share_count_raw=share_raw,
            view_count='',favorite_count='',missing_metrics_reason='no_explicit_verified_value_in_snapshot',
            collected_at_utc=row['collected_at_utc'], source_file=source.name,
            source_row=row['sample_index'],coverage='formal_feed_scan_completeness_not_established' if (state.get('config') or {}).get('collection_scope')=='formal' else 'loaded_sample_only_not_annual_coverage',
            comment_expansion_status=row.get('comment_expansion_status','not_attempted_v0.1'),
            comment_expansion_actions_json=row.get('comment_expansion_actions_json',''),
            matching_public_post_dialog_text_raw=row.get('matching_public_post_dialog_text_raw',''),
            comment_sort_status=row.get('comment_sort_status','not_attempted'),
            comment_sort_menu_evidence_json=row.get('comment_sort_menu_evidence_json',''),
            comment_collection_warning=row.get('comment_collection_warning',''),
            collection_mode=row.get('collection_mode','homepage_sample'),
            comment_sort_selection_origin=row.get('comment_sort_selection_origin','not_recorded'),
            dialog_comment_expansion_status=row.get('dialog_comment_expansion_status','not_attempted'),
            collection_stop_reason=row.get('collection_stop_reason',''),
            comment_access_status='no_reliable_detail_entry_observed_not_zero' if row.get('collection_stop_reason')=='comment_detail_entry_not_identified' else 'detail_observed' if detail else 'not_verified')
        for key in ('latest_attempt_status','latest_attempt_stop_reason','latest_attempt_evidence_json','automatic_recovery_status','automatic_recovery_reason'):
            post[key]=row.get(key,'')
        post['post_content_kind']=row.get('post_content_kind','not_verified_legacy')
        post['content_kind_evidence_json']=row.get('content_kind_evidence_json','')
        post['detail_access_status']=row.get('detail_access_status','detail_observed' if detail else 'not_verified')
        for key in ('comment_entry_selection_method','comment_entry_evidence_json','source_relocation_evidence_json','publication_time_read_status','publication_time_dialog_recovery_json','comment_entry_before_click_json','unexpected_viewer_navigation_json'):
            post[key]=row.get(key,'')
        if row.get('post_content_kind')=='image':post['content_type']='image'
        if row.get('collection_mode')=='image_post_list_fallback':
            post['comment_access_status']='unavailable_no_confirmed_detail'
            post['comment_text_status']='unavailable_after_comment_entry_attempt'
        for key in ('raw_list_initial_evidence_json','list_body_expand_status','list_body_expand_actions_json','list_updated_at_utc'):
            post[key]=row.get(key,'')
        if row.get('collection_mode')=='image_post_list_only':
            post['content_type']='image'
            post['comment_access_status']='not_collected_image_post_policy'
            post['comment_text_status']='unavailable_not_collected_under_image_post_policy'
        post['source_observation_role']=row.get('observation_role','legacy_or_current')
        post['navigation_evidence_json']=row.get('navigation_evidence_json','')
        post['detail_opening_evidence_json']=row.get('detail_opening_evidence_json','')
        post['comment_sort_attempts_json']=row.get('comment_sort_attempts_json','')
        posts.append(post)
        stamp=instant(exact_time)
        date_status='date_pending' if not stamp else 'in_range' if start<=stamp.astimezone(BJT).date().isoformat()<=end else 'out_of_range'
        runtime_date=decode(row.get('date_window_evidence_json'),{},'date_window_evidence_json')
        post['date_window_evidence_json']=row.get('date_window_evidence_json','')
        post['runtime_import_time_consistency']='not_available_legacy_or_runtime_pending'
        if runtime_date.get('range') in ('before_start','in_range','after_end'):
            expected_range='before_start' if stamp and stamp.astimezone(BJT).date().isoformat()<start else 'after_end' if stamp and stamp.astimezone(BJT).date().isoformat()>end else 'in_range' if stamp else 'date_pending'
            consistent=bool(stamp) and runtime_date.get('timestamp_ms')==int(stamp.timestamp()*1000) and runtime_date['range']==expected_range and instant(runtime_date.get('start_utc'))==datetime.fromisoformat(start).replace(tzinfo=BJT) and instant(runtime_date.get('end_exclusive_utc'))==datetime.fromisoformat(end).replace(tzinfo=BJT)+timedelta(days=1)
            post['runtime_import_time_consistency']='matched' if consistent else 'mismatch_requires_review'
            if not consistent:date_status='date_pending'
        list_body=decode(row.get('raw_post_body_json'),{},'raw_post_body_json')
        body=detail.get('body') if detail.get('body',{}).get('text') else list_body
        post.update(post_text=body.get('text',''),post_text_status=body.get('status','not_extracted_legacy'),
            hashtags_json=json.dumps(body.get('hashtags',[]),ensure_ascii=False),
            post_image_alt_json=json.dumps(body.get('image_alt_labels',[]),ensure_ascii=False),
            publication_time_bjt=stamp.astimezone(BJT).isoformat() if stamp else '',
            publication_timestamp=int(stamp.timestamp()) if stamp else '',
            date_status=date_status,start_date_bjt=start,end_date_bjt=end,
            play_count='',play_count_raw='',raw_detail_evidence_json=row.get('raw_detail_evidence_json',''),
            processing_status=row.get('processing_status','legacy_sample'),
            return_to_profile_status=row.get('return_to_profile_status','not_recorded'),
            version=row.get('version',''),run_id=row.get('run_id',''))
        post['post_text_origin']='detail' if body is detail.get('body') else 'list'
        post['list_collected_at_utc']=row['collected_at_utc']
        post['detail_collected_at_utc']=detail.get('collected_at_utc','')
        if detail.get('collected_at_utc'):post['collected_at_utc']=detail['collected_at_utc']
        post['like_reaction_type_count']=number(like_raw) if like_raw else ''
        post['like_reaction_type_count_raw']=like_raw
        post['like_count_definition']='research_like_count_includes_displayed_reactions'
        list_metrics=post_metrics(controls,scoped=bool(row.get('raw_post_only_controls_json')))
        detail_metrics=post_metrics(detail.get('controls',[]),detail.get('labels',[]),
            scoped=bool(detail) and row.get('post_url_status')=='own_time_link_resource')
        selected_metrics={**list_metrics,**detail_metrics}
        if detail_metrics.get('share_count',{}).get('status','').startswith('inferred_zero') and 'share_count' in list_metrics and not list_metrics['share_count'].get('status','').startswith('inferred_zero'):
            selected_metrics['share_count']=list_metrics['share_count']
        for field, metric in selected_metrics.items():
            post[field]=metric['value'];post[field+'_raw']=metric['raw']
            post[field+'_evidence']=metric['label'];post[field+'_origin']='detail' if metric is detail_metrics.get(field) else 'list'
            post[field+'_status']=metric.get('status','explicit_label')
            if field=='like_count':post['like_source']=metric.get('status','explicit_like_label')
        # Do not substitute a subtype count when the displayed research count is absent.
        if 'like_count' not in list_metrics and 'like_count' not in detail_metrics:
            post['like_count']='';post['like_count_raw']='';post['like_source']='not_verified'
        if post.get('share_count_status','').startswith('inferred_zero'):
            post['share_count_inference_rule']='blank_share_with_unique_numeric_like_comment_controls_v1'
        for field in ('like_count','reaction_count','comment_count','share_count','view_count','play_count'):
            post[field+'_precision']='abbreviated_display' if re.search(r'[KMB万亿]',str(post.get(field+'_raw','')),re.I) else 'as_displayed' if post.get(field,'') not in ('',None) else 'not_verified'
            post.setdefault(field+'_status','missing_not_observed' if post.get(field,'') in ('',None) else 'explicit_displayed_count')
        if (state.get('config') or {}).get('collection_scope')=='formal':
            for field in ('view_count','play_count'):
                post[field]='';post[field+'_status']='unavailable_under_research_scope'
                post[field+'_precision']='not_available'
        if post.get('share_count_status','').startswith('inferred_zero'):
            post['share_count_precision']='inferred_zero'
        post['list_metrics_json']=json.dumps(list_metrics,ensure_ascii=False)
        post['detail_metrics_json']=json.dumps(detail_metrics,ensure_ascii=False)
        raw_comments = decode(row.get('raw_visible_comments_json'),[],'visible_comments') if row.get('raw_visible_comments_json') else [dict(text=t) for t in decode(row.get('nested_article_texts_json'),[],'nested_comments')]
        dialog_comments = decode(row.get('raw_dialog_visible_comments_json'),[],'dialog_comments')
        merged = {}
        for observation_index,c in enumerate(raw_comments + dialog_comments):
            ids = {comment_identity(x['url'])[0]
                   for x in c.get('links',[]) if rid and post_identity(x['url']) == identity and comment_identity(x['url'])[0]}
            key = ('id',next(iter(ids))) if len(ids)==1 else ('unverified_observation',observation_index)
            merged[key] = c
        raw_comments = list(merged.values())
        comment_links = [x for x in links if 'comment_id=' in x['url'] and post_identity(x['url']) == identity]
        for index,comment in enumerate(raw_comments):
            text = comment['text']
            own_links = [x for x in comment.get('links',[]) if 'comment_id=' in x['url'] and post_identity(x['url']) == identity]
            link = own_links[0] if len(own_links) == 1 else comment_links[0] if len(comment_links) == 1 and len(raw_comments) == 1 else {}
            comment_id, parent_comment_id = comment_identity(link.get('url',''))
            match = re.search(r'\n\s*·\s*\n[^\n]+\n([\s\S]*?)\n回复(?:\n|$)',text)
            comments.append(dict(account_key=row['account_key'],post_id=rid,post_url=url,comment_id=comment_id,
                comment_url=link.get('url',''),parent_comment_id=parent_comment_id,
                raw_visible_comment_container=text, comment_text=match[1] if match else '',
                raw_comment_links_json=json.dumps(comment.get('links',[]),ensure_ascii=False),
                raw_comment_controls_json=json.dumps(comment.get('controls',[]),ensure_ascii=False),
                raw_comment_image_alt_json=json.dumps(comment.get('image_alt_labels',[]),ensure_ascii=False),
                like_count='',like_count_status='not_verified_from_visible_controls',
                text_extraction_status='display_structure_extraction_needs_review' if match else 'raw_container_only',
                publication_time_display_raw=link.get('aria_label','') or link.get('text',''),
                exact_publish_time_utc='',timezone_status='not_verified', collected_at_utc=row['collected_at_utc'],
                source_file=source.name,source_row=row['sample_index'],
                source_locator=f'visible_comment_container[{index}]',coverage='visible_subset_completeness_not_established'))
            comments[-1].update(post_date_status=date_status,version=row.get('version',''),
                source_observation_role=row.get('observation_role','legacy_or_current'),
                comment_sort_status=row.get('comment_sort_status','not_attempted'),
                comment_identity_status='explicit_resource_link' if comment_id else 'identity_not_verified',
                reaction_count='')
            if comment.get('message_status')=='explicit_comment_message':
                comments[-1]['comment_text']=comment['message_text']
                comments[-1]['text_extraction_status']='explicit_comment_message'
            comment_metrics=labelled_metrics(comment.get('controls',[]))
            if 'like_count' in comment_metrics:
                comments[-1]['like_count']=comment_metrics['like_count']['value']
                comments[-1]['like_count_status']='explicit_like_label'
            ct={d.isoformat() for item in comment.get('time_elements',[]) for raw in (item.get('unix_time'),item.get('datetime')) if (d:=instant(raw))}
            if len(ct)==1:
                comments[-1]['exact_publish_time_utc']=next(iter(ct))
                comments[-1]['timezone_status']='explicit_time_attribute'
            comments[-1]['raw_comment_time_elements_json']=json.dumps(comment.get('time_elements',[]),ensure_ascii=False)
            comments[-1]['publication_time_bjt']=instant(comments[-1]['exact_publish_time_utc']).astimezone(BJT).isoformat() if comments[-1]['exact_publish_time_utc'] else ''
        if row.get('raw_profile_evidence_json') and not profiles:
            profile = decode(row['raw_profile_evidence_json'],{},'profile')
            follower_raw = profile.get('followers_raw','')
            count = re.search(r'[\d,.\s]+[KMBkmb万亿]?',follower_raw)
            profiles.append(dict(account_key=row['account_key'],profile_url=row['profile_url'],
                account_name=profile.get('name_raw',''),account_name_source=profile.get('name_source','legacy_not_recorded'),follower_count_raw=follower_raw,
                follower_count=number(count[0]) if count else '',follower_precision='as_displayed_may_be_abbreviated',
                description='',description_status='not_verified_review_raw_about_text',
                verification='',verification_status='not_verified_review_raw_labels',
                account_create_time='',account_create_time_status='not_verified_review_raw_about_text',
                about_attempt_status=profile.get('about_attempt','not_attempted'),
                raw_profile_evidence_json=row['raw_profile_evidence_json'],collected_at_utc=row['collected_at_utc']))
            for field,status in [('description','explicit_profile_bio'),('verification','explicit_badge_label')]:
                if profile.get(field+'_status')==status:
                    profiles[-1][field]=profile.get(field,'');profiles[-1][field+'_status']=status
    if not profiles and metadata.get('raw_profile_evidence_json'):
        profile=decode(metadata['raw_profile_evidence_json'],{},'metadata_profile')
        raw=profile.get('followers_raw','');match=re.search(r'[\d,.\s]+[KMBkmb万亿]?',raw)
        profiles.append(dict(account_key=metadata.get('account_key','cd_fb_en'),profile_url=metadata.get('profile_url',''),
            account_name=profile.get('name_raw',''),account_name_source=profile.get('name_source','legacy_not_recorded'),follower_count_raw=raw,follower_count=number(match[0]) if match else '',
            follower_precision='as_displayed_may_be_abbreviated',description=profile.get('description','') if profile.get('description_status')=='explicit_profile_bio' else '',
            description_status=profile.get('description_status','not_verified'),verification=profile.get('verification','') if profile.get('verification_status')=='explicit_badge_label' else '',
            verification_status=profile.get('verification_status','not_verified'),account_create_time='',account_create_time_status='not_verified',
            raw_profile_evidence_json=metadata['raw_profile_evidence_json'],collected_at_utc=profile.get('collected_at_utc','')))
    # Recover a missing display name only from consistent, verified own-post
    # author links before each post permalink; never from a URL or a comment.
    author_names={}
    for row in rows:
        if row.get('post_url_status')!='own_time_link_resource':continue
        expected=post_identity(row.get('post_url',''))
        target=urlsplit(row.get('profile_url',''))
        if not expected or target.hostname!='www.facebook.com':continue
        evidence=decode(row.get('raw_links_json'),[],'profile_author_links')
        boundary=next((i for i,link in enumerate(evidence) if post_identity(link.get('url',''))==expected
            and not comment_identity(link.get('url',''))[0]),0)
        values=set()
        for link in evidence[:boundary]:
            address=urlsplit(link.get('url',''))
            if address.hostname==target.hostname and address.path.rstrip('/').lower()==target.path.rstrip('/').lower() and not address.query:
                value=re.sub(r'[\s\uFEFF]+',' ',link.get('text') or link.get('aria_label') or '').strip()
                if value:values.add(value)
        if len(values)==1:author_names[(row.get('profile_url'),expected[0])]=next(iter(values))
    for profile in profiles:
        facts=[dict(post_id=post_id,name=name) for (profile_url,post_id),name in author_names.items() if profile_url==profile['profile_url']]
        if not profile.get('account_name') and len(facts)>=2 and len({fact['name'] for fact in facts})==1:
            profile['account_name']=facts[0]['name']
            profile['account_name_source']='verified_own_post_author_consensus_from_raw_links'
            profile['account_name_evidence_json']=json.dumps(facts,ensure_ascii=False)
    # Preserve all raw observations in the copied CSV. The normalized view keeps
    # the last source row per explicit ID; unknown identities are not merged.
    original_post_count,original_comment_count=len(posts),len(comments)
    posts=list({(p['post_id'] or 'source_row:'+p['source_row']):p for p in posts}.values())
    posts.sort(key=lambda post:(int(post['source_row']) if str(post['source_row']).isdigit() else 10**12,str(post['source_row'])))
    comments=list({(c['post_id'],c['comment_id'] or ('source',c['source_row'],c['source_locator'],c['collected_at_utc'],c['source_observation_role'])):c for c in comments}.values())
    for record in posts+comments+profiles:
        for key,value in record.items():
            if value is None:record[key]=''
    write_csv(out/'posts.csv', posts, list(posts[0]) if posts else ['post_id','post_url','date_status'])
    for filename,status in [('posts_in_range.csv','in_range'),('date_pending.csv','date_pending'),('out_of_range.csv','out_of_range')]:
        subset=[p for p in posts if p['date_status']==status]
        write_csv(out/filename,subset,list(posts[0]) if posts else ['post_id','post_url','date_status'])
    write_csv(out/'comments.csv', comments, list(comments[0]) if comments else ['post_id','comment_id','comment_text'])
    selected_dates={post['post_id']:post['date_status'] for post in posts if post['post_id']}
    period_comments=[dict(comment,post_date_status='in_range') for comment in comments if selected_dates.get(comment['post_id'])=='in_range']
    write_csv(out/'comments_in_range.csv',period_comments,list(comments[0]) if comments else ['post_id','comment_id','comment_text'])
    write_csv(out/'account_profile.csv',profiles,list(profiles[0]) if profiles else ['account_key','profile_url','account_name','follower_count','description','verification','account_create_time'])
    field_status = []
    for post in posts:
        for field in ('post_id','post_url','post_text','exact_publish_time_utc','like_count','reaction_count','comment_count','share_count','view_count','play_count','favorite_count'):
            observed = post[field] != ''
            field_status.append(dict(resource_type='post',resource_id=post['post_id'],field=field,
                status='derived_under_user_timezone_assumption' if field=='exact_publish_time_utc' and post['publication_time_status']=='full_display_date_user_assumed_BJT_not_platform_verified' else 'observed' if observed else 'not_observed_in_capture',
                reason='' if observed else post['publication_time_status'] if field=='exact_publish_time_utc' else 'no_explicit_verified_value_in_snapshot'))
    for comment in comments:
        for field in ('comment_id','comment_text','exact_publish_time_utc','like_count'):
            observed=comment.get(field,'')!=''
            field_status.append(dict(resource_type='comment',resource_id=comment['comment_id'],field=field,
                status='observed' if observed else 'not_verified',reason='' if observed else 'review_raw_comment_evidence'))
    for profile in profiles:
        for field in ('account_name','follower_count','description','verification','account_create_time'):
            observed=profile.get(field,'')!=''
            field_status.append(dict(resource_type='account',resource_id=profile['account_key'],field=field,
                status='observed' if observed else 'not_verified',reason='' if observed else 'not_verified_from_profile_snapshot'))
    write_csv(out/'field_status.csv',field_status,['resource_type','resource_id','field','status','reason'])
    valid_times=[p['exact_publish_time_utc'] for p in posts if p['exact_publish_time_utc']]
    coverage=dict(saved_prior_observations=sum(row.get('record_type')=='post_observation' for row in rows),discovered_unique_resources=len(state.get('discovered',[])) if state else len({p['post_id'] for p in posts if p['post_id']}),
        saved_posts=len(posts),detail_opened=sum(bool(p['raw_detail_evidence_json'] or p['matching_public_post_dialog_text_raw']) for p in posts),
        in_range=sum(p['date_status']=='in_range' for p in posts),date_pending=sum(p['date_status']=='date_pending' for p in posts),
        out_of_range=sum(p['date_status']=='out_of_range' for p in posts),saved_comments=len(comments),
        comment_sort_confirmed=sum(p['comment_sort_status']=='all_comments_visible_selected' for p in posts),
        earliest_exact_utc=min(valid_times) if valid_times else '',latest_exact_utc=max(valid_times) if valid_times else '',
        duplicate_post_rows=original_post_count-len(posts),duplicate_comment_rows=original_comment_count-len(comments),
        start_date_bjt=start,end_date_bjt=end,stop_reason=state.get('stop_reason','not_recorded_in_legacy_export'),
        completeness='not_established',parse_errors=len(errors))
    coverage['runtime_time_mismatches']=sum(p.get('runtime_import_time_consistency')=='mismatch_requires_review' for p in posts)
    coverage['date_window_stop_status']=state.get('date_window_stop_status','not_recorded_legacy')
    coverage['automatically_skipped_posts']=len(state.get('supervisor_skipped_keys',[]))
    coverage['supervisor_recovery_count']=state.get('supervisor_recovery_count',0)
    write_csv(out/'coverage.csv',[coverage],list(coverage))
    write_csv(out/'run_state.csv',[{k:json.dumps(v,ensure_ascii=False) if isinstance(v,(dict,list)) else v for k,v in state.items()}] if state else [],list(state) or ['run_id','status','stop_reason'])
    (out/'logs').mkdir()
    write_csv(out/'logs/import_log.csv',state.get('logs',[])+errors,['at_utc','action','detail'])
    metrics=('like_count','reaction_count','comment_count','share_count','view_count','play_count')
    report=f"# Facebook 数据验证报告\n\n发现资源：{coverage['discovered_unique_resources']}；保存帖子：{len(posts)}；区间内：{coverage['in_range']}；日期待核验：{coverage['date_pending']}；区间外：{coverage['out_of_range']}；评论：{len(comments)}。\n\n"
    if coverage['saved_prior_observations']:
        report+=f"本批另保留{coverage['saved_prior_observations']}条此前尝试的原始观察。帖子按ID去重选择当前保留的整条观察，不取指标最大值；评论按帖子与评论ID跨观察去重，可能来自不同采集时刻，来源角色和采集时间分别保留。\n\n"
    report+='posts.csv为全部规范化观察；期间统计仅使用posts_in_range.csv，不能以posts.csv行数作为期间发布量。\n\n|指标|有值条数|缺失比例|\n|---|---:|---:|\n'
    for field in metrics:
        count=sum(p.get(field,'')!='' for p in posts)
        report+=f"|{field}|{count}/{len(posts)}|{(len(posts)-count)/len(posts):.1%}|\n" if posts else f"|{field}|0/0|不适用|\n"
    assumed_times=sum(p['publication_time_status']=='full_display_date_user_assumed_BJT_not_platform_verified' for p in posts)
    report+=f"\n最早归一化UTC：{coverage['earliest_exact_utc'] or '未取得'}；最晚归一化UTC：{coverage['latest_exact_utc'] or '未取得'}。其中{assumed_times}帖依据用户指定的北京时间解释完整显示日期，平台时区未经独立核验。\n\n停止原因：{coverage['stop_reason']}。完整性未建立；全部评论排序不等于已取得全部分页与回复，计数一致也不是完整性的唯一证据。\n\n"
    report+='原始文件未修改。like_count按研究约定记录帖子互动栏显示数（可能包含多种反应），纯赞细分另存like_reaction_type_count。share_count仅在同帖唯一的数字点赞、数字评论、分享控件顺序完整且分享计数空白时推定为0，并保留inferred_zero状态；其他缺失不补0。浏览与播放分开。新旧来源数值分别保留，明确详情标签优先用于当前观察，不取最大值。日期无年份或时区依据时待核验。本批仅凭功能样本不能满足正式年度发布量与全部评论覆盖要求；须继续核验真实菜单、时间来源和历史加载。\n'
    (out/'validation_report.md').write_text(report,encoding='utf-8')
    write_csv(out/'provenance.csv',[dict(source_file=source.name,
        sha256=hashlib.sha256(source.read_bytes()).hexdigest(), importer_version=IMPORTER_VERSION, imported_at_utc=datetime.now(timezone.utc).isoformat(),
        imported_posts=len(posts), saved_visible_comments=len(comments), exact_publication_times_verified=sum(bool(p['exact_publish_time_utc']) and p['publication_time_status']!='full_display_date_user_assumed_BJT_not_platform_verified' for p in posts),
        comment_completeness='not_established',note='Import is not a new platform collection; blanks are not zeros')],
        ['source_file','sha256','importer_version','imported_at_utc','imported_posts','saved_visible_comments','exact_publication_times_verified','comment_completeness','note'])
    print('Imported posts:',len(posts),'visible comments:',len(comments),'output:',out)
    return out


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source',type=Path)
    parser.add_argument('--output-dir',type=Path,help='创建批次目录的父目录')
    args=parser.parse_args()
    convert(args.source,args.output_dir)
