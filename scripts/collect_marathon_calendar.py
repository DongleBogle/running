#!/usr/bin/env python3
"""마라톤 캘린더 데이터 수집: kormarathon.com 월별 목록 + 대회 상세 → data/calendar/YYYY-MM.json

    python3 scripts/collect_marathon_calendar.py               # 지난달 ~ 2개월 뒤
    python3 scripts/collect_marathon_calendar.py 2026-11       # 해당 월만
    python3 scripts/collect_marathon_calendar.py 2026-10 2027-03

대회일 기준 월별 파일로 저장하고 data/calendar/index.json 에 월 목록을 갱신합니다.
수집하지 않은 월 파일(예: 이미 지난 달)은 그대로 보존됩니다.
신청 링크(registration.url)는 대회 공식 홈페이지(apply_link)만 사용하며,
kormarathon 자체 페이지는 링크로 쓰지 않습니다. 공식 링크가 없으면 빈 문자열입니다.
대표 이미지는 작은 정사각형 썸네일로 받아 data/calendar/images/ 에 저장하고,
image 필드에는 그 상대 경로(data/calendar/images/<hash>.jpg)를 넣습니다.
이미 받은 이미지는 다시 받지 않고, 어떤 월 파일에서도 쓰지 않는 이미지는 지웁니다.
data/calendar/overrides/YYYY-MM.json 에 {대회id: {필드: 값}} 을 넣으면 수집 결과를 덮어씁니다.
"""
import hashlib
import json
import os
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

BASE = 'https://www.kormarathon.com'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'data', 'calendar')
OVERRIDES_DIR = os.path.join(OUT_DIR, 'overrides')
IMG_DIR = os.path.join(OUT_DIR, 'images')
IMG_PREFIX = 'data/calendar/images/'  # 화면(html)에서 쓰는 상대 경로
UA = {'User-Agent': 'Mozilla/5.0 (marathon-calendar collector)'}


def fetch_bytes(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


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


def thumb_url(u, size=128):  # 화면 64px × 레티나 2배
    """대표 이미지 → 정사각형 썸네일(jpg) URL. Cloudinary 가 아니면 원본 그대로 (화면에서 잘라 씀)."""
    if not u or not u.startswith('http'):
        return ''
    if 'res.cloudinary.com' in u and '/image/upload/' in u:
        return u.replace('/image/upload/', f'/image/upload/c_fill,g_auto,w_{size},h_{size},f_jpg,q_auto/', 1)
    return u


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
        'image': thumb_url(ev.get('image_url') or ev.get('banner_image_url')),
        'registration': {'opensAt': opens, 'closesAt': closes, 'closed': closed, 'url': url},
    }


def save_image(url):
    """썸네일을 data/calendar/images/ 에 받아두고 상대 경로를 돌려준다.
    파일명은 원본 URL 해시라 이미지가 바뀌면(URL 버전 변경) 새로 받는다. 실패하면 빈 문자열."""
    if not url or 'res.cloudinary.com' not in url:
        return url  # 원본 크기 그대로라 저장하지 않고 원격 URL 사용
    name = hashlib.sha1(url.encode()).hexdigest()[:16] + '.jpg'
    path = os.path.join(IMG_DIR, name)
    if not os.path.exists(path):
        try:
            data = fetch_bytes(url)
        except Exception as e:
            print(f'  image skip {url}: {e}', file=sys.stderr)
            return ''
        os.makedirs(IMG_DIR, exist_ok=True)
        with open(path, 'wb') as f:
            f.write(data)
    return IMG_PREFIX + name


def prune_images():
    """어떤 월 파일에서도 쓰지 않는 저장 이미지를 지운다."""
    if not os.path.isdir(IMG_DIR):
        return
    used = set()
    for n in os.listdir(OUT_DIR):
        if re.fullmatch(r'\d{4}-\d{2}\.json', n):
            for r in json.load(open(os.path.join(OUT_DIR, n), encoding='utf-8')).get('races', []):
                if str(r.get('image', '')).startswith(IMG_PREFIX):
                    used.add(r['image'][len(IMG_PREFIX):])
    for n in os.listdir(IMG_DIR):
        if n not in used:
            os.remove(os.path.join(IMG_DIR, n))


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
        print(f'{len(races)}개 대회 이미지 저장 중...', file=sys.stderr)
        for r, img in zip(races, ex.map(save_image, [r['image'] for r in races])):
            r['image'] = img
    return sorted(races, key=lambda r: (r['date'], r['name']))


def default_range():
    t = date.today()
    y, m = (t.year - 1, 12) if t.month == 1 else (t.year, t.month - 1)
    ey, em = t.year + (t.month + 2 - 1) // 12, (t.month + 2 - 1) % 12 + 1
    return f'{y}-{m:02d}', f'{ey}-{em:02d}'


def apply_overrides(month, races):
    path = os.path.join(OVERRIDES_DIR, f'{month}.json')
    if not os.path.exists(path):
        return
    ov = json.load(open(path, encoding='utf-8'))
    for r in races:
        o = dict(ov.get(r['id']) or {})
        reg = o.pop('registration', None)
        r.update(o)
        if reg:
            r['registration'].update(reg)


def main():
    args = sys.argv[1:]
    a, b = default_range() if not args else (args[0], args[-1])
    months = list(month_range(a, b))
    by_month = {m.replace('/', '-'): [] for m in months}
    for r in collect(months):
        by_month.setdefault(r['date'][:7], []).append(r)  # 대회일 기준 월로 분류
    os.makedirs(OUT_DIR, exist_ok=True)
    now = datetime.now().strftime('%Y-%m-%dT%H:%M')
    for month, races in by_month.items():
        apply_overrides(month, races)
        with open(os.path.join(OUT_DIR, f'{month}.json'), 'w', encoding='utf-8') as f:
            json.dump({'month': month, 'generatedAt': now, 'races': races}, f, ensure_ascii=False, indent=1)
            f.write('\n')
        print(f'{month}: {len(races)}개', file=sys.stderr)
    prune_images()
    existing = sorted(n[:-5] for n in os.listdir(OUT_DIR) if re.fullmatch(r'\d{4}-\d{2}\.json', n))
    with open(os.path.join(OUT_DIR, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump({'months': existing}, f, ensure_ascii=False, indent=1)
        f.write('\n')


if __name__ == '__main__':
    main()
