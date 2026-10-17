"""
마라톤별 추천 유튜브 영상 수집 파이프라인

data/marathons.json 의 대회 설정을 읽어
  1) 대회별 검색어로 유튜브 검색 (최신순 + 관련도순)
  2) 제목/설명에 대회명이 있고, 대회일 ~ uploadWindowDays 사이에 올라온 영상만 남김
  3) 제목·설명으로 '주로영상(course)' / '후기(review)' 자동 분류
  4) overrides 로 수동 분류·제외, pinned 로 수동 추가
결과를 data/marathon_videos.json 으로 저장합니다. (Step 3 추천 영상 목록이 이 파일을 읽음)

사용법:
  python3 scripts/collect_marathon_videos.py              # 전체 대회
  python3 scripts/collect_marathon_videos.py seoul-race-2026   # 특정 대회만 다시 수집
"""
import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from youtube_analyzer import (extract_video_id, extract_url_timestamp, detect_distance,  # noqa: E402
                              detect_video_start_clock, detect_finish_offset_m, seconds_to_time_str)

CONFIG_PATH = os.path.join(ROOT, 'data', 'marathons.json')
OUTPUT_PATH = os.path.join(ROOT, 'data', 'marathon_videos.json')
# 영상 상세 메타데이터 캐시 (재실행 시 YouTube 요청 수를 줄여 429 차단을 피함)
CACHE_PATH = os.path.join(ROOT, 'data', '.video_meta_cache.json')

SSL_CTX = ssl._create_unverified_context()
YT_DLP = '/opt/homebrew/bin/yt-dlp' if os.path.exists('/opt/homebrew/bin/yt-dlp') else 'yt-dlp'
# 번역된 제목이 아닌 원본(한국어) 제목을 받기 위해 언어 고정
YT_ARGS = ['--skip-download', '--extractor-args', 'youtube:lang=ko', '--no-warnings']

# 고정 지점에서 지나가는 주자를 찍은 영상 (내 모습 찾기용)
COURSE_STRONG = re.compile(
    r'주로\s*영상|지점|부근|골인|피니[쉬시]|결승|통과|내\s*모습|급수|반환|도착\s*영상|완주\s*영상|'
    r'모든\s*주자|주자들|주자\s*영상|출발\s*(?:영상|모습|풀영상)|passing|finish\s*line|footage',
    re.IGNORECASE)
# 이 표현이 있으면 후기 표현과 섞여 있어도 주로영상으로 본다
COURSE_ABSOLUTE = re.compile(
    r'모든\s*주자|주자들|내\s*모습|통과\s*영상|골인\s*지점|지점\s*영상|급수대|passing', re.IGNORECASE)
# 화질 표기([4K], 2.7K60FPS)는 거리로 오인하지 않도록 제거
RESOLUTION_TAG = re.compile(r'[\[(]\s*\d(?:\.\d)?k\s*[\])]|\b\d(?:\.\d)?k\s*\d{2}\s*fps\b', re.IGNORECASE)
SPOT_DISTANCE = re.compile(r'(\d+(?:\.\d+)?)\s*(?:km|k|키로|킬로)?\s*(?:지점|부근|급수)', re.IGNORECASE)
# 본인이 달린 1인칭 영상·후기·브이로그
REVIEW_HINT = re.compile(
    r'후기|브이로그|vlog|참가기|리뷰|review|recap|도전|썰|1인칭|일인칭|\bpb\b|\d+\s*등\b|'
    r'\d\s*시간\s*\d+\s*분|기록\s*\d|\d+:\d{2}(?::\d{2})?\s*(?:\||$)|페이스메이커|완주했|달성|dnf|'
    r'첫\s*하프|첫\s*풀|나의|my\s',
    re.IGNORECASE)
# 촬영 시각 안내가 있으면 고정 지점 영상일 확률이 높음
SHOOT_TIME_HINT = re.compile(r'촬영\s*(?:시간|시각|장소)|부터\s*촬영|챕터|내\s*모습')


UA_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'ko-KR,ko;q=0.9',
}


def run_yt_dlp(args, timeout=120):
    try:
        res = subprocess.run([YT_DLP] + YT_ARGS + args, capture_output=True, text=True, timeout=timeout)
        return res.stdout
    except subprocess.TimeoutExpired:
        return ''


def _walk_video_renderers(obj):
    if isinstance(obj, dict):
        if 'videoRenderer' in obj:
            yield obj['videoRenderer']
        for v in obj.values():
            yield from _walk_video_renderers(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk_video_renderers(v)


def _text(node):
    if not node:
        return ''
    if 'simpleText' in node:
        return node['simpleText']
    return ''.join(r.get('text', '') for r in node.get('runs', []))


def _length_to_sec(text):
    parts = [int(p) for p in re.findall(r'\d+', text or '')]
    sec = 0
    for p in parts:
        sec = sec * 60 + p
    return sec


def published_range(text, now):
    """'3시간 전', '6일 전', '1주 전' → 업로드 가능 날짜 범위 (earliest, latest)"""
    m = re.search(r'(\d+)\s*(초|분|시간|일|주|개월|년)', text or '')
    if not m:
        return None
    n, unit = int(m.group(1)), m.group(2)
    if unit in ('초', '분', '시간'):
        d = now - timedelta(hours=n if unit == '시간' else 0)
        return d, d
    days = {'일': 1, '주': 7, '개월': 30, '년': 365}[unit]
    return now - timedelta(days=(n + 1) * days - 1), now - timedelta(days=n * days)


def search_videos(query):
    """유튜브 검색 페이지(최신순 + 관련도순)를 직접 파싱. yt-dlp 상세 조회보다 차단에 강함"""
    q = urllib.parse.quote(query)
    urls = [f'https://www.youtube.com/results?search_query={q}&sp=CAI%3D',  # 업로드 날짜순
            f'https://www.youtube.com/results?search_query={q}']
    now = datetime.now()
    results = []
    for url in urls:
        try:
            req = urllib.request.Request(url, headers=UA_HEADERS)
            html = urllib.request.urlopen(req, context=SSL_CTX, timeout=20).read().decode('utf-8', 'ignore')
            m = re.search(r'var ytInitialData = ({.+?});</script>', html)
            data = json.loads(m.group(1)) if m else {}
        except Exception as e:
            print(f"  검색 실패 ({query}): {e}", file=sys.stderr)
            continue
        for v in _walk_video_renderers(data):
            published = _text(v.get('publishedTimeText'))
            snippet = ' '.join(_text(s.get('snippetText')) for s in v.get('detailedMetadataSnippets', []))
            results.append({
                'videoId': v.get('videoId'),
                'title': _text(v.get('title')),
                'channel': _text(v.get('ownerText')),
                'description': snippet,
                'lengthSeconds': _length_to_sec(_text(v.get('lengthText'))),
                'uploadDate': '',
                'uploadRange': published_range(published, now),
                'isLive': '스트리밍' in published or not v.get('lengthText'),
            })
        time.sleep(0.5)
    return [r for r in results if r['videoId']]


def load_cache():
    try:
        with open(CACHE_PATH, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_cache(cache):
    with open(CACHE_PATH, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False)


class DetailFetcher:
    """yt-dlp 로 설명란 전체·정확한 업로드 날짜 조회. 연속 실패(봇 차단)하면 중단하고 검색 결과로 대체"""

    def __init__(self, cache):
        self.cache = cache
        self.failures = 0
        self.disabled = False

    def __call__(self, video_id):
        if video_id in self.cache:
            return self.cache[video_id]
        if self.disabled:
            return None
        out = run_yt_dlp(['-j', '--', video_id], timeout=90)
        try:
            d = json.loads(out.strip().splitlines()[-1])
        except Exception:
            self.failures += 1
            if self.failures >= 3 and not self.disabled:
                self.disabled = True
                print("  yt-dlp 상세 조회가 연속 실패(봇 차단 추정) → 검색 결과 정보로 대체합니다", file=sys.stderr)
            return None
        self.failures = 0
        meta = {
            'videoId': d.get('id', video_id),
            'title': d.get('title', ''),
            'channel': d.get('channel') or d.get('uploader') or '',
            'description': d.get('description') or '',
            'lengthSeconds': int(d.get('duration') or 0),
            'uploadDate': d.get('upload_date') or '',
            'isLive': bool(d.get('was_live') or d.get('is_live')),
            'detailed': True,
        }
        self.cache[video_id] = meta
        return meta


def fetch_oembed(video_id):
    """검색에 안 잡힌 pinned 영상의 최소 정보 (제목·채널)"""
    url = f'https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v={video_id}'
    try:
        req = urllib.request.Request(url, headers=UA_HEADERS)
        d = json.loads(urllib.request.urlopen(req, context=SSL_CTX, timeout=15).read().decode('utf-8'))
    except Exception:
        return None
    return {'videoId': video_id, 'title': d.get('title', ''), 'channel': d.get('author_name', ''),
            'description': '', 'lengthSeconds': 0, 'uploadDate': '', 'uploadRange': None, 'isLive': False}


def contains_any(text, terms):
    t = (text or '').lower()
    return any(term.lower() in t for term in terms)


def classify(meta):
    """'course'(주로영상) 또는 'review'(후기·1인칭) 와 근거 반환"""
    title, desc = meta['title'], meta['description']
    course_title = COURSE_STRONG.search(title)
    review_title = REVIEW_HINT.search(title)
    start_clock, _ = detect_video_start_clock(title, desc)
    shoot_hint = SHOOT_TIME_HINT.search(desc[:1500])

    if meta['isLive']:
        return 'review', '라이브 중계'
    absolute = COURSE_ABSOLUTE.search(title)
    if absolute:
        return 'course', f"제목 '{absolute.group(0)}'"
    if course_title and not review_title:
        return 'course', f"제목 '{course_title.group(0)}'"
    if course_title and review_title and (start_clock is not None or shoot_hint):
        return 'course', f"제목 '{course_title.group(0)}' + 촬영시각 안내"
    if not review_title and shoot_hint and start_clock is not None:
        return 'course', '설명란 촬영시각 안내'
    if review_title:
        return 'review', f"제목 '{review_title.group(0)}'"
    return 'review', '고정 지점 표시 없음'


def title_distance(title):
    """제목의 촬영 지점(km). '1km지점'처럼 지점 표현에 붙은 숫자를 우선"""
    title = RESOLUTION_TAG.sub(' ', title)
    m = SPOT_DISTANCE.search(title)
    dist = float(m.group(1)) if m else detect_distance(title, '')
    return dist if dist is not None and dist < 50 else None


def build_entry(meta, kind, reason, url_ts=None):
    title, desc = meta['title'], meta['description']
    entry = {
        'videoId': meta['videoId'],
        'url': f"https://www.youtube.com/watch?v={meta['videoId']}" + (f'&t={url_ts}s' if url_ts else ''),
        'title': title,
        'channel': meta['channel'],
        'lengthSeconds': meta['lengthSeconds'],
        'uploadDate': meta['uploadDate'],
        'thumbnailUrl': f"https://i.ytimg.com/vi/{meta['videoId']}/mqdefault.jpg",
        'type': kind,
        'reason': reason,
        'detailed': bool(meta.get('detailed')),  # yt-dlp 상세 조회(설명란 전체·정확한 날짜) 여부
    }
    if kind == 'course':
        if detect_finish_offset_m(title, desc) is not None or re.search(r'골인|피니[쉬시]|결승|finish', title, re.I):
            entry['spot'] = '골인/피니시'
        dist = title_distance(title)
        if dist is not None:
            entry['distanceKm'] = dist
        start_clock, _ = detect_video_start_clock(title, desc)
        if start_clock is not None and start_clock >= 5 * 3600:  # 챕터 '00:00' 등 오인 제외
            entry['startClock'] = seconds_to_time_str(start_clock)
    return entry


def refresh_entry(entry, override=None, url=None):
    """이전에 저장된 항목에 현재 분류 규칙(수동 분류·제목 규칙·거리 추출)을 다시 적용"""
    entry = dict(entry)
    entry.setdefault('detailed', True)
    if url:
        entry['url'] = url
    title = entry['title']
    if override in ('course', 'review'):
        entry['type'], entry['reason'] = override, '수동 분류'
    elif entry.get('reason') != '수동 분류' and COURSE_ABSOLUTE.search(title):
        entry['type'], entry['reason'] = 'course', f"제목 '{COURSE_ABSOLUTE.search(title).group(0)}'"
    if entry['type'] == 'course':
        dist = title_distance(title)
        if dist is not None:
            entry['distanceKm'] = dist
        else:
            entry.pop('distanceKm', None)
        if entry.get('startClock', '99') < '05:00:00':
            entry.pop('startClock')
    return entry


def collect_race(race, defaults, fetcher, previous=None):
    race_date = datetime.strptime(race['date'], '%Y-%m-%d')
    window_end = race_date + timedelta(days=race.get('uploadWindowDays', defaults.get('uploadWindowDays', 14)))
    exclude_terms = defaults.get('excludeTerms', []) + race.get('excludeTerms', [])
    overrides = race.get('overrides', {})

    pinned = {}
    for url in race.get('pinned', []):
        vid = extract_video_id(url)
        if vid:
            pinned[vid] = extract_url_timestamp(url)

    # 1) 검색 결과(제목·설명 일부)로 1차 필터링
    found = {}
    for q in race.get('queries', []):
        for item in search_videos(q):
            found.setdefault(item['videoId'], item)
    candidates = {}
    for vid, item in found.items():
        head = f"{item['title']}\n{item['description']}"
        if vid in pinned or overrides.get(vid) in ('course', 'review') or (
                contains_any(head, race['matchTerms']) and not contains_any(item['title'], exclude_terms)):
            candidates[vid] = item
    for vid in pinned:
        if vid not in candidates:
            candidates[vid] = fetch_oembed(vid)
    candidates = {k: v for k, v in candidates.items() if v and overrides.get(k) != 'exclude'}
    print(f"[{race['id']}] 검색 {len(found)}개 중 후보 {len(candidates)}개 상세 조회 중...", file=sys.stderr)

    # 2) 상세 조회(설명란 전체·정확한 업로드 날짜). 실패하면 검색 결과 정보 사용
    with ThreadPoolExecutor(max_workers=2) as pool:
        details = dict(zip(candidates, pool.map(fetcher, list(candidates))))
    save_cache(fetcher.cache)

    videos = []
    for vid, item in candidates.items():
        meta = details.get(vid) or item
        override = overrides.get(vid)
        if vid not in pinned and override not in ('course', 'review'):
            head = f"{meta['title']}\n{meta['description'][:400]}"
            if not contains_any(head, race['matchTerms']):
                continue
            if contains_any(meta['title'], exclude_terms) or contains_any(head, race.get('excludeTerms', [])):
                continue
            if meta.get('uploadDate'):
                uploaded = datetime.strptime(meta['uploadDate'], '%Y%m%d')
                earliest = latest = uploaded
            elif item.get('uploadRange'):
                earliest, latest = item['uploadRange']
            else:
                continue
            if latest.date() < race_date.date() or earliest.date() > window_end.date():
                continue
            if meta['lengthSeconds'] and meta['lengthSeconds'] < 60:  # 쇼츠 제외
                continue
        if not meta.get('uploadDate') and item.get('uploadRange'):
            meta = dict(meta, uploadDate=item['uploadRange'][1].strftime('%Y%m%d'))  # 대략적 날짜
        if override in ('course', 'review'):
            kind, reason = override, '수동 분류'
        else:
            kind, reason = classify(meta)
        videos.append(build_entry(meta, kind, reason, pinned.get(vid)))

    # 3) 이전 수집 결과 누적 (검색 노출이 바뀌어도 한 번 찾은 영상은 유지). 제외 규칙은 다시 적용
    by_id = {v['videoId']: v for v in videos}
    for kind in ('course', 'review'):
        for old in (previous or {}).get(kind, []):
            vid = old['videoId']
            if overrides.get(vid) == 'exclude' or contains_any(old['title'], exclude_terms):
                continue
            new = by_id.get(vid)
            # 이번엔 검색 정보뿐인데 예전엔 상세 조회가 됐다면 예전 항목을 유지
            if new is None or (not new['detailed'] and old.get('detailed', True)):
                by_id[vid] = refresh_entry(old, overrides.get(vid), new and new.get('url'))
    videos = list(by_id.values())

    # 주로영상: 지점(km) 순 → 골인 → 기타 / 후기: 최신순
    def course_key(v):
        if 'distanceKm' in v and v.get('spot') != '골인/피니시':
            return (0, v['distanceKm'])
        return (1 if v.get('spot') else 2, 0)
    course = sorted([v for v in videos if v['type'] == 'course'], key=course_key)
    review = sorted([v for v in videos if v['type'] == 'review'], key=lambda v: v['uploadDate'], reverse=True)
    print(f"[{race['id']}] 주로영상 {len(course)}개 / 후기 {len(review)}개", file=sys.stderr)

    return {
        'id': race['id'],
        'name': race['name'],
        'date': race['date'],
        'location': race.get('location', ''),
        'course': course,
        'review': review,
    }


def main():
    with open(CONFIG_PATH, encoding='utf-8') as f:
        config = json.load(f)
    only = set(sys.argv[1:])

    previous = {}
    if os.path.exists(OUTPUT_PATH):
        with open(OUTPUT_PATH, encoding='utf-8') as f:
            previous = {r['id']: r for r in json.load(f).get('races', [])}

    fetcher = DetailFetcher(load_cache())
    races = []
    for race in config['races']:
        if only and race['id'] not in only:
            if race['id'] in previous:
                races.append(previous[race['id']])
            continue
        races.append(collect_race(race, config.get('defaults', {}), fetcher, previous.get(race['id'])))

    races.sort(key=lambda r: (r['date'], r['name']), reverse=True)
    out = {'generatedAt': datetime.now().strftime('%Y-%m-%dT%H:%M:%S'), 'races': races}
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f"저장 완료: {os.path.relpath(OUTPUT_PATH, ROOT)}", file=sys.stderr)


if __name__ == '__main__':
    main()
