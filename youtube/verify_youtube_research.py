"""Offline regression: dates, real queue transitions, pause/resume, dedup and CSV."""
import csv
import tempfile
from pathlib import Path
from youtube_research import Collection, Pause, ApiError, within, safe, ROOT, readable_duration


def comment(cid, parent=''):
    return {'id': cid, 'snippet': {'parentId': parent, 'textOriginal': '=test\n多行,评论',
            'textDisplay': '=test\n多行,评论', 'publishedAt': '2026-10-18T00:00:00Z', 'likeCount': 0}}


def verify():
    assert within('2025-10-16T15:59:59Z') is False
    assert within('2025-10-16T16:00:00Z') is True
    assert within('2026-10-17T15:59:59Z') is True
    assert within('2026-10-17T16:00:00Z') is False
    assert within(None) is None
    assert safe(' \t=1') == "' \t=1"
    assert readable_duration('PT1H2M3S') == '01:02:03'
    assert readable_duration('PT59S') == '00:00:59'
    with tempfile.TemporaryDirectory() as temporary:
        folder = Path(temporary)
        collector = Collection(folder)
        def fetch(endpoint, **params):
            stamp = '2026-10-22T00:00:00Z'
            if endpoint == 'channels':
                return {'items': [{'id': 'channel', 'snippet': {'title': 'Yan Studio'}, 'statistics': {},
                       'contentDetails': {'relatedPlaylists': {'uploads': 'uploads'}}}]}, stamp
            if endpoint == 'playlistItems':
                ids = ['inside', 'missing'] if not params.get('pageToken') else ['outside', 'inside', 'disabled']
                data = {'items': [{'contentDetails': {'videoId': vid}} for vid in ids]}
                if not params.get('pageToken'):
                    data['nextPageToken'] = 'page2'
                return data, stamp
            if endpoint == 'videos':
                return {'items': [{'id': vid, 'snippet': {'channelId': 'channel', 'title': 'title,\n标题',
                    'publishedAt': '2026-10-18T00:00:00Z' if vid == 'outside' else '2026-10-17T00:00:00Z'},
                    'statistics': {'viewCount': '0', 'commentCount': '5'}} for vid in params['id'].split(',') if vid != 'missing']}, stamp
            if endpoint == 'commentThreads':
                if params['videoId'] == 'disabled':
                    raise ApiError('commentsDisabled')
                if params.get('pageToken'):
                    return {'items': [{'id': 'thread2', 'snippet': {'topLevelComment': comment('top2')}}]}, stamp
                return {'items': [{'id': 'thread', 'snippet': {'topLevelComment': comment('top'), 'totalReplyCount': 3}}], 'nextPageToken': 'thread2'}, stamp
            if endpoint == 'comments':
                if params.get('pageToken'):
                    raise Pause('simulated interruption')
                return {'items': [comment('reply1', 'top')], 'nextPageToken': 'reply2'}, stamp
            raise AssertionError(endpoint)
        collector.fetch = fetch
        collector.setup()
        collector.discover()
        collector.details()
        try:
            collector.comment_pages()
        except Pause:
            pass
        else:
            raise AssertionError('Expected pause')
        collector.export('暂停')
        assert collector.db.execute('SELECT count(*) FROM videos').fetchone()[0] == 4
        assert collector.db.execute('SELECT count(*) FROM comments').fetchone()[0] == 3
        assert collector.coverage('disabled') == '评论已关闭'
        collector.db.close()
        resumed = Collection(folder)
        def resume_fetch(endpoint, **params):
            assert endpoint == 'comments' and params['pageToken'] == 'reply2'
            return {'items': [comment('reply1', 'top'), comment('reply2', 'top'), comment('reply3', 'top')]}, '2026-10-22T00:00:00Z'
        resumed.fetch = resume_fetch
        resumed.comment_pages()
        resumed.export('已完成')
        assert resumed.db.execute('SELECT count(*) FROM comments').fetchone()[0] == 5
        assert resumed.coverage('inside') == '当前可访问评论及回复已遍历'
        with (folder / 'YouTube_评论.csv').open(encoding='utf-8-sig', newline='') as stream:
            rows = list(csv.DictReader(stream))
        assert len(rows) == 5 and rows[0]['评论原文'] == "'=test\n多行,评论"
        assert rows[0]['是否在研究期内'] == '否'
        assert all('json' not in key.lower() for key in rows[0])
        resumed.db.close()
        try:
            Collection(folder, account_key='cd_yt_fr')
        except ValueError:
            pass
        else:
            raise AssertionError('Cross-account resume must be rejected')
        cns = Collection(folder / 'cns', account=dict(entity='中国新闻网',language='und',url='https://www.youtube.com/@Ipaknews'))
        def cns_fetch(endpoint, **params):
            assert endpoint == 'channels' and params['forHandle'] == '@Ipaknews'
            return fetch(endpoint, **params)
        cns.fetch = cns_fetch
        cns.setup()
        cns.export('暂停')
        with (folder / 'cns' / 'YouTube_频道.csv').open(encoding='utf-8-sig', newline='') as stream:
            profile = next(csv.DictReader(stream))
        assert profile['主体'] == '中国新闻网' and profile['登记语种'] == '未核验'
        cns.db.close()
    print('PASS: boundaries, multi-page uploads/threads/replies, unavailable video, disabled comments, resume, dedup, readable CSV')


if __name__ == '__main__':
    verify()
