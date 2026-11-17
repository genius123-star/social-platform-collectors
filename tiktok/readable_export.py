"""Research-facing CSV: fixed Chinese columns, no raw JSON or implementation fields."""
import csv
import json
from pathlib import Path
from common import BJT, instant

POST_FIELDS = ['平台','账号','账号名称','发布时间（北京时间）','帖子链接','正文','标签','内容类型','点赞数','评论数','转发数','引用数','收藏数','帖子浏览数','视频播放量','采集时间（北京时间）']
PROFILE_FIELDS = ['平台','账号','账号名称','账号链接','简介','是否认证','认证类型','粉丝数','采集时间（北京时间）']
FOLLOWER_FIELDS = ['平台','账号','粉丝数','采集时间（北京时间）']


def write(path, fields, rows):
    with Path(path).open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def sequence(raw):
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
        return value if isinstance(value, list) else []
    except (TypeError, ValueError):
        return []


def count(row, key):
    # A rounded displayed count remains visibly rounded, never an invented exact integer.
    return row.get(key+'_raw', '') if row.get(key+'_precision') == 'rounded_display' else row.get(key, '')


def readable_time(raw):
    value = instant(raw)
    return value.astimezone(BJT).strftime('%Y-%m-%d %H:%M:%S') if value else ''


def export_readable(folder, profiles, posts):
    folder = Path(folder)
    names = {r['username'].casefold(): r.get('display_name', '') for r in sorted(profiles, key=lambda r:r.get('collected_at_utc', ''))}
    platform_name = {'tiktok':'TikTok', 'x':'X'}
    def common(row):
        return {'平台': platform_name.get(row['platform'], row['platform']), '账号': '@'+row['username'],
                '采集时间（北京时间）': readable_time(row.get('collected_at_bjt', ''))}
    latest = {}
    for r in posts:
        key = (r['username'].casefold(), r['content_id'])
        if key not in latest or r.get('collected_at_utc', '') > latest[key].get('collected_at_utc', ''):
            latest[key] = r
    groups = {'帖子内容.csv': [], '区间外帖子.csv': [], '发布时间待核实.csv': []}
    for r in latest.values():
        media = sequence(r.get('media_types'))
        types = '、'.join(dict.fromkeys({'video':'视频','photo':'图片','animated_gif':'动图'}.get(t, t) for t in media))
        types = types or {'video':'视频','photo':'图片'}.get(r.get('content_type'), '')
        plays = sequence(r.get('video_play_counts'))
        if r['platform'] == 'tiktok':
            play_count = count(r, 'view_count')
        elif len(plays) == 1:
            play_count = '' if plays[0].get('view_count') is None else plays[0]['view_count']
        else:
            play_count = '；'.join('视频'+str(i+1)+'：'+str(v['view_count']) for i,v in enumerate(plays) if v.get('view_count') is not None)
        row = dict(common(r), **{'账号名称':names.get(r['username'].casefold(), ''), '发布时间（北京时间）':readable_time(r.get('created_at_bjt', '')),
                   '帖子链接':r.get('content_url', ''), '正文':r.get('description', ''),
                   '标签':' '.join('#'+str(t).lstrip('#') for t in sequence(r.get('hashtags'))), '内容类型':types,
                   '点赞数':count(r,'like_count'), '评论数':count(r,'comment_count' if r['platform']=='tiktok' else 'reply_count'),
                   '转发数':count(r,'share_count' if r['platform']=='tiktok' else 'repost_count'),
                   '引用数':count(r,'quote_count'), '收藏数':count(r,'favorite_count' if r['platform']=='tiktok' else 'bookmark_count'),
                   '帖子浏览数':count(r,'view_count') if r['platform']=='x' else '', '视频播放量':play_count})
        name = {'in_range':'帖子内容.csv','out_of_range':'区间外帖子.csv'}.get(r.get('period_status'), '发布时间待核实.csv')
        groups[name].append(row)
    for name, rows in groups.items():
        write(folder/name, POST_FIELDS, sorted(rows,key=lambda r:(r['账号'],r['发布时间（北京时间）'])))
    latest_profiles = {}
    snapshots = {}
    for r in sorted(profiles, key=lambda r:r.get('collected_at_utc', '')):
        row = dict(common(r), **{'账号名称':r.get('display_name',''), '账号链接':r.get('profile_url',''), '简介':r.get('bio',''),
                   '是否认证':'是' if str(r.get('is_verified')).lower()=='true' else '否' if str(r.get('is_verified')).lower()=='false' else '',
                   '认证类型':r.get('verification_type',''), '粉丝数':count(r,'follower_count')})
        latest_profiles[(r['platform'],r['username'].casefold())] = row
        if count(r,'follower_count') != '':
            snapshots[(r['platform'],r['username'].casefold(),r.get('collected_at_utc',''))] = {k:row[k] for k in FOLLOWER_FIELDS}
    write(folder/'账号资料.csv', PROFILE_FIELDS, latest_profiles.values())
    write(folder/'粉丝快照.csv', FOLLOWER_FIELDS, snapshots.values())
    (folder/'阅读说明.txt').write_text('帖子内容.csv：研究期内帖子，每行一条，按账号和发布时间排序。\n账号资料.csv：本批最新账号资料。粉丝快照.csv：各次观察及时间。\n区间外帖子.csv和发布时间待核实.csv不计入研究期。\n时间统一为北京时间；数字0表示明确为0，空白表示未取得或不适用；1.2K等保留页面近似值。\n帖子浏览数与视频播放量分列；正文中的换行、引号和表情保留，可用Excel直接打开。\n技术资料文件夹仅用于排错和追溯，不属于研究用CSV。\n', encoding='utf-8')


def package_existing(folder, profiles=None, posts=None):
    """Move internal files once; never overwrite an older batch or source capture."""
    folder = Path(folder)
    technical = folder/'技术资料'
    technical.mkdir(exist_ok=True)
    def read(name):
        path = technical/name if (technical/name).exists() else folder/name
        if not path.exists():
            return []
        with path.open(encoding='utf-8-sig',newline='') as stream:
            return list(csv.DictReader(stream))
    if profiles is None:
        profiles = read('account_profile.csv')
    if posts is None:
        posts = read('posts.csv')
    # Only this batch's files, within the same directory; no recursive moves.
    for path in list(folder.iterdir()):
        if path.is_file() and path.suffix in ('.csv','.md') and path.name.isascii():
            destination = technical/path.name
            if destination.exists():
                raise ValueError('preserve_existing_technical_file:'+path.name)
            path.rename(destination)
    export_readable(folder, profiles, posts)
    return folder


def export_single_tiktok(path, profiles, posts):
    """One readable file per account; account/follower observations repeat per post.

    Includes all supplied posts and labels the fixed research window explicitly.
    Never combines old and new interaction values or invents missing metrics.
    """
    users = {r['username'].casefold() for r in [*profiles, *posts]}
    if len(users) != 1 or any(r['platform'] != 'tiktok' for r in [*profiles, *posts]):
        raise ValueError('single_tiktok_account_required')
    if not profiles:
        raise ValueError('account_profile_required_for_combined_export')
    by_time = {r['collected_at_utc']:r for r in profiles}
    latest_profile = max(profiles,key=lambda r:r['collected_at_utc'])
    latest_posts = {}
    for post in posts:
        if post['content_id'] not in latest_posts or post['collected_at_utc'] > latest_posts[post['content_id']]['collected_at_utc']:
            latest_posts[post['content_id']] = post
    fields = ['主体','平台','账号语种','账号','账号名称','账号链接','账号简介','是否认证','粉丝数',
              '粉丝快照时间（北京时间）','作品类型','作品链接','发布时间（北京时间）','正文','标签',
              '点赞数','评论数','转发数','收藏数','播放量','互动采集时间（北京时间）','是否在研究期']
    rows = []
    for post in sorted(latest_posts.values(),key=lambda r:r.get('created_at_utc','')):
        p = by_time.get(post['collected_at_utc'],latest_profile)
        bio = p.get('bio','')
        if not bio and p.get('bio_status') == 'observed_empty':
            bio = '未填写'
        row = {'主体':post.get('entity',''),'平台':'TikTok','账号语种':{'en':'英语','fr':'法语','es':'西班牙语','pt':'葡萄牙语'}.get(post.get('account_language'),''),
               '账号':'@'+post['username'],'账号名称':p.get('display_name',''),'账号链接':p.get('profile_url',''),
               '账号简介':bio,'是否认证':'是' if str(p.get('is_verified')).lower()=='true' else '否' if str(p.get('is_verified')).lower()=='false' else '',
               '粉丝数':count(p,'follower_count'),'粉丝快照时间（北京时间）':readable_time(p.get('collected_at_bjt')),
               '作品类型':{'video':'视频','photo':'图片'}.get(post.get('content_type'),''),
               '作品链接':post['content_url'],'发布时间（北京时间）':readable_time(post.get('created_at_bjt')),
               '正文':post.get('description',''),'标签':' '.join('#'+str(tag).lstrip('#') for tag in sequence(post.get('hashtags'))),
               '点赞数':count(post,'like_count'),'评论数':count(post,'comment_count'),'转发数':count(post,'share_count'),
               '收藏数':count(post,'favorite_count'),'播放量':count(post,'view_count'),
               '互动采集时间（北京时间）':readable_time(post.get('collected_at_bjt')),
               '是否在研究期':{'in_range':'是','out_of_range':'否'}.get(post.get('period_status'),'待核实')}
        rows.append(row)
    write(path, fields, rows)
    return rows


def export_single_x(path, profiles, posts):
    """Combine existing readable X tables without adding technical fields to the CSV."""
    path = Path(path)
    users = {r['username'].casefold() for r in [*profiles, *posts]}
    if len(users) != 1 or not profiles or any(r['platform'] != 'x' for r in [*profiles,*posts]):
        raise ValueError('single_x_account_and_profile_required')
    stage = path.parent/'技术资料'/'合并结果'
    stage.mkdir(parents=True, exist_ok=True)
    export_readable(stage, profiles, posts)
    def read(name):
        with (stage/name).open(encoding='utf-8-sig', newline='') as stream:
            return list(csv.DictReader(stream))
    profile = read('账号资料.csv')[0]
    entity = max(profiles, key=lambda r:r['collected_at_utc']).get('entity','')
    rows = []
    for name, inside in [('帖子内容.csv','是'),('区间外帖子.csv','否'),('发布时间待核实.csv','待核实')]:
        for post in read(name):
            rows.append({'主体':entity, **{k:profile[k] for k in ['平台','账号','账号名称','账号链接','简介','是否认证','认证类型','粉丝数']},
                         '粉丝快照时间（北京时间）':profile['采集时间（北京时间）'], **post,'是否在研究期':inside})
    fields = ['主体','平台','账号','账号名称','账号链接','简介','是否认证','认证类型','粉丝数','粉丝快照时间（北京时间）',
              '发布时间（北京时间）','帖子链接','正文','标签','内容类型','点赞数','评论数','转发数','引用数','收藏数',
              '帖子浏览数','视频播放量','采集时间（北京时间）','是否在研究期']
    rows.sort(key=lambda r:r['发布时间（北京时间）'])
    temp = path.with_suffix('.tmp')
    write(temp, fields, rows)
    temp.replace(path)
    return rows
