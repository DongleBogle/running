"""대회 관련 유튜브 영상 실시간 검색 (YouTube Data API v3)

GET /api/race/videos?name=<대회명>&date=<YYYY-MM-DD>[&kind=course]
  → {"success": true, "query": "...", "videos": [{videoId, url, title, channel, publishedAt, thumbnailUrl, type}]}

- 키: 환경변수 YOUTUBE_API_KEY (Vercel 프로젝트 설정 / 로컬은 .env.local)
- search.list 1회 = 100유닛(결과 50개까지 같은 비용), 기본 한도는 하루 10,000유닛(약 100회)이라
  응답을 CDN 에 12시간 캐시하고(s-maxage), 만료 뒤에도 7일간은 옛 응답을 먼저 주며 뒤에서 갱신한다(stale-while-revalidate).
  CDN 을 거치지 않는 요청(로컬·콜드 리전)을 위해 함수 인스턴스 메모리에도 같은 기간 결과를 들고 있고,
  할당량 초과 등으로 검색이 실패하면 메모리에 남은 옛 결과를 대신 돌려준다.
  할당량 초과 응답은 CDN 에 10분 캐시해 그동안 같은 요청이 API 를 다시 두드리지 않게 한다.
- 실패는 stderr 로 남긴다 (Vercel 대시보드 → Logs 에서 '[race_videos]' 로 검색). 요청 URL 에 키가 들어 있어 URL 은 남기지 않는다.
- 같은 이름의 지난 대회 영상도 참고가 되므로 연도는 빼고 검색하고, 최근 3년 영상만 받는다.
- 영상 길이(lengthSeconds)는 videos.list(1유닛)로 한 번에 받는다.
- kind=course: 구간 변환기 Step 3 용. 오늘(KST)부터 COURSE_SEARCH_DAYS 일 전까지 열린 대회만 검색하고, 그보다 오래된 대회는
  검색 없이 빈 목록을 준다 (할당량 절약, 프런트 common.js 의 COURSE_SEARCH_DAYS 와 맞춘다).
  대회일 이후 올라온 영상만, 3분 이하(쇼츠 등)는 빼고 받는다.
  대회명 검색과 '대회명 주로영상' 검색을 합친다(200유닛). 한쪽만으로는 주로영상이 절반도 안 잡힌다. (주로영상 여부는 type 으로 구분;
  검색어에 '주로영상'을 붙이면 '17km지점'처럼 그 단어가 없는 영상이 빠져서 붙이지 않는다)
"""
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler

# 노출하지 않을 영상의 키워드. 제목이나 설명에 하나라도 있으면 목록에서 뺀다 (영문 대소문자 무시).
# 띄어쓰기는 그대로 비교한다. ('숨 진짜'가 '숨진'에 걸리지 않도록)
# 대회 중 사고·사망 소식, 추모 영상 등이 대회 영상 목록에 섞이지 않게 하려는 것. 필요하면 여기에 추가한다.
BLOCKED_KEYWORDS = [
    '사망', '숨져', '숨진', '숨졌', '별세', '부고', '영면', '추모', '애도', '명복', '고인', '빈소', '장례',
    '심정지', '쓰러져', '쓰러진', '쓰러졌', '의식불명', '응급이송', '병원이송', '사고', '참변', '비보',
    '영원히 기억', '🕊',
]

SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search'
VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos'
COURSE_SEARCH_DAYS = 21
MIN_COURSE_SECONDS = 180  # 이보다 짧은 영상(쇼츠 등)은 주로영상 목록에서 뺀다
CACHE_SECONDS = 12 * 3600          # CDN·메모리 캐시가 새 결과로 보는 기간
STALE_SECONDS = 7 * 24 * 3600      # 이 기간까지는 옛 결과라도 실패 응답 대신 돌려준다
QUOTA_ERROR_CACHE_SECONDS = 600    # 할당량 초과 응답의 CDN 캐시
MAX_RESULTS = 50
KST = timezone(timedelta(hours=9))

# 고정 지점에서 지나가는 주자를 찍은 영상 (제목 기준)
COURSE = re.compile(
    r'주로\s*영상|지점|부근|골인|피니[쉬시]|결승|통과|내\s*모습|급수|반환|모든\s*주자|주자들|passing|finish\s*line',
    re.IGNORECASE)
# 대회명에서 검색·매칭에 의미 없는 말
NOISE = re.compile(r'제\s*\d+\s*회|20\d\d|대회|\(.*?\)')
GENERIC = {'마라톤', '대회', '국제', '전국', '하프', '레이스', 'run', 'marathon', '런'}
# 지역명은 다른 대회 제목에도 흔히 나오므로 이것만 맞아서는 관련 영상으로 보지 않는다
REGIONS = {'서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남',
           '전북', '전남', '경북', '경남', '제주', '춘천', '경주', '수원', '고양', '청주', '전주', '포항', '창원'}


def core_name(name):
    """'2026 JTBC 서울마라톤' → 'JTBC 서울마라톤' (연도·회차 제거)"""
    return re.sub(r'\s+', ' ', NOISE.sub(' ', name)).strip()


def key_tokens(name):
    """제목 매칭용 핵심 단어. '서울마라톤' → '서울' 처럼 흔한 접미어는 떼어낸다."""
    out = []
    for t in core_name(name).lower().split():
        t = re.sub(r'(마라톤|대회|런)$', '', t)
        if len(t) >= 2 and t not in GENERIC:
            out.append(t)
    return out


_BLOCKED = [k.lower() for k in BLOCKED_KEYWORDS]


def is_blocked(*texts):
    """제목·설명에 BLOCKED_KEYWORDS 가 하나라도 있으면 True"""
    t = re.sub(r'\s+', ' ', ' '.join(texts)).lower()
    return any(k in t for k in _BLOCKED)


def is_related(title, tokens):
    """핵심 단어의 절반 이상(최소 1개)이 제목에 있고, 지역명이 아닌 단어가 있으면 그중 하나는 꼭 있어야 한다."""
    if not tokens:
        return True
    t = title.lower().replace(' ', '')
    hit = sum(tok in t for tok in tokens)
    strong = [tok for tok in tokens if tok not in REGIONS]
    return hit >= max(1, (len(tokens) + 1) // 2) and (not strong or any(tok in t for tok in strong))


def iso_seconds(d):
    """ISO 8601 길이(PT1H2M3S) → 초"""
    m = re.fullmatch(r'P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', d or '')
    if not m:
        return None
    dd, h, mi, se = (int(x or 0) for x in m.groups())
    return ((dd * 24 + h) * 60 + mi) * 60 + se


def kst_date(published_at):
    """YouTube publishedAt(UTC, '2024-04-07T00:12:34Z') → 한국 날짜 'YYYY-MM-DD'.
    UTC 날짜를 그대로 자르면 KST 오전 9시 전 업로드가 전날로 잡혀 '대회 전'으로 분류된다."""
    try:
        return datetime.fromisoformat(published_at.replace('Z', '+00:00')).astimezone(KST).strftime('%Y-%m-%d')
    except (AttributeError, ValueError):
        return (published_at or '')[:10]


def fetch_lengths(ids, api_key):
    """videoId → 길이(초). videos.list 는 50개까지 1유닛."""
    if not ids:
        return {}
    out = {}
    for i in range(0, len(ids), 50):
        params = {'part': 'contentDetails', 'id': ','.join(ids[i:i + 50]), 'key': api_key}
        with urllib.request.urlopen(VIDEOS_URL + '?' + urllib.parse.urlencode(params), timeout=10) as r:
            items = json.loads(r.read().decode('utf-8')).get('items', [])
        out.update({it['id']: iso_seconds((it.get('contentDetails') or {}).get('duration')) for it in items})
    return out


def search_race_videos(name, race_date, api_key, kind=''):
    valid_date = bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', race_date or ''))
    year = int(race_date[:4]) if valid_date else date.today().year
    query = core_name(name)
    after = f'{race_date}T00:00:00+09:00' if kind == 'course' and valid_date else f'{year - 2}-01-01T00:00:00Z'
    items = []
    for q in ([query, query + ' 주로영상'] if kind == 'course' else [query]):
        params = {
            'part': 'snippet', 'type': 'video', 'q': q, 'maxResults': MAX_RESULTS,
            'regionCode': 'KR', 'relevanceLanguage': 'ko', 'safeSearch': 'moderate',
            'publishedAfter': after, 'key': api_key,
        }
        with urllib.request.urlopen(SEARCH_URL + '?' + urllib.parse.urlencode(params), timeout=10) as r:
            items += json.loads(r.read().decode('utf-8')).get('items', [])

    tokens = key_tokens(name)
    videos, seen = [], set()
    for it in items:
        vid = (it.get('id') or {}).get('videoId')
        sn = it.get('snippet') or {}
        title = html.unescape(sn.get('title', ''))
        if not vid or vid in seen or not is_related(title, tokens):
            continue
        if is_blocked(title, html.unescape(sn.get('description', ''))):
            continue
        seen.add(vid)
        thumbs = sn.get('thumbnails') or {}
        videos.append({
            'videoId': vid,
            'url': f'https://www.youtube.com/watch?v={vid}',
            'title': title,
            'channel': html.unescape(sn.get('channelTitle', '')),
            'publishedAt': kst_date(sn.get('publishedAt', '')),
            'thumbnailUrl': (thumbs.get('medium') or thumbs.get('default') or {}).get('url', ''),
            'type': 'course' if COURSE.search(title) else 'review',
        })
    # 최근 영상 먼저
    lengths = fetch_lengths([v['videoId'] for v in videos], api_key)
    for v in videos:
        v['lengthSeconds'] = lengths.get(v['videoId'])
    if kind == 'course':
        videos = [v for v in videos if (v['lengthSeconds'] or 0) > MIN_COURSE_SECONDS]
    videos.sort(key=lambda v: v['publishedAt'], reverse=True)
    return {'success': True, 'query': query, 'videos': videos}


# (name, date, kind) → (저장 시각, 결과). 인스턴스가 살아 있는 동안만 유지된다.
_memo = {}


def log_error(msg):
    print(f'[race_videos] {msg}', file=sys.stderr, flush=True)


def handle(query_string):
    """(status, body, cache_seconds) — cache_seconds 가 0 이면 캐시하지 않는다.
    Vercel 핸들러와 로컬 server.py 가 같이 쓴다."""
    qs = urllib.parse.parse_qs(query_string)
    name = (qs.get('name') or [''])[0].strip()[:80]
    race_date = (qs.get('date') or [''])[0].strip()
    kind = (qs.get('kind') or [''])[0].strip()
    if not name:
        return 400, {'error': '대회명(name)이 필요합니다.'}, 0
    if kind == 'course' and re.fullmatch(r'\d{4}-\d{2}-\d{2}', race_date) and \
            race_date < (datetime.now(KST).date() - timedelta(days=COURSE_SEARCH_DAYS)).isoformat():
        return 200, {'success': True, 'query': core_name(name), 'videos': [], 'tooOld': True}, CACHE_SECONDS
    api_key = os.environ.get('YOUTUBE_API_KEY', '').strip()
    if not api_key:
        log_error('YOUTUBE_API_KEY 가 설정되지 않았습니다.')
        return 503, {'error': 'not_configured', 'message': 'YOUTUBE_API_KEY 가 설정되지 않았습니다.'}, 0

    key = (name, race_date, kind)
    hit = _memo.get(key)
    now = time.time()
    if hit and now - hit[0] < CACHE_SECONDS:
        return 200, hit[1], int(CACHE_SECONDS - (now - hit[0]))
    try:
        result = search_race_videos(name, race_date, api_key, kind)
        _memo[key] = (now, result)
        return 200, result, CACHE_SECONDS
    except urllib.error.HTTPError as e:
        reason, message = '', ''
        try:
            err = json.loads(e.read().decode('utf-8'))['error']
            reason, message = err['errors'][0]['reason'], err.get('message', '')
        except Exception:
            pass
        quota = reason in ('quotaExceeded', 'rateLimitExceeded')
        status = 429 if quota else 502
        body = {'error': reason or f'youtube_http_{e.code}'}
        cache = QUOTA_ERROR_CACHE_SECONDS if quota else 0
        log_error(f'YouTube API HTTP {e.code} reason={reason or "-"} name={name!r} date={race_date!r} '
                  f'kind={kind or "-"} message={message}')
    except Exception as e:
        status, body, cache = 502, {'error': f'유튜브 검색 실패: {e}'}, 0
        log_error(f'검색 실패 {type(e).__name__}: {e} name={name!r} date={race_date!r} kind={kind or "-"}')

    # 실패했어도 메모리에 옛 결과가 있으면 그걸 준다 (CDN 에는 짧게만 캐시)
    if hit and now - hit[0] < STALE_SECONDS:
        log_error(f'옛 결과로 대신 응답 ({int((now - hit[0]) / 3600)}시간 전 결과) name={name!r}')
        return 200, hit[1], 600
    return status, body, cache


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        status, data, cache = handle(urllib.parse.urlsplit(self.path).query)
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        if not cache:
            cc = 'no-store'
        elif status == 200:
            cc = f'public, s-maxage={cache}, stale-while-revalidate={STALE_SECONDS}'
        else:  # 실패 응답은 잠깐만 들고 있고 옛 것으로 내주지 않는다
            cc = f'public, s-maxage={cache}'
        self.send_header('Cache-Control', cc)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.end_headers()
