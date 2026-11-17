"""Offline import of whitelisted TikTok page evidence; no network, cookies or API.

Video field mapping adapted from Pyktok generate_data_row (BSD-3-Clause).
Upstream: https://github.com/dfreelon/pyktok (src/pyktok/pyktok.py).
"""
import argparse
import csv
import hashlib
import json
import re
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from common import ROOT, BJT, accounts, instant, number
from collection_account import resolve_account
from readable_export import package_existing

VERSION = '0.4.0'
START, END = date(2025, 10, 17), date(2026, 10, 17)
METRICS = {'view_count':'playCount','like_count':'diggCount','comment_count':'commentCount',
           'share_count':'shareCount','favorite_count':'collectCount'}


def identity(url):
    parsed = urlsplit(url)
    match = re.fullmatch(r'/@([\w.]+)(?:/(video|photo)/(\d+))?/?', parsed.path)
    if parsed.scheme != 'https' or parsed.hostname not in ('www.tiktok.com','tiktok.com') or not match:
        raise ValueError('invalid_tiktok_page_url')
    return match[1], match[3] or '', 'https://www.tiktok.com' + parsed.path.rstrip('/')


def numeric(raw):
    value = number(raw)
    precision = 'rounded_display' if re.search(r'[KkMmBb万亿]', str(raw)) else 'exact_display_or_structured'
    return dict(raw='' if raw is None else raw, value='' if value is None else value,
                status='missing' if value is None else 'explicit_zero' if value == 0 else 'observed',
                precision='' if value is None else precision)


def timestamp(raw):
    parsed = instant(raw)
    return dict(time_raw='' if raw is None else raw, created_at_utc=parsed.isoformat() if parsed else '',
                created_at_bjt=parsed.astimezone(BJT).isoformat() if parsed else '',
                time_status='platform_timestamp' if parsed else 'exact_timestamp_unavailable',
                period_status='date_pending' if not parsed else 'in_range' if START <= parsed.astimezone(BJT).date() <= END else 'out_of_range')


def metric_columns(row, field, raw, locator):
    for suffix, value in numeric(raw).items():
        row[field if suffix == 'value' else field+'_'+suffix] = value
    row[field+'_source'] = locator
    row[field+'_missing_reason'] = 'not_available_from_captured_source' if row[field] == '' else ''


def parse_snapshot(snapshot):
    if snapshot.get('schema') != 'tiktok_page_probe_v1':
        raise ValueError('unsupported_capture_schema')
    username, rid, url = identity(snapshot['page_url'])
    if username.casefold() != snapshot.get('username','').casefold() or rid != snapshot.get('content_id',''):
        raise ValueError('capture_identity_mismatch')
    account = resolve_account('tiktok', username)
    observed = instant(snapshot.get('collected_at_utc'))
    if not observed:
        raise ValueError('capture_timestamp_missing_or_naive')
    method = snapshot.get('acquisition_method','chrome_extension')
    if method not in ('chrome_extension','public_html_get','TikTokApi_public_list'):
        raise ValueError('unsupported_acquisition_method')
    base = dict(entity=account['entity'],platform='tiktok',account_key=account['key'],account_language=account['language'],
                username=username,source={'public_html_get':'public_html_get','TikTokApi_public_list':'tiktok_public_list'}.get(method,'chrome_tiktok_page'),collected_at_utc=observed.isoformat(),
                collected_at_bjt=observed.astimezone(BJT).isoformat(),start_date_bjt=START.isoformat(),end_date_bjt=END.isoformat(),version=VERSION)
    profiles, posts, comments, discoveries = [], [], [], []
    if snapshot.get('status') in ('private_account_stop','login_or_verification_required'):
        return account, profiles, posts, comments, discoveries
    profile = snapshot.get('profile',{})
    user, stats, visible = profile.get('user',{}), profile.get('stats',{}), profile.get('visible',{})
    profile_identity = user.get('uniqueId') or visible.get('username') or ''
    if profile_identity.strip().lstrip('@').casefold() == username.casefold():
        profile_observed = instant(profile.get('collected_at_utc', snapshot.get('collected_at_utc')))
        if not profile_observed or profile_observed > observed:
            raise ValueError('invalid_profile_observation_time')
        profile_base = dict(base, collected_at_utc=profile_observed.isoformat(), collected_at_bjt=profile_observed.astimezone(BJT).isoformat())
        if profile.get('source') in ('public_html_get','tiktok_public_list'):
            profile_base['source'] = profile['source']
        row = dict(profile_base,profile_url=account['url'],account_id=user.get('id',''),display_name=user.get('nickname') or visible.get('display_name') or '',
                   ownership_status='not_independently_verified',source_locator=profile.get('source_locator','visible_profile_controls'))
        bio = user.get('signature')
        if not isinstance(bio,str):
            bio = visible.get('bio_raw')
        row.update(bio=bio if isinstance(bio,str) else '',
                   bio_status='observed_empty' if bio=='' else 'observed' if isinstance(bio,str) else 'missing',
                   bio_source=profile.get('source_locator','visible_profile_controls')+'.signature',
                   bio_missing_reason='' if isinstance(bio,str) else 'not_available_from_captured_source')
        verified=user.get('verified')
        row.update(is_verified=verified if isinstance(verified,bool) else '',
                   verification_status='verified' if verified is True else 'not_verified' if verified is False else 'missing',
                   verification_raw=json.dumps(verified) if isinstance(verified,bool) else '',
                   verification_source=profile.get('source_locator','visible_profile_controls')+'.verified',
                   verification_missing_reason='' if isinstance(verified,bool) else 'not_available_from_captured_source')
        for field, key, fallback in [('follower_count','followerCount','follower_count_raw'),('following_count','followingCount','following_count_raw'),('total_likes','heartCount','total_likes_raw'),('total_video_count','videoCount','total_video_count_raw')]:
            metric_columns(row,field,stats[key] if key in stats else visible.get(fallback),profile.get('source_locator','visible_profile_controls')+'.'+key)
        profiles.append(row)
    seen = set()
    for link in snapshot.get('links',[]):
        author, content_id, content_url = identity(link['content_url'])
        if author.casefold() != username.casefold() or not content_id or content_id != str(link.get('content_id')):
            raise ValueError('discovered_link_account_or_id_mismatch')
        if content_id not in seen:
            seen.add(content_id)
            discoveries.append(dict(base,content_id=content_id,content_url=content_url,content_type=link.get('content_type',''),
                                    text_raw=link.get('text',''),aria_label_raw=link.get('aria_label',''),period_status='date_pending',source_locator='visible_profile_video_link'))
    candidates = snapshot.get('items',[])
    # Prefer the current hydration schema; do not mix/max counts from two structures.
    candidates = sorted(candidates,key=lambda v: v.get('script') != '__UNIVERSAL_DATA_FOR_REHYDRATION__')
    accepted = False
    for candidate in candidates:
        item = candidate.get('item',{})
        author = item.get('author',{})
        author = author if isinstance(author,dict) else {'uniqueId':author}
        if not rid or str(item.get('id')) != rid or author.get('uniqueId','').casefold()!=username.casefold():
            raise ValueError('structured_video_identity_mismatch')
        if accepted:
            continue
        accepted = True
        row = dict(base,content_id=rid,content_url=url,content_type='photo' if '/photo/' in url else 'video',
                   description=item.get('desc',''),hashtags_raw=json.dumps(item.get('textExtra',[]),ensure_ascii=False),
                   author_id=author.get('id',''),source_locator=candidate.get('script',''),**timestamp(item.get('createTime')))
        extras=item.get('textExtra')
        tags=list(dict.fromkeys(tag['hashtagName'] for tag in extras if isinstance(tag,dict) and isinstance(tag.get('hashtagName'),str) and tag['hashtagName'])) if isinstance(extras,list) else []
        row.update(hashtags=json.dumps(tags,ensure_ascii=False),
                   hashtags_status='observed' if tags else 'observed_empty' if isinstance(extras,list) else 'missing',
                   hashtags_source=candidate.get('script','')+'.itemStruct.textExtra[].hashtagName')
        stats_key = 'statsV2' if item.get('statsV2') else 'stats'
        metrics = item.get(stats_key,{})
        for field, key in METRICS.items():
            metric_columns(row,field,metrics.get(key),candidate.get('script','')+'.itemStruct.'+stats_key+'.'+key)
        row['comments_capture_status'] = 'not_collected_by_scope'
        # Save only selected public video fields, never the whole page/session.
        row['raw_video_json'] = json.dumps({k:item[k] for k in ('id','createTime','desc','author','stats','statsV2','textExtra','video','isAd') if k in item},ensure_ascii=False)
        posts.append(row)
    if accepted and snapshot.get('comments_status') != 'not_collected_by_scope':
        for i, comment in enumerate(snapshot.get('comments',[])):
            text = comment.get('text','')
            if not text:
                continue
            author_url = comment.get('author_url','')
            if author_url:
                identity(author_url)
            cid = str(comment.get('comment_id') or '')
            # A capture-local key is explicitly not a platform comment ID.
            local = hashlib.sha256(f'{rid}\0{observed.isoformat()}\0{i}\0{text}'.encode()).hexdigest()[:24]
            row = dict(base,content_id=rid,content_url=url,comment_id=cid,parent_comment_id=comment.get('parent_comment_id',''),
                       observation_key=local,author_url=author_url,text=text,is_reply=comment.get('is_reply',False),
                       relationship_status=comment.get('relationship_status','unverified'),source_locator='loaded_comment_DOM',
                       **timestamp(comment.get('time_raw')))
            row['comment_id_status'] = 'platform_dom_attribute' if cid else 'unavailable_capture_local_key_only'
            metric_columns(row,'like_count',comment.get('like_count_raw'),'loaded_comment_DOM')
            comments.append(row)
    return account, profiles, posts, comments, discoveries


def write_csv(path, rows, fields=()):
    fields = list(dict.fromkeys([*fields,*(key for row in rows for key in row)]))
    with path.open('w',encoding='utf-8-sig',newline='') as stream:
        writer=csv.DictWriter(stream,fieldnames=fields);writer.writeheader();writer.writerows(rows)


def import_file(source, output_dir=None):
    source = Path(source).resolve()
    with source.open(encoding='utf-8-sig',newline='') as stream:
        snapshots = json.load(stream) if source.suffix.lower()=='.json' else [json.loads(row['payload']) for row in csv.DictReader(stream)]
    if not isinstance(snapshots,list):
        raise ValueError('expected_snapshot_array')
    if not snapshots:
        raise ValueError('empty_capture')
    parsed = [(s,parse_snapshot(s)) for s in snapshots]  # Validate all before writing research output.
    keys = {p[0]['key'] for _, p in parsed}
    if len(keys) != 1:
        raise ValueError('import_one_account_at_a_time_export_separate_accounts')
    account = parsed[0][1][0]
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    parent = Path(output_dir).resolve() if output_dir is not None else ROOT/'outputs'/'tiktok'/account['language']/account['key']
    target = parent/(stamp+'_page_import')
    target.mkdir(parents=True)
    groups = [[],[],[],[]]
    for _, result in parsed:
        for group, rows in zip(groups,result[1:]):
            group.extend(rows)
    for name, rows in zip(['account_profile.csv','posts.csv','comments.csv','discovery.csv'],groups):
        write_csv(target/name,rows,['account_key','content_id'])
    write_csv(target/'follower_snapshots.csv',[
        {key:row.get(key,'') for key in ('account_key','platform','username','account_id','profile_url',
         'follower_count','follower_count_raw','follower_count_status','follower_count_precision','follower_count_source',
         'follower_count_missing_reason','collected_at_utc','collected_at_bjt','source','version')} for row in groups[0]],
         ['account_key','follower_count','collected_at_utc'])
    latest={}
    for row in groups[0]:
        if row['account_key'] not in latest or row['collected_at_utc'] > latest[row['account_key']]['collected_at_utc']:
            latest[row['account_key']]=row
    write_csv(target/'account_profile_latest.csv',list(latest.values()),['account_key','bio','bio_status','is_verified','verification_status','follower_count','collected_at_utc'])
    posts = groups[1]
    latest_posts={}
    for row in posts:
        if row['content_id'] not in latest_posts or row['collected_at_utc'] > latest_posts[row['content_id']]['collected_at_utc']:
            latest_posts[row['content_id']]=row
    write_csv(target/'posts_latest.csv',list(latest_posts.values()),['content_id','content_url','created_at_bjt'])
    write_csv(target/'posts_in_range.csv',[p for p in latest_posts.values() if p['period_status']=='in_range'],['content_id','content_url','created_at_bjt'])
    write_csv(target/'posts_out_of_range.csv',[p for p in latest_posts.values() if p['period_status']=='out_of_range'],['content_id','content_url','created_at_bjt'])
    fields = []
    for field,status_field in [('bio','bio_status'),('verification','verification_status'),('follower_count','follower_count_status')]:
        states=[p[status_field] for p in groups[0]]
        fields.append(dict(field=field,observed=sum(s in ('observed','verified','not_verified') for s in states),
                           observed_empty=states.count('observed_empty'),explicit_zero=states.count('explicit_zero'),
                           inferred_zero=0,missing=states.count('missing')))
    for field in METRICS:
        fields.append(dict(field=field,observed=sum(p[field+'_status']=='observed' for p in posts),
                           explicit_zero=sum(p[field+'_status']=='explicit_zero' for p in posts),inferred_zero=0,
                           missing=sum(p[field+'_status']=='missing' for p in posts)))
    write_csv(target/'field_coverage.csv',[dict(row,basis='all_captured_observations_not_period_totals') for row in fields])
    write_csv(target/'run_status.csv',[dict(account_key=account['key'],status='bounded_page_import',snapshots=len(snapshots),
        unique_content_saved=len({p['content_id'] for p in posts}),post_observations=len(posts),comments_saved=len(groups[2]),
        exact_in_range_unique=len({p['content_id'] for p in posts if p['period_status']=='in_range'}),
        out_of_range_observations=sum(p['period_status']=='out_of_range' for p in posts),
        date_pending_observations=sum(p['period_status']=='date_pending' for p in posts),
        source_statuses=json.dumps([s.get('status') for s in snapshots]),history_complete=False,
        comments_complete=False,stop_reason='explicit_video_url_budget' if all(s.get('acquisition_method')=='public_html_get' for s in snapshots) else 'manual_snapshot_budget',version=VERSION)])
    write_csv(target/'provenance.csv',[dict(source_file=source.name,source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        snapshot_index=i,page_url=s['page_url'],collected_at_utc=s['collected_at_utc'],
        raw_selected_payload=json.dumps(s,ensure_ascii=False)) for i,s in enumerate(snapshots)])
    (target/'validation_report.md').write_text(f'# TikTok页面导入 v{VERSION}\n\n账号：{account["url"]}；登记语种：{account["language"]}。\n\n'
        f'视频唯一ID {len({p["content_id"] for p in posts})}，视频观察记录 {len(posts)}，已加载评论 {len(groups[2])}。\n\n'
        '固定北京时间窗口：2025-10-17至2026-10-17。区间外记录保留并标记，不进入期间总量；日期不明不猜年份。\n\n'
        '当前范围为账号简介/认证、粉丝快照、视频链接/时间/正文/标签及互动数；评论与回复正文不采集，标记not_collected_by_scope。旧批次原文记录不删除。\n\n'
        '这是当前页面有界快照，不代表全年历史完整。简介明确空值与缺失分开；认证false保存未认证，不当作缺失；粉丝每次观察独立留存。\n\n'
        'statsV2存在时优先整组使用，否则使用stats；不拼接两种来源的最大数。缺失不填0。每项保留来源、原值、精度和状态。\n',encoding='utf-8')
    return package_existing(target, groups[0], posts)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description='离线导入旧版 TikTok 页面探针 CSV 或 JSON 数组；不联网')
    parser.add_argument('source',type=Path)
    parser.add_argument('--output-dir',type=Path,help='创建批次目录的父目录')
    args=parser.parse_args()
    print(import_file(args.source,args.output_dir))
