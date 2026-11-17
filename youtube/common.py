"""Small bounded pilot. All research outputs are CSV; missing values stay blank."""
import csv
import json
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

VERSION = '0.2.0-pilot'
ROOT = Path(__file__).resolve().parent
BJT = timezone(timedelta(hours=8))
FIELDS = ['account_key','entity','entity_assignment_source','ownership_status','platform','account_language','username','resource_type',
          'resource_id','resource_url','metric','raw_value','value','unit','source',
          'source_locator','collected_at_utc','collected_at_bjt','created_at_utc',
          'created_at_bjt','start_date_bjt','end_date_bjt','status','missing_reason','version']


def accounts():
    return json.loads((ROOT / 'accounts.json').read_text(encoding='utf-8'))


def number(raw):
    if raw is None or raw == '':
        return None
    if isinstance(raw, bool):
        return None
    text = re.sub(r'[\s\u00a0\u202f]', '', str(raw))
    match = re.fullmatch(r'(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)([KkMmBb万亿]?)', text)
    if not match:
        return None  # No guessing locale decimal separators or extracting arbitrary text.
    from decimal import Decimal
    result = Decimal(match[1].replace(',','')) * {'':1,'k':1000,'m':1000000,'b':1000000000,
                                               '万':10000,'亿':100000000}[match[2].lower()]
    return int(result) if result == result.to_integral_value() else None


def instant(raw):
    if raw is None or raw == '':
        return None
    try:
        if isinstance(raw, (float, int)) or str(raw).isdigit():
            return datetime.fromtimestamp(int(raw), timezone.utc)
        value = datetime.fromisoformat(str(raw).replace('Z', '+00:00'))
        return value.astimezone(timezone.utc) if value.tzinfo else None
    except (ValueError, OverflowError, OSError):
        return None


def content_id(platform, url):
    parsed = urlsplit(url)
    host = (parsed.hostname or '').lower()
    if platform == 'youtube' and host in ('www.youtube.com', 'youtube.com'):
        from urllib.parse import parse_qs
        if parsed.path == '/watch':
            value = parse_qs(parsed.query).get('v', [''])[0]
            return value if re.fullmatch(r'[A-Za-z0-9_-]{11}', value) else None
        match = re.fullmatch(r'/(shorts|live)/([A-Za-z0-9_-]{11})/?', parsed.path)
        return match[2] if match else None
    if platform == 'tiktok' and host in ('www.tiktok.com', 'tiktok.com'):
        match = re.fullmatch(r'/@[^/]+/(?:video|photo)/(\d+)/?', parsed.path)
        return match[1] if match else None
    if platform == 'facebook' and host in ('www.facebook.com', 'facebook.com'):
        match = re.search(r'/(?:reel|videos|posts)/(\w+)/?$', parsed.path)
        return match[1] if match else None
    return None


class StopCollection(Exception):
    pass


class Run:
    def __init__(self, account, source, start, end):
        self.account, self.source = account, source
        self.start, self.end = date.fromisoformat(start), date.fromisoformat(end)
        if self.start > self.end:
            raise ValueError('start must be <= end')
        self.observed = datetime.now(timezone.utc)
        stamp = self.observed.strftime('%Y%m%dT%H%M%S%fZ')
        self.path = ROOT/'outputs'/account['platform']/account['language']/account['key']/f'{stamp}_{source}'
        self.path.mkdir(parents=True)
        self.file = (self.path/'observations.csv').open('w',encoding='utf-8-sig',newline='')
        self.writer = csv.DictWriter(self.file, fieldnames=FIELDS)
        self.writer.writeheader()
        self.rows = []
        self.links = set()
        self.counters = {'discovered':0, 'in_range':0, 'out_of_range':0, 'undated':0}

    def emit(self, metric, raw=None, *, rid='', url=None, kind='profile', locator='',
             numeric=False, created=None, missing='not_available_from_source', unit='', value=None):
        value = number(raw) if numeric else raw if value is None else value
        valid = value is not None and value != ''
        timestamp = instant(created)
        collected = datetime.now(timezone.utc)
        row = dict(account_key=self.account['key'], entity='中国日报',
                   entity_assignment_source='账号清单.docx', ownership_status='not_independently_verified',
                   platform=self.account['platform'], account_language=self.account['language'],
                   username=self.account['url'].rstrip('/').split('/')[-1].lstrip('@'),
                   resource_type=kind, resource_id=str(rid), resource_url=url or self.account['url'],
                   metric=metric, raw_value='' if raw is None else str(raw),
                   value='' if value is None else str(value), unit=unit, source=self.source,
                   source_locator=locator, collected_at_utc=collected.isoformat(),
                   collected_at_bjt=collected.astimezone(BJT).isoformat(),
                   created_at_utc=timestamp.isoformat() if timestamp else '',
                   created_at_bjt=timestamp.astimezone(BJT).isoformat() if timestamp else '',
                   start_date_bjt=self.start.isoformat(), end_date_bjt=self.end.isoformat(),
                   status='observed' if valid else 'missing', missing_reason='' if valid else missing,
                   version=VERSION)
        self.rows.append(row)
        self.writer.writerow(row)
        self.file.flush()  # Keep evidence on interruption.

    def in_range(self, raw):
        parsed = instant(raw)
        return None if parsed is None else self.start <= parsed.astimezone(BJT).date() <= self.end

    def content(self, rid, url, raw_date):
        self.counters['discovered'] += 1
        within = self.in_range(raw_date)
        self.counters['undated' if within is None else 'in_range' if within else 'out_of_range'] += 1
        self.emit('discovered_content_url', url, rid=rid, url=url, kind='discovery',
                  created=raw_date, locator='content_link')
        if within is not False:
            self.emit('create_time', raw_date, rid=rid, url=url, kind='content',
                      created=raw_date, locator='platform_timestamp',
                      value=instant(raw_date).isoformat() if instant(raw_date) else '',
                      missing='exact_timestamp_or_timezone_unavailable')
        return within is True  # Undated records never enter in-period statistics.

    def finish(self, status, reason=''):
        self.file.close()
        with (self.path/'run_status.csv').open('w',encoding='utf-8-sig',newline='') as f:
            row = dict(account_key=self.account['key'], source=self.source,
                       collected_at_utc=self.observed.isoformat(), status=status, reason=reason,
                       coverage='bounded_pilot_not_complete', **self.counters, version=VERSION)
            writer = csv.DictWriter(f, fieldnames=list(row)); writer.writeheader(); writer.writerow(row)
        with (self.path/'field_coverage.csv').open('w',encoding='utf-8-sig',newline='') as f:
            writer = csv.writer(f); writer.writerow(['metric','observed','missing','note'])
            for metric in sorted({r['metric'] for r in self.rows}):
                rows = [r for r in self.rows if r['metric'] == metric]
                writer.writerow([metric,sum(r['status']=='observed' for r in rows),
                                 sum(r['status']=='missing' for r in rows),
                                 '仅本次实际尝试的字段与记录，未尝试不代表可获得；不代表账号完整覆盖'])


class Client:
    def __init__(self, headers=None):
        import requests
        self.session = requests.Session()
        self.session.headers.update(headers or {})
        self.last = 0

    def get(self, url, params):
        return self.request('GET',url,params=params)

    def request(self, method, url, **kwargs):
        import requests
        for attempt in range(2):
            time.sleep(max(0, 2.5-(time.monotonic()-self.last)))
            try:
                response = self.session.request(method,url,timeout=(10,25),**kwargs)
            except requests.RequestException as exc:
                # Never print exception URLs: query strings might contain credentials.
                raise StopCollection('network_error:'+type(exc).__name__) from None
            finally:
                self.last = time.monotonic()
            if response.status_code in (401,403,429):
                raise StopCollection(f'api_access_or_rate_limit_http_{response.status_code}')
            if response.status_code >= 500 and attempt == 0:
                continue
            if not response.ok:
                raise StopCollection(f'api_http_{response.status_code}')
            try:
                data = response.json()
            except ValueError:
                raise StopCollection('api_non_json_response') from None
            error = data.get('error')
            if error and (not isinstance(error,dict) or error.get('code') not in ('ok',0,None)):
                raise StopCollection('api_reported_error')
            return data
        raise StopCollection('api_server_error')
