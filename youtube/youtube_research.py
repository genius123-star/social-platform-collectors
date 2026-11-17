"""Independent, resumable YouTube collection. Research CSVs contain no raw JSON."""
import argparse
import csv
import json
import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from common import ROOT, BJT, instant

VERSION = '1.1.0'
YOUTUBE_ACCOUNTS = {a['key']: a for a in json.loads((ROOT / 'accounts.json').read_text(encoding='utf-8')) if a['platform'] == 'youtube'}
START = '2025-10-16T16:00:00Z'
END = '2026-10-17T16:00:00Z'
BASE = 'https://www.googleapis.com/youtube/v3/'


def now():
    return datetime.now(timezone.utc).isoformat()


def bjt(value):
    parsed = instant(value)
    return parsed.astimezone(BJT).strftime('%Y-%m-%d %H:%M:%S') if parsed else ''


def within(value):
    parsed = instant(value)
    return None if parsed is None else instant(START) <= parsed < instant(END)


def safe(value):
    # Keep verbatim text in evidence; prevent spreadsheet formula execution in CSV.
    if isinstance(value, str) and value.lstrip().startswith(('=', '+', '-', '@')):
        return "'" + value
    return value


def readable_duration(value):
    match = re.fullmatch(r'P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?', value or '')
    if not match:
        return ''
    days, hours, minutes, seconds = (float(part or 0) for part in match.groups())
    total = int(days * 86400 + hours * 3600 + minutes * 60 + seconds)
    return f'{total // 3600:02d}:{total % 3600 // 60:02d}:{total % 60:02d}'


def write_csv(path, fields, rows):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: safe(row.get(key, '')) for key in fields})
    temporary.replace(path)


class Pause(Exception):
    pass


class ApiError(Exception):
    def __init__(self, reason):
        self.reason = reason


class Collection:
    def __init__(self, folder, budget=1000, account_key='cd_yt_yan_en', account=None):
        self.account = account if account is not None else YOUTUBE_ACCOUNTS[account_key]
        self.target = self.account['url']
        self.folder = Path(folder)
        self.evidence = self.folder / 'evidence'
        self.evidence.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.evidence / 'progress.sqlite')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, status TEXT, payload TEXT, collected TEXT);
            CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, video TEXT, thread TEXT, payload TEXT, collected TEXT);
            CREATE TABLE IF NOT EXISTS jobs (endpoint TEXT, scope TEXT, video TEXT, thread TEXT,
                token TEXT DEFAULT '', status TEXT DEFAULT 'pending', PRIMARY KEY(endpoint, scope));
            CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY, endpoint TEXT, params TEXT,
                collected TEXT, status TEXT, reason TEXT);
            CREATE TABLE IF NOT EXISTS pages (endpoint TEXT, scope TEXT, token TEXT,
                PRIMARY KEY(endpoint, scope, token));
            CREATE INDEX IF NOT EXISTS comments_video ON comments(video);
            CREATE INDEX IF NOT EXISTS jobs_video ON jobs(video);
        ''')
        for key, value in [('target', self.target), ('start', START), ('end', END)]:
            old = self.get(key)
            if old is not None and old != value:
                self.db.close()
                raise ValueError('Resume target/window mismatch')
            self.set(key, value)
        self.db.commit()
        self.session = requests.Session()
        self.budget, self.used, self.last = budget, 0, 0

    def get(self, key):
        row = self.db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def set(self, key, value):
        self.db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (key, json.dumps(value, ensure_ascii=False)))

    def fetch(self, endpoint, **params):
        for attempt in range(3):
            if self.used >= self.budget:
                raise Pause('本次请求预算已用尽，可恢复继续')
            time.sleep(max(0, 1 - (time.monotonic() - self.last)))
            self.used += 1
            stamp = now()
            cursor = self.db.execute('INSERT INTO requests(endpoint,params,collected,status) VALUES (?,?,?,?)',
                                     (endpoint, json.dumps(params), stamp, 'started'))
            number = cursor.lastrowid
            self.db.commit()
            reason, status, data = '', 'network_error', None
            try:
                response = self.session.get(BASE + endpoint, params=params, timeout=(10, 30))
                status = str(response.status_code)
                data = response.json()
                errors = data.get('error', {}).get('errors', [])
                reason = errors[0].get('reason', '') if errors else ''
                if response.ok:
                    status = 'ok'
                else:
                    reason = reason or 'http_' + status
            except (requests.RequestException, ValueError):
                reason = 'network_or_non_json'
            finally:
                self.last = time.monotonic()
            # No headers, key, URLs or free-form error messages are written to logs.
            record = {'endpoint': endpoint, 'params': params, 'collected_at': stamp,
                      'status': status, 'reason': reason}
            if status == 'ok':
                record['response'] = data
            with (self.evidence / f'request_{number:06d}.json').open('w', encoding='utf-8') as stream:
                json.dump(record, stream, ensure_ascii=False)
            self.db.execute('UPDATE requests SET status=?,reason=? WHERE id=?', (status, reason, number))
            self.db.commit()
            if status == 'ok':
                return data, stamp
            if status == 'network_error' or status == '429' or status.startswith('5'):
                if attempt < 2:
                    time.sleep(2 ** attempt)
                    continue
                raise Pause('暂时网络或服务故障：' + reason)
            raise ApiError(reason)

    def setup(self):
        if self.get('channel'):
            return
        data, stamp = self.fetch('channels', part='snippet,statistics,contentDetails', forHandle=self.target.rstrip('/').split('/')[-1])
        if len(data.get('items', [])) != 1:
            raise Pause('频道未唯一解析，需核验身份')
        channel = data['items'][0]
        playlist = channel.get('contentDetails', {}).get('relatedPlaylists', {}).get('uploads')
        if not playlist:
            raise Pause('频道无可用上传列表')
        self.set('channel', channel)
        self.set('channel_collected', stamp)
        self.db.execute('INSERT OR IGNORE INTO jobs(endpoint,scope,video,thread) VALUES (?,?,?,?)',
                        ('playlistItems', playlist, '', ''))
        self.db.commit()
        print('Channel: ' + channel['snippet']['title'] + ' / ' + channel['id'], flush=True)

    def advance(self, endpoint, scope, token, data):
        next_token = data.get('nextPageToken', '')
        self.db.execute('INSERT OR IGNORE INTO pages VALUES (?,?,?)', (endpoint, scope, token))
        repeated = next_token and self.db.execute('SELECT 1 FROM pages WHERE endpoint=? AND scope=? AND token=?',
                                                  (endpoint, scope, next_token)).fetchone()
        if repeated:
            raise Pause('分页游标重复，已保存数据，需检查后恢复')
        self.db.execute('UPDATE jobs SET token=?,status=? WHERE endpoint=? AND scope=?',
                        (next_token, 'pending' if next_token else 'done', endpoint, scope))

    def discover(self):
        while True:
            job = self.db.execute("SELECT scope,token FROM jobs WHERE endpoint='playlistItems' AND status='pending'").fetchone()
            if not job:
                return
            scope, token = job
            params = dict(part='contentDetails', playlistId=scope, maxResults=50)
            if token:
                params['pageToken'] = token
            data, stamp = self.fetch('playlistItems', **params)
            with self.db:
                for item in data.get('items', []):
                    vid = item['contentDetails']['videoId']
                    self.db.execute('INSERT OR IGNORE INTO videos VALUES (?,?,?,?)', (vid, 'pending', '{}', stamp))
                self.advance('playlistItems', scope, token, data)
            print('Discovered videos: ' + str(self.db.execute('SELECT count(*) FROM videos').fetchone()[0]), flush=True)

    def details(self):
        while True:
            ids = [row[0] for row in self.db.execute("SELECT id FROM videos WHERE status='pending' LIMIT 50")]
            if not ids:
                return
            data, stamp = self.fetch('videos', part='snippet,statistics,contentDetails,liveStreamingDetails', id=','.join(ids))
            returned = {item['id']: item for item in data.get('items', [])}
            with self.db:
                for vid in ids:
                    item = returned.get(vid)
                    status = 'unavailable'
                    if item:
                        if item['snippet'].get('channelId') != self.get('channel')['id']:
                            status = 'channel_mismatch'
                        else:
                            period = within(item['snippet'].get('publishedAt'))
                            status = 'in_range' if period is True else 'out_of_range' if period is False else 'undated'
                    self.db.execute('UPDATE videos SET status=?,payload=?,collected=? WHERE id=?',
                                    (status, json.dumps(item or {}, ensure_ascii=False), stamp, vid))
                    if status == 'in_range':
                        self.db.execute('INSERT OR IGNORE INTO jobs(endpoint,scope,video,thread) VALUES (?,?,?,?)',
                                        ('commentThreads', vid, vid, ''))
            print('Video details saved; in period: ' + str(self.db.execute("SELECT count(*) FROM videos WHERE status='in_range'").fetchone()[0]), flush=True)

    def save_comment(self, item, video, thread, stamp):
        self.db.execute('INSERT OR IGNORE INTO comments VALUES (?,?,?,?,?)',
                        (item['id'], video, thread, json.dumps(item, ensure_ascii=False), stamp))

    def comment_pages(self):
        while True:
            job = self.db.execute("SELECT endpoint,scope,video,thread,token FROM jobs WHERE endpoint!='playlistItems' AND status='pending' ORDER BY CASE endpoint WHEN 'commentThreads' THEN 0 ELSE 1 END, rowid LIMIT 1").fetchone()
            if not job:
                return
            endpoint, scope, video, thread_id, token = job
            params = dict(part='snippet', maxResults=100, textFormat='plainText')
            params.update(dict(videoId=video, order='time') if endpoint == 'commentThreads' else dict(parentId=scope))
            if token:
                params['pageToken'] = token
            try:
                data, stamp = self.fetch(endpoint, **params)
            except ApiError as exc:
                if exc.reason in ('commentsDisabled', 'videoNotFound', 'commentNotFound'):
                    with self.db:
                        self.db.execute('UPDATE jobs SET status=? WHERE endpoint=? AND scope=?',
                                        (exc.reason, endpoint, scope))
                    continue
                raise
            with self.db:
                for item in data.get('items', []):
                    if endpoint == 'commentThreads':
                        snippet = item['snippet']
                        top = snippet['topLevelComment']
                        if snippet.get('videoId', video) != video:
                            raise Pause('评论所属视频冲突')
                        self.save_comment(top, video, item['id'], stamp)
                        if snippet.get('totalReplyCount', 0):
                            self.db.execute('INSERT OR IGNORE INTO jobs(endpoint,scope,video,thread) VALUES (?,?,?,?)',
                                            ('comments', top['id'], video, item['id']))
                    else:
                        if item['snippet'].get('parentId') != scope:
                            raise Pause('回复父评论冲突')
                        self.save_comment(item, video, thread_id, stamp)
                self.advance(endpoint, scope, token, data)
            print(f'Comments: {video}; saved total: {self.db.execute("SELECT count(*) FROM comments").fetchone()[0]}; requests: {self.used}', flush=True)
            if self.used % 25 == 0:
                self.export('采集中')

    def coverage(self, video):
        statuses = [row[0] for row in self.db.execute("SELECT status FROM jobs WHERE video=?", (video,))]
        labels = {'commentsDisabled': '评论已关闭', 'videoNotFound': '视频不可访问', 'commentNotFound': '部分评论不可访问'}
        if not statuses:
            return '未尝试'
        if 'pending' in statuses:
            return '部分完成，待续采'
        errors = [labels.get(s, s) for s in statuses if s != 'done']
        return '；'.join(dict.fromkeys(errors)) if errors else '当前可访问评论及回复已遍历'

    def export(self, state, reason=''):
        channel = self.get('channel')
        profile = []
        if channel:
            sn, stat = channel['snippet'], channel.get('statistics', {})
            profile = [{'主体': self.account.get('entity', '中国日报'), '登记语种': {'en':'英语','fr':'法语','und':'未核验'}.get(self.account['language'], self.account['language']), '频道名称': sn.get('title'), '频道ID': channel['id'],
                        '频道链接': 'https://www.youtube.com/channel/' + channel['id'], '输入链接': self.target,
                        '频道简介': sn.get('description', ''), '频道创建时间（北京时间）': bjt(sn.get('publishedAt')),
                        '订阅数': '' if stat.get('hiddenSubscriberCount') else stat.get('subscriberCount', ''),
                        '订阅数精度': '隐藏' if stat.get('hiddenSubscriberCount') else '向下取整至三位有效数字',
                        '累计公开视频数': stat.get('videoCount', ''), '采集时间（北京时间）': bjt(self.get('channel_collected'))}]
        write_csv(self.folder / 'YouTube_频道.csv', ['主体','登记语种','频道名称','频道ID','频道链接','输入链接','频道简介','频道创建时间（北京时间）','订阅数','订阅数精度','累计公开视频数','采集时间（北京时间）'], profile)
        counts = dict(self.db.execute('SELECT status,count(*) FROM videos GROUP BY status'))
        videos = []
        for vid, raw, stamp in self.db.execute("SELECT id,payload,collected FROM videos WHERE status='in_range' ORDER BY json_extract(payload,'$.snippet.publishedAt')"):
            item = json.loads(raw)
            sn, stats = item['snippet'], item.get('statistics', {})
            live = item.get('liveStreamingDetails', {})
            missing = ['播放量' if key == 'viewCount' else '点赞数' if key == 'likeCount' else '评论总数' for key in ('viewCount','likeCount','commentCount') if key not in stats]
            hashtags = list(dict.fromkeys(re.findall(r'#[\w]+', sn.get('title', '') + '\n' + sn.get('description', ''))))
            videos.append({'视频ID': vid, '频道ID': sn.get('channelId'), '视频链接': 'https://www.youtube.com/watch?v=' + vid,
                '发布时间（北京时间）': bjt(sn.get('publishedAt')), '发布时间（UTC）': sn.get('publishedAt'),
                '标题': sn.get('title'), '完整描述': sn.get('description'), '话题标签': ' '.join(hashtags), 'API标签': '；'.join(sn.get('tags', [])),
                '时长（时:分:秒）': readable_duration(item.get('contentDetails', {}).get('duration', '')),
                '内容类型': '直播相关' if live else '未知（未核实是否Shorts）',
                '类型依据': 'API直播详情' if live else '公开API未提供可靠Shorts分类',
                '直播状态': {'none': '非正在直播或预告', 'live': '正在直播', 'upcoming': '直播预告'}.get(sn.get('liveBroadcastContent'), '未知'), '直播预定开始时间（北京时间）': bjt(live.get('scheduledStartTime')),
                '直播实际开始时间（北京时间）': bjt(live.get('actualStartTime')), '直播结束时间（北京时间）': bjt(live.get('actualEndTime')),
                '播放量': stats.get('viewCount', ''), '点赞数': stats.get('likeCount', ''), '评论总数': stats.get('commentCount', ''),
                '已采评论及回复数': self.db.execute('SELECT count(*) FROM comments WHERE video=?', (vid,)).fetchone()[0],
                '评论覆盖状态': self.coverage(vid), '缺失说明': '；'.join(missing) + ('：接口未返回' if missing else ''),
                '采集时间（北京时间）': bjt(stamp)})
        video_fields = ['视频ID','频道ID','视频链接','发布时间（北京时间）','发布时间（UTC）','标题','完整描述','话题标签','API标签','时长（时:分:秒）','内容类型','类型依据','直播状态','直播预定开始时间（北京时间）','直播实际开始时间（北京时间）','直播结束时间（北京时间）','播放量','点赞数','评论总数','已采评论及回复数','评论覆盖状态','缺失说明','采集时间（北京时间）']
        write_csv(self.folder / 'YouTube_视频.csv', video_fields, videos)
        def comment_rows():
            for cid, vid, thread, raw, stamp in self.db.execute('SELECT * FROM comments ORDER BY video,id'):
                sn = json.loads(raw)['snippet']
                period = within(sn.get('publishedAt'))
                yield {'视频ID': vid, '评论ID': cid, '父评论ID': sn.get('parentId', ''), '线程ID': thread,
                    '评论链接': f'https://www.youtube.com/watch?v={vid}&lc={cid}', '作者': sn.get('authorDisplayName', ''),
                    '作者频道ID': sn.get('authorChannelId', {}).get('value', ''),
                    '评论原文': sn.get('textOriginal', sn.get('textDisplay', '')), '显示文本': sn.get('textDisplay', ''),
                    '点赞数': sn.get('likeCount', ''), '发布时间（北京时间）': bjt(sn.get('publishedAt')),
                    '发布时间（UTC）': sn.get('publishedAt', ''), '更新时间（北京时间）': bjt(sn.get('updatedAt')),
                    '更新时间（UTC）': sn.get('updatedAt', ''), '是否在研究期内': '是' if period is True else '否' if period is False else '待核验',
                    '采集时间（北京时间）': bjt(stamp)}
        write_csv(self.folder / 'YouTube_评论.csv', ['视频ID','评论ID','父评论ID','线程ID','评论链接','作者','作者频道ID','评论原文','显示文本','点赞数','发布时间（北京时间）','发布时间（UTC）','更新时间（北京时间）','更新时间（UTC）','是否在研究期内','采集时间（北京时间）'], comment_rows())
        report = {'批次': self.folder.name, '账号': self.target, '状态': state, '停止原因': reason,
                  '研究窗口（北京时间）': '2025-10-17 00:00:00 至 2026-10-17 23:59:59（含全天）',
                  '发现视频数': sum(counts.values()), '研究期内视频数': counts.get('in_range', 0),
                  '期间外视频数': counts.get('out_of_range', 0), '日期待核验数': counts.get('undated', 0),
                  '不可读取或归属冲突数': counts.get('unavailable', 0) + counts.get('channel_mismatch', 0),
                  '待读取视频数': counts.get('pending', 0),
                  '已采评论及回复数': self.db.execute('SELECT count(*) FROM comments').fetchone()[0],
                  '评论关闭视频数': self.db.execute("SELECT count(*) FROM jobs WHERE status='commentsDisabled'").fetchone()[0],
                  '评论遍历完成视频数': sum(self.coverage(row[0]) == '当前可访问评论及回复已遍历' for row in self.db.execute("SELECT id FROM videos WHERE status='in_range'")),
                  '待完成分页任务数': self.db.execute("SELECT count(*) FROM jobs WHERE status='pending'").fetchone()[0],
                  '累计请求尝试数': self.db.execute('SELECT count(*) FROM requests').fetchone()[0],
                  '累计请求成功数': self.db.execute("SELECT count(*) FROM requests WHERE status='ok'").fetchone()[0],
                  '程序版本': VERSION, '报告时间（北京时间）': bjt(now())}
        write_csv(self.folder / 'YouTube_采集报告.csv', list(report), [report])
        gaps = [{'视频ID': vid, '状态': status} for vid, status in self.db.execute("SELECT id,status FROM videos WHERE status IN ('unavailable','channel_mismatch','undated','pending')")]
        write_csv(self.folder / 'YouTube_视频缺口.csv', ['视频ID','状态'], gaps)
        self.set('last_state', state)
        self.set('last_reason', reason)
        self.db.commit()

    def run(self):
        state, reason = '暂停，可恢复', ''
        try:
            key = os.environ.get('YOUTUBE_API_KEY', '')
            if not key:
                env_path = ROOT / '.env'
                lines = env_path.read_text(encoding='utf-8-sig').splitlines() if env_path.exists() else []
                values = [line.partition('=')[2].strip().strip('\"\'') for line in lines if line.partition('=')[0].strip() == 'YOUTUBE_API_KEY']
                if len(values) == 1:
                    key = values[0]
            if not key:
                raise Pause('未找到本地YOUTUBE_API_KEY')
            self.session.headers['X-Goog-Api-Key'] = key
            self.setup()
            self.export('采集中')
            self.discover()
            self.details()
            self.export('视频清单已保存，正在采评论')
            self.comment_pages()
            issues = self.db.execute("SELECT count(*) FROM videos WHERE status IN ('unavailable','undated','channel_mismatch')").fetchone()[0]
            issues += self.db.execute("SELECT count(*) FROM jobs WHERE status!='done'").fetchone()[0]
            state = '当前可访问列表已遍历，存在缺口' if issues else '当前可访问视频及评论已遍历'
        except ApiError as exc:
            reason = 'API停止：' + exc.reason
            if exc.reason in ('invalidPageToken', 'pageTokenInvalid'):
                # Restart enumeration on explicit resume; persistent IDs deduplicate it.
                with self.db:
                    self.db.execute("UPDATE jobs SET token='' WHERE status='pending'")
                    self.db.execute('DELETE FROM pages')
        except Pause as exc:
            reason = str(exc)
        except KeyboardInterrupt:
            reason = '用户中断，已保存断点'
        except Exception as exc:
            reason = '程序异常：' + type(exc).__name__
        finally:
            self.export(state, reason)
            print(state + (' / ' + reason if reason else ''), flush=True)
            print('Output: ' + str(self.folder), flush=True)
            self.db.close()
        return 0 if state.startswith('当前可访问') else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    destination = parser.add_mutually_exclusive_group()
    destination.add_argument('--resume', type=Path, help='Existing batch directory; use its original --account')
    destination.add_argument('--output-dir', type=Path, help='Parent directory for a new batch')
    parser.add_argument('--request-budget', type=int, default=1000)
    parser.add_argument('--account', choices=list(YOUTUBE_ACCOUNTS), default='cd_yt_yan_en')
    args = parser.parse_args()
    if args.request_budget < 1:
        parser.error('request budget must be positive')
    account = YOUTUBE_ACCOUNTS[args.account]
    parent = args.output_dir or ROOT / 'outputs' / 'youtube' / account['language'] / args.account
    folder = (args.resume or parent / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '_research')).resolve()
    if args.resume and not (folder / 'evidence' / 'progress.sqlite').is_file():
        parser.error('Resume batch does not exist')
    raise SystemExit(Collection(folder, args.request_budget, args.account).run())


if __name__ == '__main__':
    main()
