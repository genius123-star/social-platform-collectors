"""Offline regression for the date window carried by a Facebook export."""
import csv
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from import_facebook_probe import convert


def main():
    with TemporaryDirectory(prefix='facebook-import-') as temp:
        source = Path(temp) / 'source' / 'synthetic.csv'
        source.parent.mkdir()
        target = dict(account_key='synthetic_account', profile_url='https://www.facebook.com/synthetic_account/')
        post = dict(target, record_type='post', sample_index='1', visible_article_text='Synthetic post',
                    collected_at_utc='2025-01-17T08:00:00Z', post_url_status='own_time_link_resource',
                    post_url=target['profile_url']+'posts/123456/',
                    raw_post_only_time_elements_json='[{"datetime":"2025-01-16T08:00:00Z"}]')
        for config, count in [({'start_date_bjt':'2025-01-01','end_date_bjt':'2025-01-31'}, 1), (None, 0)]:
            metadata = dict(target, record_type='run_metadata',
                            run_state_json=json.dumps({'config':config} if config else {}))
            with source.open('w',encoding='utf-8',newline='') as stream:
                writer=csv.DictWriter(stream,fieldnames=list(dict.fromkeys([*metadata,*post])))
                writer.writeheader()
                writer.writerows([metadata,post])
            parent = Path(temp) / 'custom output'
            output = convert(source,parent)
            assert output.parent == parent
            assert (output/'raw_data'/source.name).read_bytes() == source.read_bytes()
            with (output/'posts_in_range.csv').open(encoding='utf-8-sig',newline='') as stream:
                rows=list(csv.DictReader(stream))
            assert len(rows)==count, rows
        print('Facebook original date window, legacy fallback and custom output passed')


if __name__=='__main__':
    main()
