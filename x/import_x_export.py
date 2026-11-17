"""Offline X public-data import. No cookies, login, private lists or reply harvesting.

Field paths follow prinsss/twitter-web-exporter (MIT); see chrome_x_probe/THIRD_PARTY_NOTICES.md.
Only metadata-bearing JSON is accepted: formatted CSV loses field provenance.
"""
import argparse
import csv
import hashlib
import json
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

PROJECT = Path(__file__).resolve().parent
from common import BJT, instant, number
from collection_account import resolve_account
from readable_export import package_existing

VERSION = '0.3.0'
TARGET = 'Echinanews'
START, END = '2025-10-17', '2026-10-17'


def get(obj, path, default=None):
    for key in path.split('.'):
        if not isinstance(obj, dict) or key not in obj:
            return default
        obj = obj[key]
    return obj


def first(obj, *paths):
    for path in paths:
        value = get(obj, path)
        if value is not None:
            return value, path
    return None, ''


def json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def utc(raw):
    value = instant(raw)
    if value:
        return value
    try:
        value = parsedate_to_datetime(raw)
        return value.astimezone(timezone.utc) if value.tzinfo else None
    except (TypeError, ValueError, OverflowError):
        return None


def metric(row, name, raw, source):
    value = number(raw)
    row.update({name: '' if value is None else value, name+'_raw': '' if raw is None else raw,
                name+'_source': source, name+'_status': 'missing' if value is None else 'explicit_zero' if value == 0 else 'observed',
                name+'_precision': '' if value is None else 'rounded_display' if re.search(r'[KkMmBb万亿]', str(raw)) else 'exact_structured',
                name+'_missing_reason': 'not_returned_or_invalid' if value is None else ''})


def unwrap(obj):
    if isinstance(obj, dict) and obj.get('__typename') == 'TweetWithVisibilityResults':
        return obj.get('tweet', {})
    return obj


def username(user):
    return first(user, 'core.screen_name', 'legacy.screen_name')[0]


def identity(value, label):
    if not isinstance(value, str) or not value.isdecimal():
        raise ValueError(label+'_missing_or_not_string_id')
    return value


def base(observed, source, account=None):
    account = resolve_account('x', account or TARGET) if not isinstance(account, dict) else account
    return dict(entity=account['entity'], entity_assignment_source='account_configuration', platform='x',
                account_key=account['key'], account_language=account['language'], username=account['username'],
                ownership_status='not_independently_verified', source=source, version=VERSION,
                collected_at_utc=observed.isoformat(), collected_at_bjt=observed.astimezone(BJT).isoformat(),
                start_date_bjt=START, end_date_bjt=END)


def profile(user, common):
    if str(username(user) or '').casefold() != common['username'].casefold():
        return None
    row = dict(common, account_id=identity(user.get('rest_id'), 'account_id'),
               profile_url='https://x.com/'+common['username'], display_name=first(user, 'core.name', 'legacy.name')[0] or '')
    bio, path = first(user, 'profile_bio.description', 'legacy.description')
    row.update(bio=bio if isinstance(bio, str) else '', bio_source=path,
               bio_status='observed_empty' if bio == '' else 'observed' if isinstance(bio, str) else 'missing')
    flags = {p: get(user, p) for p in ('verification.is_blue_verified', 'is_blue_verified', 'verification.verified_type', 'verification.verified', 'legacy.verified') if get(user, p) is not None}
    current = first(user, 'verification.is_blue_verified', 'is_blue_verified')[0]
    kind = flags.get('verification.verified_type')
    # A legacy checkmark cannot establish the current badge status.
    verified = True if current is True or kind in ('Blue', 'Business', 'Government', 'blue', 'business', 'government') else False if current is False and kind in ('', None) else ''
    row.update(is_verified=verified, verification_type=kind or '', verification_raw=json_text(flags),
               verification_status='missing' if verified == '' else 'verified' if verified else 'not_verified')
    for field, paths in [('follower_count', ('relationship_counts.followers', 'legacy.followers_count')),
                         ('following_count', ('relationship_counts.following', 'legacy.friends_count')),
                         ('total_post_count', ('tweet_counts.tweets', 'legacy.statuses_count'))]:
        value, path = first(user, *paths)
        metric(row, field, value, path)
    return row


def post(obj, common):
    obj = unwrap(obj)
    author = get(obj, 'core.user_results.result', {})
    name = username(author)
    if not name:
        raise ValueError('post_author_missing')
    if name.casefold() != common['username'].casefold():
        return None  # Linked originals and other people's replies are not account publications.
    pid = identity(first(obj, 'rest_id', 'legacy.id_str')[0], 'post_id')
    raw_date, date_path = first(obj, 'details.created_at_ms', 'legacy.created_at')
    try:
        created = datetime.fromtimestamp(int(raw_date)/1000, timezone.utc) if date_path == 'details.created_at_ms' else utc(raw_date)
    except (ValueError, TypeError, OverflowError, OSError):
        created = None
    if not created:
        raise ValueError('post_'+pid+'_timestamp_missing_or_naive')
    text, text_path = first(obj, 'note_tweet.note_tweet_results.result.text', 'details.full_text', 'legacy.full_text')
    if not isinstance(text, str):
        raise ValueError('post_'+pid+'_full_text_missing')
    legacy = obj.get('legacy') or {}
    rt = unwrap(get(obj, 'legacy.retweeted_status_result.result', {})) or {}
    quote = unwrap(get(obj, 'quoted_status_result.result', {})) or {}
    rt_id = first(rt, 'rest_id', 'legacy.id_str')[0]
    quote_id = first(quote, 'rest_id', 'legacy.id_str')[0] or legacy.get('quoted_status_id_str')
    reply_id = legacy.get('in_reply_to_status_id_str')
    kind = 'repost' if rt_id else 'quote' if quote_id else 'reply' if reply_id else 'unclassified' if 'details' in obj else 'original'
    if 'retweeted_status_result' in legacy and not rt_id:
        kind = 'repost_unavailable'
    row = dict(common, content_id=pid, content_url='https://x.com/'+common['username']+'/status/'+pid,
               author_id=author.get('rest_id', ''), description=text, text_source=text_path,
               text_status='full_note_text' if text_path.startswith('note_tweet') else 'possibly_truncated_note' if obj.get('note_tweet') else 'source_full_text',
               created_at_raw=raw_date, time_source=date_path, created_at_utc=created.isoformat(), created_at_bjt=created.astimezone(BJT).isoformat(),
               period_status='in_range' if START <= created.astimezone(BJT).date().isoformat() <= END else 'out_of_range',
               post_type=kind, reposted_post_id=rt_id or '', quoted_post_id=quote_id or '',
               in_reply_to_post_id=reply_id or '', comments_capture_status='not_collected_by_scope')
    # Repost metrics normally describe the original, not the wrapper's own performance.
    subject = rt if rt_id else obj
    row['metrics_subject_id'] = rt_id or pid
    row['metrics_relation'] = 'original_of_repost' if rt_id else 'self'
    for field, paths in [('like_count', ('counts.favorite_count', 'legacy.favorite_count')),
                         ('reply_count', ('counts.reply_count', 'legacy.reply_count')),
                         ('repost_count', ('counts.retweet_count', 'legacy.retweet_count')),
                         ('quote_count', ('counts.quote_count', 'legacy.quote_count')),
                         ('bookmark_count', ('counts.bookmark_count', 'legacy.bookmark_count')),
                         ('view_count', ('views.count',))]:
        value, path = first(subject, *paths)
        metric(row, field, value, ('retweeted_post.' if rt_id else '')+path)
    for prefix, related in [('reposted', rt), ('quoted', quote)]:
        related_user = get(related, 'core.user_results.result', {})
        related_name = username(related_user)
        related_id = first(related, 'rest_id', 'legacy.id_str')[0]
        row[prefix+'_post_url'] = 'https://x.com/'+related_name+'/status/'+related_id if related_name and related_id else ''
        row[prefix+'_created_at_raw'] = get(related, 'legacy.created_at', '')
    tags, tag_path = first(obj, 'note_tweet.note_tweet_results.result.entity_set.hashtags', 'details.hashtag_entities', 'legacy.entities.hashtags')
    # Legacy entities may be truncated when a note_tweet exists; report that uncertainty.
    tag_status = 'missing' if not isinstance(tags, list) else 'observed' if tags else 'observed_empty'
    if text_path.startswith('note_tweet') and tag_path.startswith('legacy'):
        tag_status = 'legacy_entities_may_be_partial'
    row.update(hashtags=json_text([x['text'] for x in tags if isinstance(x, dict) and isinstance(x.get('text'), str)]) if isinstance(tags, list) else '',
               hashtags_raw=json_text(tags) if isinstance(tags, list) else '', hashtags_status=tag_status, hashtags_source=tag_path)
    media = first(subject, 'media_entities2', 'legacy.extended_entities.media', 'legacy.entities.media')[0]
    row['media_types'] = json_text(list(dict.fromkeys(x['type'] for x in media if isinstance(x, dict) and isinstance(x.get('type'), str)))) if isinstance(media, list) else ''
    row['media_status'] = 'observed' if isinstance(media, list) else 'missing'
    # Multiple videos remain distinct; do not sum plays or substitute post views.
    row['video_play_counts'] = json_text([{'media_key': x.get('media_key'), 'view_count': get(x, 'public_metrics.view_count')} for x in media if isinstance(x, dict) and x.get('type') == 'video']) if isinstance(media, list) else ''
    return row


def write_csv(path, rows, required=()):
    fields = list(dict.fromkeys([*required, *(k for row in rows for k in row)]))
    with path.open('w', encoding='utf-8-sig', newline='') as out:
        writer = csv.DictWriter(out, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def import_file(source, observed_at=None, account_ref=None, output_parent=None):
    source = Path(source).resolve()
    raw = source.read_bytes()
    data = json.loads(raw.decode('utf-8-sig'))
    captured = data.get('collected_at_utc') if isinstance(data, dict) and data.get('schema') == 'x_public_sample_v1' else observed_at
    observed = utc(captured)
    if not observed:
        raise ValueError('capture_time_required_use_observed_at_with_timezone')
    records = data.get('objects') if isinstance(data, dict) else data
    if not isinstance(records, list):
        raise ValueError('expected_exporter_json_array_with_metadata_or_public_sample')
    profiles, posts, errors = [], [], []
    captured_account = resolve_account('x', data['page_url'].split('/status/')[0]) if isinstance(data, dict) and data.get('page_url') else None
    account = resolve_account('x', account_ref) if account_ref else captured_account
    if not account:
        raise ValueError('exporter_import_requires_account_argument')
    if captured_account and captured_account['username'].casefold() != account['username'].casefold():
        raise ValueError('capture_account_mismatch')
    common = base(observed, 'x_public_html_get' if isinstance(data, dict) else 'twitter_web_exporter_metadata', account)
    for index, record in enumerate(records):
        try:
            if not isinstance(record, dict):
                raise ValueError('record_not_object')
            obj = unwrap(record.get('metadata', record))
            if not isinstance(obj, dict):
                raise ValueError('metadata_not_object')
            typename = obj.get('__typename')
            if typename == 'User':
                row = profile(obj, common)
                if row:
                    profiles.append(row)
            elif typename == 'Tweet':
                row = post(obj, common)
                if row:
                    posts.append(row)
                    user = get(obj, 'core.user_results.result', {})
                    # Embedded author stubs are not complete follower snapshots.
                    if any(get(user, p) is not None for p in ('profile_bio.description', 'legacy.description', 'relationship_counts.followers', 'legacy.followers_count')):
                        p = profile(user, common)
                        if p:
                            profiles.append(p)
            else:
                raise ValueError('unsupported_record_enable_include_all_metadata')
        except (ValueError, TypeError, KeyError, AttributeError) as exc:
            errors.append(dict(record_index=index, error=str(exc), action='skip_and_continue'))
    # Keep distinct captures in separate directories; deduplicate only within this capture.
    best = {}
    def completeness(row):
        return (sum(row.get(k, '') != '' for k in ('like_count', 'reply_count', 'repost_count', 'quote_count', 'bookmark_count', 'view_count')),
                len(row.get('description', '')))
    for row in posts:
        if row['content_id'] not in best or completeness(row) > completeness(best[row['content_id']]):
            best[row['content_id']] = row
    posts = list(best.values())
    best_profiles = {}
    for row in profiles:
        quality = lambda r: sum(r.get(k, '') != '' for k in ('follower_count', 'following_count', 'total_post_count', 'is_verified')) + (r['bio_status'] != 'missing')
        if row['account_id'] not in best_profiles or quality(row) > quality(best_profiles[row['account_id']]):
            best_profiles[row['account_id']] = row
    profiles = list(best_profiles.values())
    target = (Path(output_parent).resolve() if output_parent is not None else PROJECT/'outputs')/('import_'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    target.mkdir(parents=True)
    write_csv(target/'account_profile.csv', profiles, ['account_key', 'account_id', 'bio', 'is_verified', 'follower_count'])
    follower_fields = ['account_key', 'account_id', 'username', 'follower_count', 'follower_count_raw', 'follower_count_source', 'follower_count_status', 'follower_count_precision', 'collected_at_utc', 'collected_at_bjt', 'source', 'version']
    write_csv(target/'follower_snapshots.csv', [{k: row.get(k, '') for k in follower_fields} for row in profiles], follower_fields)
    write_csv(target/'posts.csv', posts, ['account_key', 'content_id'])
    for period in ('in_range', 'out_of_range'):
        write_csv(target/('posts_'+period+'.csv'), [row for row in posts if row['period_status'] == period], ['account_key', 'content_id'])
    write_csv(target/'errors.csv', errors, ['record_index', 'error', 'action'])
    write_csv(target/'provenance.csv', [dict(source_path=source.name, source_sha256=hashlib.sha256(raw).hexdigest(), source_method=common['source'], collected_at_utc=observed.isoformat(), version=VERSION)])
    status = 'partial_parse' if errors else 'post_sample_imported' if posts else 'profile_only_no_posts' if profiles else 'no_target_data'
    write_csv(target/'coverage.csv', [dict(status=status, account_rows=len(profiles), post_rows=len(posts), skipped_rows=len(errors),
              in_range=sum(row['period_status'] == 'in_range' for row in posts), complete_history_verified=False,
              input_capture_status=data.get('status', '') if isinstance(data, dict) else 'exporter_file',
              stop_reason='end_of_supplied_capture_not_verified_end_of_history', comments='not_collected_by_scope')])
    return package_existing(target, profiles, posts)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--observed-at', help='Actual capture time with offset; never substitute import time')
    parser.add_argument('--account', help='用户名或主页URL；第三方导入必须明确指定')
    parser.add_argument('--output-dir', type=Path, help='创建批次目录的父目录')
    args = parser.parse_args()
    print(import_file(args.source, args.observed_at, args.account, args.output_dir))
