"""Offline import and conservative normalization of Instagram DOM evidence."""
import argparse
import csv
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
import re
from instagram_parse import normalize, VERSION, METRICS, VERIFIED_IDENTITIES

ROOT = Path(__file__).resolve().parent
SCHEMA = 'instagram_dom_diagnostic_v1'
COLUMNS = ['schema', 'username', 'page_url', 'collected_at_utc', 'snapshot_json']


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('timestamp_timezone_required')
    return parsed.astimezone(timezone.utc)


def validate_snapshot(snapshot, account):
    if snapshot.get('schema') != SCHEMA or snapshot.get('username') != account['username']:
        raise ValueError('schema_or_account_mismatch')
    timestamp(snapshot['collected_at_utc'])
    page = urlsplit(snapshot['page_url'])
    if (page.scheme != 'https' or page.hostname != 'www.instagram.com'
            or page.netloc != 'www.instagram.com' or page.query or page.fragment):
        raise ValueError('invalid_page_url')
    if snapshot.get('page_kind') == 'profile':
        if page.path.rstrip('/') != '/' + account['username'] or snapshot.get('shortcode'):
            raise ValueError('profile_identity_mismatch')
    elif snapshot.get('page_kind') == 'post':
        match = re.fullmatch(r'/(?:(?:[A-Za-z0-9._]+)/)?(?:p|reel|reels)/([A-Za-z0-9_-]+)/?', page.path)
        if not match or match[1] != snapshot.get('shortcode'):
            raise ValueError('post_identity_mismatch')
        if not any(urlsplit(link.get('url', '')).path.rstrip('/') == '/' + account['username']
                   and urlsplit(link.get('url', '')).netloc == 'www.instagram.com'
                   for link in snapshot.get('links', [])):
            raise ValueError('target_link_missing')
    else:
        raise ValueError('unsupported_page_kind')
    if (snapshot.get('status') != 'diagnostic_only' or snapshot.get('history_complete') is not False
            or snapshot.get('metrics_status') != 'not_mapped' or snapshot.get('comments_status') != 'not_parsed'):
        raise ValueError('unsupported_collection_status')
    if not isinstance(snapshot.get('visible_text'), str) or len(snapshot['visible_text']) > 100000:
        raise ValueError('invalid_visible_text')
    for name, limit in [('links',1000), ('times',200), ('controls',400)]:
        if not isinstance(snapshot.get(name), list) or len(snapshot[name]) > limit:
            raise ValueError('invalid_evidence_list_' + name)
    for name,limit in [('comment_evidence',400),('metric_evidence',30)]:
        if name in snapshot and (not isinstance(snapshot[name],list) or len(snapshot[name])>limit):
            raise ValueError('invalid_evidence_list_'+name)
    for evidence in snapshot.get('comment_evidence',[]):
        link = urlsplit(evidence.get('source_url',''))
        match = re.fullmatch(r'/(?:(?:[A-Za-z0-9._]+)/)?(?:p|reel|reels)/([A-Za-z0-9_-]+)(?:/c/(\d+))?/?',link.path)
        comment_id = evidence.get('comment_id','')
        if (link.scheme!='https' or link.netloc not in ('www.instagram.com','instagram.com') or not match
                or match[1]!=snapshot.get('shortcode') or not re.fullmatch(r'\d+',comment_id)
                or comment_id!=(match[2] or parse_qs(link.query).get('comment_id',[''])[0])
                or (evidence.get('parent_comment_id') and not re.fullmatch(r'\d+',evidence['parent_comment_id']))
                or len(evidence.get('text',''))>5000):
            raise ValueError('invalid_comment_identity_evidence')
    return snapshot


def load_capture(source):
    if source.stat().st_size > 20000000:
        raise ValueError('capture_exceeds_20MB_budget')
    accounts = json.loads((ROOT / 'instagram_accounts.json').read_text(encoding='utf-8'))
    by_name = {a['username']: a for a in accounts}
    csv.field_size_limit(10000000)
    rows = []
    with source.open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != COLUMNS:
            raise ValueError('unsupported_csv_columns')
        for row in reader:
            if row['username'] not in by_name or None in row or any(value is None for value in row.values()):
                raise ValueError('invalid_csv_record')
            snapshot = validate_snapshot(json.loads(row['snapshot_json']), by_name[row['username']])
            if any(row[key] != snapshot[key] for key in COLUMNS[:-1]):
                raise ValueError('csv_and_snapshot_mismatch')
            rows.append((by_name[row['username']], row))
    if not rows or len(rows) > 250 or len({a['key'] for a, _ in rows}) != 1:
        raise ValueError('expected_1_to_250_snapshots_for_one_account')
    return rows


def write_csv(path, rows, fields=None):
    with path.open('w', encoding='utf-8-sig', newline='') as stream:
        columns = list(dict.fromkeys(key for row in rows for key in row)) if rows else fields
        if not columns:
            raise ValueError('empty_csv_requires_columns')
        writer = csv.DictWriter(stream, fieldnames=columns)
        writer.writeheader()
        readable = path.name in {'posts.csv','post_observations.csv','posts_in_range.csv','out_of_range.csv',
                                 'date_pending.csv','comments.csv','comments_in_range.csv','comments_with_ids.csv','account_profile.csv','skipped_posts.csv'}
        safe = lambda v: "'"+v if isinstance(v,str) and re.match(r'^\s*[=+@-]',v) else v
        writer.writerows(({k:safe(v) for k,v in row.items()} if readable else row) for row in rows)


def import_capture(source, output_root=None):
    sources = [Path(item) for item in source] if isinstance(source,(list,tuple)) else [Path(source)]
    if not sources or sum(item.stat().st_size for item in sources)>220000000:
        raise ValueError('combined_capture_budget_exceeded')
    if len({item.name for item in sources})!=len(sources):
        raise ValueError('duplicate_input_filename')
    captures = [capture for item in sources for capture in load_capture(item)]
    if len({a['key'] for a,_ in captures})!=1:
        raise ValueError('combined_capture_account_mismatch')
    account = captures[0][0]
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '_diagnostic_import'
    result_root = (Path(output_root).resolve() if output_root is not None
                   else ROOT / 'outputs' / account['username'])
    destination = result_root / run_id
    destination.mkdir(parents=True, exist_ok=False)
    base = dict(entity=account['entity'], platform='instagram', account_key=account['key'], account_language='und')
    write_csv(destination / 'page_evidence.csv', [dict(base, **row) for _, row in captures])
    raw_dir = destination / 'raw_data'
    raw_dir.mkdir()
    for item in sources:
        (raw_dir / item.name).write_bytes(item.read_bytes())
    write_csv(destination / 'provenance.csv', [dict(source_filename=item.name,
        source_sha256=hashlib.sha256(item.read_bytes()).hexdigest(), importer_version=VERSION, run_id=run_id) for item in sources])
    profiles, observations, comments, discoveries = [], [], [], []
    collections = []
    exported_runs = {}
    for index, (_, row) in enumerate(captures):
        snapshot = json.loads(row['snapshot_json'])
        parsed = normalize(snapshot, account, index)
        if snapshot.get('collection'):
            collections.append(dict(snapshot_index=index,collection_json=json.dumps(snapshot['collection'],ensure_ascii=False),
                collection_result_json=json.dumps(snapshot.get('collection_result',{}),ensure_ascii=False)))
        state = snapshot.get('run_state_at_export')
        if isinstance(state,dict) and state.get('username')==account['username'] and state.get('run_id'):
            exported_runs[state['run_id']] = state
        for target, result in zip([profiles,observations,comments,discoveries],parsed):
            target.extend(result)
    # Preserve each snapshot; latest observation per shortcode only in posts.csv.
    latest = {}
    quality = lambda row: (100 * (row['identity_status'] in VERIFIED_IDENTITIES)
                           + 10 * bool(row['created_at_utc']) + 10 * bool(row['caption'])
                           + sum(row[field]!='' for field in ('like_count','comment_count','view_count','play_count')))
    for row in sorted(observations,key=lambda r:r['collected_at_utc']):
        old = latest.get(row['content_id'])
        if old is None or quality(row)>=quality(old):
            latest[row['content_id']] = row
    posts = list(latest.values())
    verified = [r for r in posts if r['identity_status'] in VERIFIED_IDENTITIES]
    in_range = [r for r in verified if r['period_status']=='in_range']
    outside = [r for r in verified if r['period_status']=='out_of_range']
    pending = [r for r in posts if r not in in_range and r not in outside]
    post_fields = list(posts[0]) if posts else ['content_id','content_url','period_status','identity_status']
    comment_fields = list(comments[0]) if comments else ['content_id','comment_id','parent_comment_id','body','relation_status']
    for name, rows, fields in [
        ('account_profile.csv',profiles,['account_key','follower_count','follower_count_status']),
        ('posts.csv',posts,post_fields),('post_observations.csv',observations,post_fields),
        ('posts_in_range.csv',in_range,post_fields),('out_of_range.csv',outside,post_fields),
        ('date_pending.csv',pending,post_fields),('comments.csv',comments,comment_fields),
        ('comments_in_range.csv',[r for r in comments if r['content_period_status']=='in_range'],comment_fields),
        ('discoveries.csv',discoveries,['shortcode','content_url','discovery_status'])]:
        write_csv(destination / name,rows,fields)
    unique_comments = {}
    for comment in sorted(comments,key=lambda r:r['collected_at_utc']):
        if comment['comment_id']:
            unique_comments[(comment['content_id'],comment['comment_id'])] = comment
    write_csv(destination / 'comments_with_ids.csv',list(unique_comments.values()),comment_fields)
    coverage = []
    for kind, rows, metrics in [('account',profiles,['follower_count','following_count','total_post_count']),
                               ('post',posts,METRICS),('comment_observation',comments,['like_count'])]:
        for field in metrics:
            coverage.append(dict(resource_type=kind,field=field,observations=len(rows),
                observed=sum(r.get(field+'_status')=='observed' for r in rows),
                explicit_zero=sum(r.get(field+'_status')=='explicit_zero' for r in rows),
                missing=sum(r.get(field+'_status')=='missing' for r in rows),
                note='本批次页面证据；不代表平台全部可得性或年度覆盖'))
    write_csv(destination / 'field_coverage.csv',coverage)
    if collections:
        write_csv(destination / 'collection_evidence.csv',collections)
    if exported_runs:
        write_csv(destination / 'skipped_posts.csv', [dict(auto_run_id=state['run_id'],content_id=code,
            content_url=failure.get('url',''),reason=failure.get('reason',''),skipped_at=failure.get('at',''),
            evidence_json=json.dumps(failure.get('evidence',{}),ensure_ascii=False))
            for state in exported_runs.values() for code,failure in state.get('skipped',{}).items()],
            ['auto_run_id','content_id','content_url','reason','skipped_at','evidence_json'])
        write_csv(destination / 'automatic_runs.csv',[dict(auto_run_id=state['run_id'],status=state.get('status',''),
            stop_reason=state.get('stop_reason',''),done_post_count=len(state.get('done',[])),
            batch_number=state.get('batch_number',1),target_done=state.get('target_done',10),
            current_batch_done=len(state.get('done',[]))-state.get('batch_start_done',0),
            scrolls_used=state.get('scrolls_used',''),expansions_used=state.get('expansions_used',''),
            resume_count=state.get('resume_count',''),skipped_post_count=len(state.get('skipped',{})),history_complete=False,
            state_json=json.dumps(state,ensure_ascii=False)) for state in exported_runs.values()])
    discovered_codes = {r['shortcode'] for r in discoveries}
    write_csv(destination / 'run_status.csv', [dict(base, run_id=run_id, status='partial_sample_normalized',
        snapshot_count=len(captures),discovered_unique_links=len(discovered_codes),
        normalized_post_count=len(posts),verified_post_count=len(verified),in_range=len(in_range),
        out_of_range=len(outside),date_or_identity_pending=len(pending),
        saved_comment_observations=len(comments),unique_comment_count=len(unique_comments) if unique_comments else '',
        verified_reply_count=sum(bool(r['parent_comment_id']) for r in unique_comments.values()) if unique_comments else '',
        comments_coverage='partial_observations_with_optional_public_ids',
        history_complete=False,coverage='current_rendered_page_only',
        reason='formal_run_history_and_comment_completeness_unverified' if any(s.get('mode') in ('formal','comments') for s in exported_runs.values())
        else 'bounded_automatic_test_history_and_comment_completeness_unverified' if exported_runs
        else 'manual_diagnostic_export_no_history_or_comment_pagination_proof')])
    (destination / 'validation_report.md').write_text(
        '# Instagram真实页面样本核验\n\n'
        f'账号：{account["username"]}；采集快照{len(captures)}，列表唯一候选链接{len(discovered_codes)}，'
        f'保存唯一帖子{len(posts)}，其中页面证据核验归属{len(verified)}。'
        f'期间内{len(in_range)}，期间外{len(outside)}，日期/归属待核验{len(pending)}。\n\n'
        '以上日期数量仅针对已保存详情；列表候选无日期不能据此计入期间。'
        '研究窗口为北京时间2025-10-17至2026-10-17；机构归属仍仅据账号清单登记。\n\n'
        f'保存评论观察{len(comments)}条，其中有明确公开ID的唯一评论{len(unique_comments)}条，另存comments_with_ids.csv。'
        '缺少ID及关系证据时留空；观察哈希不冒充平台评论ID，不按同文强行合并。'
        '评论总数、分页、回复展开完整性尚未验证；回复按钮不代表存在一条回复。\n\n'
        '本轮基于用户导出的真实CSV核对，未重新访问在线页面。账号数值和帖子点赞仅按已确认的中文界面布局解析；'
        '不匹配的布局留空。粉丝缩写保留精度；缺少数值的分享/收藏按钮不填0。'
        '原始CSV在raw_data中保留，page_evidence.csv保留逐快照内容，provenance.csv记录校验和。\n\n'
        '本报告仅表示离线证据解析；类型、评论关系和历史覆盖应按本批实际字段与运行日志核查，不能据此认定年度完成。\n', encoding='utf-8')
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('csv_file', type=Path, nargs='+',help='同账号的一份或多份原始证据分段CSV')
    parser.add_argument("--output-dir", type=Path, help="创建批次目录的父目录")
    args = parser.parse_args()
    print(import_capture(args.csv_file, args.output_dir))
