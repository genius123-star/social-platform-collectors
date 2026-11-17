"""Isolated contract checks; synthetic data never enters research outputs."""
import csv
import json
import subprocess
import tempfile
from pathlib import Path
from import_instagram_probe import ROOT, COLUMNS, SCHEMA, import_capture, load_capture, validate_snapshot
from instagram_parse import normalize, time_fields


def main():
    extension = ROOT / 'chrome_instagram_probe'
    manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
    assert set(manifest['permissions']) == {'activeTab', 'scripting', 'storage', 'unlimitedStorage', 'alarms'}
    assert set(manifest['host_permissions']) == {'https://www.instagram.com/*','https://instagram.com/*'}
    assert not manifest.get('content_scripts')
    for name in ['page_reader.js', 'popup.js', 'collector.js', 'data.js', 'supervisor.js']:
        subprocess.run(['node', '--check', str(extension / name)], check=True)
    # Tiny DOM mock tests safety gates and text selection, not real Instagram compatibility.
    script = r'''
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const make=(extra={})=>({getClientRects:()=>[1],closest:()=>null, ...extra});
const context=vm.createContext({URL,location:{href:'https://www.instagram.com/dailyvideo.kg/'},
 getComputedStyle:()=>({visibility:'visible',display:'block'}),NodeFilter:{SHOW_TEXT:4}});
const texts=[{textContent:'synthetic caption, "quoted"\n中文😀',parentElement:make()},
 {textContent:'DO_NOT_READ_INPUT',parentElement:make({closest:()=>({})})}];
const scope=make({querySelector:()=>null,querySelectorAll:()=>[]});
context.document={querySelectorAll:()=>[],querySelector:()=>scope,createTreeWalker:()=>{
 let i=0;return {nextNode:()=>texts[i++]||null};}};
vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),context);
let result=vm.runInContext("readInstagramPage('dailyvideo.kg')",context);
assert(result.visible_text.includes('中文😀'));assert(!result.visible_text.includes('DO_NOT_READ_INPUT'));
assert.equal(result.history_complete,false);assert.equal(result.metrics_status,'not_mapped');
context.location.href='https://www.instagram.com/direct/inbox/';
assert.throws(()=>vm.runInContext("readInstagramPage('dailyvideo.kg')",context));
context.location.href='https://www.instagram.com/chinaarabtv/';
assert.throws(()=>vm.runInContext("readInstagramPage('dailyvideo.kg')",context));
context.location.href='https://www.instagram.com/p/SYNTHETIC_ONLY/';
assert.throws(()=>vm.runInContext("readInstagramPage('dailyvideo.kg')",context));
console.log('JS safety contracts passed; DOM mock only');
'''
    subprocess.run(['node', '-e', script, str(extension / 'page_reader.js')], check=True)
    subprocess.run(['node', str(ROOT / 'verify_instagram_auto.js')], check=True)
    account = json.loads((ROOT / 'instagram_accounts.json').read_text(encoding='utf-8'))[0]
    snapshot = dict(schema=SCHEMA, username=account['username'], page_url=account['url'],
        collected_at_utc='2026-10-22T01:00:00Z', page_kind='profile', shortcode='',
        status='diagnostic_only', history_complete=False, metrics_status='not_mapped',
        comments_status='not_parsed', visible_text='SYNTHETIC ONLY, "quoted"\n中文😀',
        links=[], times=[], controls=[])
    header = dict(snapshot,visible_text='dailyvideo.kg\nSynthetic name\n1568\n帖子\n4.5万\n粉丝\n12\n关注\n')
    profile = normalize(header,account,0)[0][0]
    assert profile['follower_count']==45000 and profile['follower_count_raw']=='4.5万'
    assert profile['follower_count_precision']=='rounded_display'
    post = dict(snapshot,page_kind='post',page_url='https://www.instagram.com/p/SYNTHETIC_ONLY/',
        shortcode='SYNTHETIC_ONLY',visible_text='dailyvideo.kg\n57\n次赞',
        links=[dict(url=account['url'],text='dailyvideo.kg'),
               dict(url='https://www.instagram.com/dailyvideo.kg/reel/SYNTHETIC_ONLY/',text='1 小时前'),
               dict(url='https://www.instagram.com/synthetic_author/',text='synthetic_author')],
        times=[dict(text='1 小时',datetime='2026-10-22T13:59:17Z'),
               dict(text='54分钟',datetime='2026-10-22T14:17:39Z'),
               dict(text='1 小时前',datetime='2026-10-22T13:59:17Z')],
        controls=[dict(tag='BUTTON',text='3次赞'),dict(tag='DIV',text='57次赞'),
                  dict(tag='DIV',text='dailyvideo.kg\nSynthetic caption😀\n1 小时\n查看翻译'),
                  dict(tag='DIV',text='synthetic_author\nSynthetic comment😀\n54分钟回复')])
    _, parsed_posts, parsed_comments, _ = normalize(post,account,1)
    assert parsed_posts[0]['like_count']==57 and parsed_posts[0]['comment_count']==''
    assert parsed_posts[0]['caption']=='Synthetic caption😀'
    assert parsed_posts[0]['created_at_bjt']=='2026-10-22T21:59:17+08:00'
    assert parsed_posts[0]['period_status']=='out_of_range'
    assert parsed_comments[0]['body']=='Synthetic comment😀'
    assert parsed_comments[0]['like_count']=='' and parsed_comments[0]['comment_id']==''
    assert time_fields('2025-10-16T15:59:59Z')['period_status']=='out_of_range'
    assert time_fields('2025-10-16T16:00:00Z')['period_status']=='in_range'
    assert time_fields('2026-10-17T15:59:59Z')['period_status']=='in_range'
    assert time_fields('2026-10-17T16:00:00Z')['period_status']=='out_of_range'
    ambiguous = dict(post,times=post['times']+[dict(text='1 小时前',datetime='2026-10-21T00:00:00Z')])
    assert normalize(ambiguous,account,1)[1][0]['period_status']=='date_pending'
    translated = dict(post, controls=post['controls'][:-1]+[
        dict(tag='DIV',text='synthetic_author\nSynthetic comment😀\n54分钟3次赞回复\n查看翻译')])
    translated_comment = normalize(translated,account,1)[2][0]
    assert translated_comment['body']=='Synthetic comment😀' and translated_comment['like_count']==3
    ambiguous_comment = dict(translated,times=translated['times']+[
        dict(text='54分钟',datetime='2026-10-22T14:18:00Z')])
    retained = normalize(ambiguous_comment,account,1)[2][0]
    assert retained['body']=='Synthetic comment😀' and retained['created_at_utc']==''
    assert retained['time_raw']=='54分钟' and retained['time_status']=='ambiguous_relative_label_no_dom_association'
    scoped_controls = [dict(c) for c in ambiguous_comment['controls']]
    scoped_controls[-1]['times'] = [dict(text='54分钟',datetime='2026-10-22T14:17:39Z')]
    scoped = normalize(dict(ambiguous_comment,controls=scoped_controls),account,1)[2][0]
    assert scoped['created_at_utc']=='2026-10-22T14:17:39+00:00' and scoped['time_status']=='control_time_datetime'
    no_caption = dict(post,controls=[c for c in post['controls'] if not c.get('text','').startswith('dailyvideo.kg\n')])
    _, no_caption_posts, kept_comments, _ = normalize(no_caption,account,1)
    assert no_caption_posts[0]['identity_status']=='account_permalink_and_header_match_caption_missing'
    assert no_caption_posts[0]['caption']=='' and no_caption_posts[0]['like_count']==57
    assert len(kept_comments)==1
    enriched = dict(post,comment_evidence=[dict(comment_id='12345',parent_comment_id='98765',
        author_username='synthetic_author',datetime='2026-10-22T14:17:39Z',text='Synthetic comment😀',
        source_url='https://www.instagram.com/p/SYNTHETIC_ONLY/c/12345/')],
        metric_evidence=[dict(field='comment_count',raw='0',label='查看全部0条评论',source='confirmed_detail_outside_comment_items')])
    validate_snapshot(enriched,account)
    enriched_result=normalize(enriched,account,1)
    assert enriched_result[1][0]['comment_count']==0 and enriched_result[1][0]['comment_count_status']=='explicit_zero'
    assert enriched_result[2][0]['comment_id']=='12345' and enriched_result[2][0]['parent_comment_id']=='98765'
    assert normalize(dict(enriched,collection={'phase':'detail_rejected'}),account,1)==([],[],[],[])
    bad_evidence=dict(enriched,comment_evidence=[dict(enriched['comment_evidence'][0],source_url='https://www.instagram.com/p/OTHER/c/12345/')])
    try:
        validate_snapshot(bad_evidence,account)
    except ValueError:
        pass
    else:
        raise AssertionError('cross-post comment evidence accepted')
    wrong_header = dict(no_caption,visible_text='another_account\n57\n次赞')
    assert normalize(wrong_header,account,1)[1][0]['identity_status']=='identity_pending'
    assert not normalize(wrong_header,account,1)[2]
    diagnostic_path = ROOT/'local-fixtures/failed-detail.json'
    if diagnostic_path.exists():
        diagnostic = json.loads(diagnostic_path.read_text(encoding='utf-8-sig'))
        real_post = diagnostic['running']['snapshot']
        real_account = next(a for a in json.loads((ROOT/'instagram_accounts.json').read_text(encoding='utf-8'))
                            if a['username']=='chinaarabtv')
        validate_snapshot(real_post,real_account)
        recovered = normalize(real_post,real_account,0)[1][0]
        assert recovered['identity_strategy']=='account_permalink_caption_author_and_scoped_time'
        assert recovered['content_id']=='DeT1BDRjVee' and recovered['like_count']==71
        assert recovered['created_at_bjt']=='2026-10-10T18:05:02+08:00'
        assert recovered['period_status']=='in_range' and recovered['caption']
        # Negative variants change public evidence in memory, never the archived source.
        caption_controls = [dict(c) for c in real_post['controls']]
        index = next(i for i,c in enumerate(caption_controls) if c.get('text','').startswith('chinaarabtv\n'))
        bad_time_controls = [dict(c) for c in caption_controls]
        bad_time_controls[index]['times'] = [{'datetime':'2026-10-09T10:05:02.000Z','text':'1 周'}]
        variants = [
            dict(real_post,links=[l for l in real_post['links'] if '/p/DeT1BDRjVee/' not in l['url']]),
            dict(real_post,controls=bad_time_controls),
            dict(real_post,controls=[c for i,c in enumerate(caption_controls) if i!=index]),
            dict(real_post,shortcode='ANOTHER_POST'),
            dict(real_post,links=[l for l in real_post['links'] if l['text']!='chinaarabtv']),
            dict(real_post,controls=caption_controls+[caption_controls[index]]),
        ]
        for candidate in variants:
            assert normalize(candidate,real_account,0)[1][0]['identity_status']=='identity_pending'
        script = """const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const c=vm.createContext({URL,Date,structuredClone});vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),c);
const snapshots=JSON.parse(fs.readFileSync(0,'utf8'));const rows=snapshots.map(s=>c.instagramData.normalize(s).post);
assert.equal(rows[0].identity_status,'verified');assert.equal(rows[0].like_count,71);
assert.equal(rows[0].identity_strategy,'account_permalink_caption_author_and_scoped_time');
for(const row of rows.slice(1)) assert.equal(row.identity_status,'identity_pending');
console.log('Real failed-post replay recovered DeT1BDRjVee; six mismatched/ambiguous evidence cases rejected in JS and Python.');"""
        subprocess.run(['node','-e',script,str(extension/'data.js')],input=json.dumps([real_post]+variants),
                       encoding='utf-8',check=True)
    for changes in [dict(username='unregistered'), dict(page_url='https://www.instagram.com/direct/inbox/'),
                    dict(collected_at_utc='2026-10-22T01:00:00'), dict(history_complete=True),
                    dict(page_url='https://www.instagram.com.evil.invalid/dailyvideo.kg/')]:
        invalid = dict(snapshot, **changes)
        try:
            validate_snapshot(invalid, account)
        except (ValueError, KeyError):
            pass
        else:
            raise AssertionError('unsafe diagnostic accepted')
    with tempfile.TemporaryDirectory(prefix='instagram_contract_') as temporary:
        source = Path(temporary) / 'synthetic.csv'
        row = {key:snapshot[key] for key in COLUMNS[:-1]}
        row['snapshot_json'] = json.dumps(snapshot, ensure_ascii=False)
        with source.open('w', encoding='utf-8-sig', newline='') as stream:
            writer = csv.DictWriter(stream, fieldnames=COLUMNS)
            writer.writeheader(); writer.writerow(row)
        assert load_capture(source)[0][1]['snapshot_json'] == row['snapshot_json']
        destination = import_capture(source, Path(temporary) / 'isolated_outputs')
        evidence = destination / 'page_evidence.csv'
        assert evidence.read_bytes().startswith(b'\xef\xbb\xbf')
        with evidence.open(encoding='utf-8-sig', newline='') as stream:
            imported = next(csv.DictReader(stream))
        assert imported['entity'] == '中国新闻网'
        assert json.loads(imported['snapshot_json'])['visible_text'] == snapshot['visible_text']
        for name in ['posts.csv','comments.csv','posts_in_range.csv']:
            with (destination / name).open(encoding='utf-8-sig',newline='') as stream:
                assert list(csv.DictReader(stream))==[]
        auto = dict(snapshot, collection=dict(run_id='SYNTHETIC_RUN',phase='profile_discovery'),
            run_state_at_export=dict(run_id='SYNTHETIC_RUN',username=account['username'],status='paused',
                stop_reason='user_stop',done=[],scrolls_used=2,expansions_used=3,resume_count=1,
                skipped={'SYNTHETIC_SKIP':{'reason':'post_open_timeout'}}))
        many_row = {key:auto[key] for key in COLUMNS[:-1]}
        many_row['snapshot_json'] = json.dumps(auto,ensure_ascii=False)
        with source.open('w',encoding='utf-8-sig',newline='') as stream:
            writer = csv.DictWriter(stream,fieldnames=COLUMNS)
            writer.writeheader();writer.writerows([many_row]*31)
        automatic_destination = import_capture(source,Path(temporary) / 'isolated_outputs')
        with (automatic_destination / 'automatic_runs.csv').open(encoding='utf-8-sig',newline='') as stream:
            run_record = next(csv.DictReader(stream))
        assert run_record['status']=='paused' and run_record['stop_reason']=='user_stop'
        assert run_record['resume_count']=='1'
        assert run_record['skipped_post_count']=='1'
        with (automatic_destination/'skipped_posts.csv').open(encoding='utf-8-sig',newline='') as stream:
            skipped=next(csv.DictReader(stream));assert skipped['content_id']=='SYNTHETIC_SKIP' and skipped['reason']=='post_open_timeout'
        with (automatic_destination / 'run_status.csv').open(encoding='utf-8-sig',newline='') as stream:
            assert next(csv.DictReader(stream))['reason']=='bounded_automatic_test_history_and_comment_completeness_unverified'
        second=Path(temporary)/'part2.csv'
        second.write_bytes(source.read_bytes())
        combined=import_capture([source,second],Path(temporary)/'isolated_outputs')
        with (combined/'provenance.csv').open(encoding='utf-8-sig',newline='') as stream:
            assert len(list(csv.DictReader(stream)))==2
        assert (combined/'raw_data'/'part2.csv').read_bytes()==second.read_bytes()
    real = ROOT / 'local-fixtures/post-evidence.csv'
    snapshots = []
    if real.exists():
        with real.open(encoding='utf-8-sig',newline='') as stream:
            snapshots = [json.loads(row['snapshot_json']) for row in csv.DictReader(stream)]
        script = """const fs=require('fs'),vm=require('vm');const c=vm.createContext({URL,Date,structuredClone});
vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),c);const snapshots=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(snapshots.filter(s=>s.page_kind==='post').map(s=>c.instagramData.normalize(s))));"""
        result = subprocess.run(['node','-e',script,str(extension/'data.js')],input=json.dumps(snapshots),
                                encoding='utf-8',capture_output=True,check=True)
        for index,(snapshot,js) in enumerate(zip([s for s in snapshots if s['page_kind']=='post'],json.loads(result.stdout))):
            parsed = normalize(snapshot,account,index)
            for field in ['content_id','caption','like_count','period_status']:
                assert js['post'][field]==parsed[1][0][field],(index,field)
            assert len(js['comments'])==len(parsed[2]),index
        print(f'Real CSV JS/Python replay agrees: {len(snapshots)} snapshots, {sum(s["page_kind"]=="post" for s in snapshots)} post observations')
    subprocess.run(['node',str(ROOT/'verify_instagram_v04.js')],input=json.dumps(snapshots) if snapshots else '',
                   encoding='utf-8',check=True)
    print('Python CSV, identity, timezone and isolated import checks passed')


if __name__ == '__main__':
    main()
