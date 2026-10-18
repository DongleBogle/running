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
대회 상세 페이지(race.html)용으로 종목별 참가비(fees), 큰 이미지(poster), 좌표(coords),
최근 10년 대회일 전후 날씨 평균(climate)도 수집해 data/calendar/races/<대회id>.json 에 따로 저장합니다.
(월 파일은 홈·캘린더 목록이 통째로 읽으므로 목록에 필요한 필드만 둡니다. 모두 API 키 없이 수집)
  - 좌표: OpenStreetMap Nominatim (초당 1회 제한) → data/.geo_cache.json 에 캐시
  - 날씨: Open-Meteo Historical Weather API (ERA5) → data/.climate_cache.json 에 캐시
data/calendar/overrides/YYYY-MM.json 에 {대회id: {필드: 값}} 을 넣으면 수집 결과를 덮어씁니다.
"""
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
import time
from datetime import date, datetime
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

BASE = 'https://www.kormarathon.com'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'data', 'calendar')
OVERRIDES_DIR = os.path.join(OUT_DIR, 'overrides')
IMG_DIR = os.path.join(OUT_DIR, 'images')
IMG_PREFIX = 'data/calendar/images/'  # 화면(html)에서 쓰는 상대 경로
RACES_DIR = os.path.join(OUT_DIR, 'races')  # 대회별 상세 정보
LIST_FIELDS = ('id', 'name', 'date', 'location', 'distances', 'image', 'registration')  # 월 파일에 남길 필드
UA = {'User-Agent': 'Mozilla/5.0 (marathon-calendar collector)'}
GEO_CACHE = os.path.join(ROOT, 'data', '.geo_cache.json')
CLIMATE_CACHE = os.path.join(ROOT, 'data', '.climate_cache.json')
CLIMATE_YEARS = 10        # 최근 몇 해의 같은 날짜를 볼지
CLIMATE_WINDOW = 3        # 대회일 앞뒤 며칠까지 평균에 넣을지
RACE_HOURS = range(7, 12)  # 대회가 열리는 오전 시간대(07~11시)


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


def poster_url(u, width=800):
    """상세 페이지용 큰 이미지. Cloudinary 면 가로 800px jpg 로 줄여 쓰고, 아니면 원본."""
    if not u or not u.startswith('http'):
        return ''
    if 'res.cloudinary.com' in u and '/image/upload/' in u:
        return u.replace('/image/upload/', f'/image/upload/c_limit,w_{width},f_jpg,q_auto/', 1)
    return u


def dist_label(c):
    return c.replace('Half', '하프').replace('Full', '풀')


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
    cats = [c for c in cats if c.get('category')]
    dist = list(dict.fromkeys(dist_label(c['category']) for c in cats))
    # 종목별 참가비: 짧은 거리부터, 같은 거리는 일반 → 할인(김천시민 등 설명 있는 항목) 순
    fees = [{'category': dist_label(c['category']), 'km': c.get('distance_km'), 'fee': c.get('fee_amount'),
             'note': c.get('description') or ''}
            for c in sorted(cats, key=lambda c: (c.get('distance_km') or 0, bool(c.get('description')), c.get('sort_index') or 0))]
    opens = ev.get('reg_start_date') or ev.get('additional_reg_start_date')
    closes = max(filter(None, [ev.get('reg_end_date'), ev.get('additional_reg_end_date')]), default=None)
    closed = bool(ev.get('registration_manually_closed')) and not (
        ev.get('additional_reg_end_date') and not ev.get('additional_registration_manually_closed'))
    url = '' if ev.get('official_link_pending') else clean_url(ev.get('apply_link') or ev.get('registration_url'))
    return {
        'id': slug,
        'name': ev.get('name_ko') or ev.get('name_en') or slug,
        'nameEn': ev.get('name_en') or '',
        'date': ev['event_date'],
        'location': ' '.join(filter(None, [ev.get('region'), ev.get('venue')])),
        'region': ev.get('region') or '',
        'venue': ev.get('venue') or '',
        'distances': dist,
        'fees': fees,
        'major': bool(ev.get('is_major')),
        'image': thumb_url(ev.get('image_url') or ev.get('banner_image_url')),
        'poster': poster_url(ev.get('image_url') or ev.get('banner_image_url')),
        'registration': {'opensAt': opens, 'closesAt': closes, 'closed': closed, 'url': url},
        'source': f'{BASE}/ko/races/{slug}',
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


def prune_race_files():
    """어떤 월 파일에도 없는 대회의 상세 파일을 지운다."""
    if not os.path.isdir(RACES_DIR):
        return
    ids = set()
    for n in os.listdir(OUT_DIR):
        if re.fullmatch(r'\d{4}-\d{2}\.json', n):
            ids.update(r['id'] for r in json.load(open(os.path.join(OUT_DIR, n), encoding='utf-8')).get('races', []))
    for n in os.listdir(RACES_DIR):
        if n[:-5] not in ids:
            os.remove(os.path.join(RACES_DIR, n))


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


def load_cache(path):
    try:
        return json.load(open(path, encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def save_cache(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)


# 대회 지역(약칭) → OSM 주소에 나오는 시·도 이름들. 검색 결과가 그 시·도 안인지 확인하는 데 쓴다.
REGIONS = {
    '서울': ['서울특별시'], '부산': ['부산광역시'], '대구': ['대구광역시'], '인천': ['인천광역시'],
    '광주': ['광주광역시'], '대전': ['대전광역시'], '울산': ['울산광역시'], '세종': ['세종특별자치시', '세종시'],
    '경기': ['경기도'], '강원': ['강원특별자치도', '강원도'], '충북': ['충청북도'], '충남': ['충청남도'],
    '전북': ['전북특별자치도', '전라북도'], '전남': ['전라남도'], '경북': ['경상북도'], '경남': ['경상남도'],
    '제주': ['제주특별자치도', '제주도'],
}
_last_geo = [0.0]


def nominatim(q):
    """Nominatim 검색 1건. 이용 정책상 초당 1회를 넘지 않게 호출 간격을 둔다."""
    wait = 1.1 - (time.time() - _last_geo[0])
    if wait > 0:
        time.sleep(wait)
    _last_geo[0] = time.time()
    url = 'https://nominatim.openstreetmap.org/search?' + urlencode(
        {'q': q, 'format': 'json', 'countrycodes': 'kr', 'limit': 3, 'accept-language': 'ko'})
    return json.loads(fetch(url))


def geocode(region, venue, cache):
    """장소 → {lat, lon, precision}. 장소명 전체 → 앞쪽 단어만 → 시·도 순서로 찾고,
    결과 주소가 대회 시·도 안인 것만 받는다. precision: venue(장소) / area(동네) / region(시·도)."""
    names = REGIONS.get(region, [])
    tokens = re.sub(r'\([^)]*\)', ' ', venue).split()
    cands = [(' '.join(tokens[:k]), 'venue' if k == len(tokens) else 'area') for k in range(len(tokens), 0, -1)]
    if region:
        cands.append(((names or [region])[0], 'region'))
    for q, precision in cands:
        if len(q) < 2:
            continue
        if q not in cache:
            try:
                hits = nominatim(q)
            except Exception as e:
                print(f'  geocode skip {q}: {e}', file=sys.stderr)
                continue  # 실패는 캐시하지 않고 다음 후보로
            cache[q] = [{'lat': float(h['lat']), 'lon': float(h['lon']), 'addr': h.get('display_name', '')} for h in hits]
        for h in cache[q]:
            if not names or any(n in h['addr'] for n in names):
                return {'lat': round(h['lat'], 5), 'lon': round(h['lon'], 5), 'precision': precision}
    return None


def fetch_json_retry(url, tries=3):
    for i in range(tries):
        try:
            return json.loads(fetch(url))
        except urllib.error.HTTPError as e:
            if e.code != 429 or i == tries - 1:
                raise
            time.sleep(30 * (i + 1))  # 분당 호출 제한에 걸리면 잠시 쉬었다 다시


def climate(lat, lon, race_date, cache):
    """최근 CLIMATE_YEARS 년 동안 대회일 ±CLIMATE_WINDOW 일의 날씨 평균 (Open-Meteo ERA5 재분석).
    해마다 1주일치만 요청해 API 호출 가중치를 1로 유지한다."""
    y, m, d = map(int, race_date.split('-'))
    years = list(range(y - CLIMATE_YEARS, y))
    key = f'{lat:.2f},{lon:.2f},{m:02d}-{d:02d},{years[0]}-{years[-1]}'
    if key in cache:
        return cache[key]
    days, by_year = [], []
    for yr in years:
        day = date(yr, m, 28 if (m, d) == (2, 29) else d)
        start = date.fromordinal(day.toordinal() - CLIMATE_WINDOW)
        end = date.fromordinal(day.toordinal() + CLIMATE_WINDOW)
        url = 'https://archive-api.open-meteo.com/v1/archive?' + urlencode({
            'latitude': lat, 'longitude': lon, 'start_date': start.isoformat(), 'end_date': end.isoformat(),
            'daily': 'temperature_2m_min,temperature_2m_max,precipitation_sum',
            'hourly': 'temperature_2m,relative_humidity_2m,wind_speed_10m',
            'wind_speed_unit': 'ms', 'timezone': 'Asia/Seoul'})
        data = fetch_json_retry(url)
        dl, hl = data['daily'], data['hourly']
        for i, t in enumerate(dl['time']):
            hrs = [j for j, ht in enumerate(hl['time']) if ht.startswith(t) and int(ht[11:13]) in RACE_HOURS]
            row = {'tmin': dl['temperature_2m_min'][i], 'tmax': dl['temperature_2m_max'][i],
                   'rain': dl['precipitation_sum'][i],
                   'temp': avg(hl['temperature_2m'][j] for j in hrs),
                   'humidity': avg(hl['relative_humidity_2m'][j] for j in hrs),
                   'wind': avg(hl['wind_speed_10m'][j] for j in hrs)}
            days.append(row)
            if t == day.isoformat():
                by_year.append({'year': yr, 'temp': r1(row['temp']), 'tmin': r1(row['tmin']),
                                'tmax': r1(row['tmax']), 'rain': r1(row['rain'])})
    rained = [x['rain'] for x in days if x['rain'] is not None]
    out = {
        'years': [years[0], years[-1]], 'window': CLIMATE_WINDOW, 'hours': [RACE_HOURS[0], RACE_HOURS[-1]],
        'temp': r1(avg(x['temp'] for x in days)), 'tmin': r1(avg(x['tmin'] for x in days)),
        'tmax': r1(avg(x['tmax'] for x in days)), 'humidity': round(avg(x['humidity'] for x in days) or 0),
        'wind': r1(avg(x['wind'] for x in days)),
        'rainChance': round(100 * sum(r >= 1 for r in rained) / len(rained)) if rained else None,
        'byYear': by_year[::-1],  # 최근 해부터
    }
    cache[key] = out
    return out


def avg(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def r1(x):
    return None if x is None else round(x, 1)


def enrich(races):
    """좌표·과거 날씨를 붙인다. overrides 로 coords 를 직접 넣은 대회는 그 좌표를 쓴다."""
    geo_cache, clim_cache = load_cache(GEO_CACHE), load_cache(CLIMATE_CACHE)
    print(f'{len(races)}개 대회 좌표 찾는 중...', file=sys.stderr)
    for r in races:
        if not r.get('coords'):
            r['coords'] = geocode(r.get('region', ''), r.get('venue', ''), geo_cache)
    save_cache(GEO_CACHE, geo_cache)
    print('과거 날씨 평균 계산 중...', file=sys.stderr)
    todo = [r for r in races if r.get('coords')]

    def one(r):
        try:
            return climate(r['coords']['lat'], r['coords']['lon'], r['date'], clim_cache)
        except Exception as e:
            print(f'  climate skip {r["id"]}: {e}', file=sys.stderr)
            return None

    with ThreadPoolExecutor(3) as ex:
        for r, c in zip(todo, ex.map(one, todo)):
            r['climate'] = c
    save_cache(CLIMATE_CACHE, clim_cache)


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
    enrich([r for races in by_month.values() for r in races])
    os.makedirs(RACES_DIR, exist_ok=True)
    for month, races in by_month.items():
        for r in races:
            with open(os.path.join(RACES_DIR, f"{r['id']}.json"), 'w', encoding='utf-8') as f:
                json.dump({**r, 'generatedAt': now}, f, ensure_ascii=False, indent=1)
                f.write('\n')
        listed = [{k: r[k] for k in LIST_FIELDS if k in r} for r in races]
        with open(os.path.join(OUT_DIR, f'{month}.json'), 'w', encoding='utf-8') as f:
            json.dump({'month': month, 'generatedAt': now, 'races': listed}, f, ensure_ascii=False, indent=1)
            f.write('\n')
        print(f'{month}: {len(races)}개', file=sys.stderr)
    prune_images()
    prune_race_files()
    existing = sorted(n[:-5] for n in os.listdir(OUT_DIR) if re.fullmatch(r'\d{4}-\d{2}\.json', n))
    with open(os.path.join(OUT_DIR, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump({'months': existing}, f, ensure_ascii=False, indent=1)
        f.write('\n')


if __name__ == '__main__':
    main()
