"""Parse full public display dates without inventing a year or timezone."""
import re
from datetime import datetime,timezone,timedelta

def display_time(raw):
    text=str(raw or '').strip()
    result={'raw':text,'display_datetime':'','utc':'','precision':'','status':'full_date_not_available'}
    try:
        iso=datetime.fromisoformat(text.replace('Z','+00:00'))
        precision='second' if re.search(r'[T ]\d{2}:\d{2}:\d{2}',text) else 'minute'
        if 'T' not in text and ' ' not in text:return result
    except ValueError:
        m=re.fullmatch(r'(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(?:(?:星期|周)[一二三四五六日天]\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(北京时间|(?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?)?',text)
        if not m:return result
        try:
            iso=datetime(*map(int,m.group(1,2,3,4,5)),int(m[6] or 0))
            if m[7]:
                if m[7]=='北京时间':offset=timedelta(hours=8)
                else:
                    zone=re.fullmatch(r'(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?',m[7])
                    hours,minutes=int(zone[2]),int(zone[3] or 0)
                    if hours>23 or minutes>59:raise ValueError('invalid UTC offset')
                    offset=timedelta(hours=hours,minutes=minutes)*(1 if zone[1]=='+' else -1)
                iso=iso.replace(tzinfo=timezone(offset))
            precision='second' if m[6] else 'minute'
        except ValueError:
            result['status']='invalid_full_date';return result
    result.update(display_datetime=iso.isoformat(timespec='seconds' if precision=='second' else 'minutes'),precision=precision,
      utc=iso.astimezone(timezone.utc).isoformat() if iso.tzinfo else '',status='explicit_timezone' if iso.tzinfo else 'display_date_available_timezone_unverified')
    return result
