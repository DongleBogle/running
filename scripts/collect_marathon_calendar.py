#!/usr/bin/env python3
"""마라톤 캘린더 데이터 수집: kormarathon.com 월별 목록 + 대회 상세 → data/marathon_calendar.json

    python3 scripts/collect_marathon_calendar.py                 # 2026-10 ~ 2026-12
    python3 scripts/collect_marathon_calendar.py 2026-10 2027-03  # 월 범위 지정

신청 링크(registration.url)는 대회 공식 홈페이지(apply_link)만 사용하며,
kormarathon 자체 페이지는 링크로 쓰지 않습니다. 공식 링크가 없으면 빈 문자열입니다.
data/marathon_calendar_overrides.json 에 {대회id: {필드: 값}} 을 넣으면 수집 결과를 덮어씁니다.
"""
import json
import os
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

BASE = 'https://www.kormarathon.com'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'marathon_calendar.json')
OVERRIDES = os.path.join(ROOT, 'data', 'marathon_calendar_overrides.json')
UA = {'User-Agent': 'Mozilla/5.0 (marathon-calendar collector)'}


def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode('utf-8', 'replace')


def month_range(a, b):
    y, m = map(int, a.split('-'))
    ey, em = map(int, b.split('-'))
    while (y, m) <= (ey, em):
        yield f'{y}/{m:02d}'
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def clean_url(u):
    if not u:
        return ''
    p = urlsplit(u.strip())
    if not p.scheme.startswith('http') or 'kormarathon' in p.netloc:
        return ''
    q = [(k, v) for k, v in parse_qsl(p.query) if not k.lower().startswith('utm_')]
    return urlunsplit((p.scheme, p.netloc, p.path, urlencode(q), ''))


def parse_event(html, slug):
    s = html.replace('\\"', '"')
    i = s.find('"event":{"content_version"')
    if i < 0:
        return None
    try:
        ev, _ = json.JSONDecoder().raw_decode(s[i + len('"event":'):])
    except ValueError:
        return None
    cats = ev.get('categories') if isinstance(ev.get('categories'), list) else []
    dist = list(dict.fromkeys(c['category'].replace('Half', '하프').replace('Full', '풀') for c in cats if c.get('category')))
    opens = ev.get('reg_start_date') or ev.get('additional_reg_start_date')
    closes = max(filter(None, [ev.get('reg_end_date'), ev.get('additional_reg_end_date')]), default=None)
    closed = bool(ev.get('registration_manually_closed')) and not (
        ev.get('additional_reg_end_date') and not ev.get('additional_registration_manually_closed'))
    url = '' if ev.get('official_link_pending') else clean_url(ev.get('apply_link') or ev.get('registration_url'))
    return {
        'id': slug,
        'name': ev.get('name_ko') or ev.get('name_en') or slug,
        'date': ev['event_date'],
        'location': ' '.join(filter(None, [ev.get('region'), ev.get('venue')])),
        'distances': dist,
        'registration': {'opensAt': opens, 'closesAt': closes, 'closed': closed, 'url': url},
    }


def collect(months):
    slugs = []
    for m in months:
        html = fetch(f'{BASE}/ko/marathons/{m}')
        for s in re.findall(r'/ko/races/([A-Za-z0-9\-_%]+)', html):
            if s not in slugs:
                slugs.append(s)
    print(f'{len(slugs)}개 대회 상세 수집 중...', file=sys.stderr)

    def one(slug):
        try:
            return parse_event(fetch(f'{BASE}/ko/races/{slug}'), slug)
        except Exception as e:  # 네트워크/파싱 실패는 건너뜀
            print(f'  skip {slug}: {e}', file=sys.stderr)
            return None

    with ThreadPoolExecutor(6) as ex:
        races = [r for r in ex.map(one, slugs) if r]
    return sorted(races, key=lambda r: (r['date'], r['name']))


def main():
    args = sys.argv[1:]
    a, b = (args + [None, None])[:2] if args else ('2026-10', '2026-12')
    races = collect(list(month_range(a, b or a)))
    if os.path.exists(OVERRIDES):
        ov = json.load(open(OVERRIDES, encoding='utf-8'))
        for r in races:
            o = ov.get(r['id'])
            if o:
                reg = o.pop('registration', None)
                r.update(o)
                if reg:
                    r['registration'].update(reg)
    data = {
        '_comment': "마라톤 캘린더 데이터 (scripts/collect_marathon_calendar.py 로 생성). 수정은 data/marathon_calendar_overrides.json 에. registration.url 은 대회 공식 홈페이지, closed:true 는 접수 수동 마감.",
        'generatedAt': __import__('datetime').datetime.now().strftime('%Y-%m-%dT%H:%M'),
        'races': races,
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(f'{len(races)}개 저장 → {OUT}', file=sys.stderr)


if __name__ == '__main__':
    main()
