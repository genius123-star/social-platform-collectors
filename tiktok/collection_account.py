"""Resolve an account key, handle or public profile URL without editing the registry."""
import re
from urllib.parse import urlsplit
from common import accounts


def resolve_account(platform, reference):
    if not isinstance(reference, str) or not reference.strip():
        raise ValueError('account_required')
    reference = reference.strip()
    registered = next((a for a in accounts() if a['platform'] == platform and a['key'] == reference), None)
    value = registered['url'] if registered else reference
    if '://' in value:
        parsed = urlsplit(value)
        hosts = ('tiktok.com', 'www.tiktok.com') if platform == 'tiktok' else ('x.com', 'www.x.com', 'twitter.com', 'www.twitter.com')
        if parsed.scheme != 'https' or parsed.hostname not in hosts or parsed.query or parsed.fragment:
            raise ValueError('invalid_account_profile_url')
        value = parsed.path.strip('/')
    handle = value.lstrip('@')
    pattern = r'[A-Za-z0-9_.]{1,24}' if platform == 'tiktok' else r'[A-Za-z0-9_]{1,15}'
    if platform not in ('tiktok', 'x') or not re.fullmatch(pattern, handle):
        raise ValueError('invalid_account_handle')
    if platform == 'x' and handle.lower() in ('home', 'search', 'explore', 'settings', 'messages', 'notifications', 'i', 'intent', 'login', 'logout'):
        raise ValueError('not_an_account_profile')
    if not registered:
        registered = next((a for a in accounts() if a['platform'] == platform and urlsplit(a['url']).path.strip('/').lstrip('@').casefold() == handle.casefold()), None)
    if registered:
        return dict(registered, username=handle, entity=registered.get('entity', '中国日报'))
    # Preserve existing pilot identity; all other handles use unassigned metadata.
    if platform == 'x' and handle.casefold() == 'echinanews':
        return dict(key='cns_x_echinanews', platform='x', username=handle, name=handle, entity='中国新闻网', language='und', url='https://x.com/'+handle)
    url = 'https://www.tiktok.com/@'+handle if platform == 'tiktok' else 'https://x.com/'+handle
    return dict(key=platform+'_'+handle.lower(), platform=platform, username=handle, name=handle, entity='', language='und', url=url)
