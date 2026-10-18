"""대회 관련 유튜브 영상 실시간 검색 (YouTube Data API v3)

GET /api/race/videos?name=<대회명>&date=<YYYY-MM-DD>
  → {"success": true, "query": "...", "videos": [{videoId, url, title, channel, publishedAt, thumbnailUrl, type}]}

- 키: 환경변수 YOUTUBE_API_KEY (Vercel 프로젝트 설정 / 로컬은 .env.local)
- search.list 1회 = 100유닛, 기본 한도는 하루 10,000유닛(약 100회)이라
  응답을 CDN 에 6시간 캐시해(s-maxage) 같은 대회는 하루 몇 번만 실제로 검색한다.
- 같은 이름의 지난 대회 영상도 참고가 되므로 연도는 빼고 검색하고, 최근 3년 영상만 받는다.
"""
import html
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from http.server import BaseHTTPRequestHandler

SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search'
CACHE_SECONDS = 6 * 3600
MAX_RESULTS = 25

# 고정 지점에서 지나가는 주자를 찍은 영상 (scripts/collect_marathon_videos.py 의 분류 기준을 간추린 것)
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


def is_related(title, tokens):
    """핵심 단어의 절반 이상(최소 1개)이 제목에 있고, 지역명이 아닌 단어가 있으면 그중 하나는 꼭 있어야 한다."""
    if not tokens:
        return True
    t = title.lower().replace(' ', '')
    hit = sum(tok in t for tok in tokens)
    strong = [tok for tok in tokens if tok not in REGIONS]
    return hit >= max(1, (len(tokens) + 1) // 2) and (not strong or any(tok in t for tok in strong))


def search_race_videos(name, race_date, api_key):
    year = int(race_date[:4]) if re.fullmatch(r'\d{4}-\d{2}-\d{2}', race_date or '') else date.today().year
    query = core_name(name)
    params = {
        'part': 'snippet', 'type': 'video', 'q': query, 'maxResults': MAX_RESULTS,
        'regionCode': 'KR', 'relevanceLanguage': 'ko', 'safeSearch': 'moderate',
        'publishedAfter': f'{year - 2}-01-01T00:00:00Z', 'key': api_key,
    }
    req = urllib.request.Request(SEARCH_URL + '?' + urllib.parse.urlencode(params))
    with urllib.request.urlopen(req, timeout=10) as r:
        items = json.loads(r.read().decode('utf-8')).get('items', [])

    tokens = key_tokens(name)
    videos = []
    for it in items:
        vid = (it.get('id') or {}).get('videoId')
        sn = it.get('snippet') or {}
        title = html.unescape(sn.get('title', ''))
        if not vid or not is_related(title, tokens):
            continue
        thumbs = sn.get('thumbnails') or {}
        videos.append({
            'videoId': vid,
            'url': f'https://www.youtube.com/watch?v={vid}',
            'title': title,
            'channel': html.unescape(sn.get('channelTitle', '')),
            'publishedAt': sn.get('publishedAt', '')[:10],
            'thumbnailUrl': (thumbs.get('medium') or thumbs.get('default') or {}).get('url', ''),
            'type': 'course' if COURSE.search(title) else 'review',
        })
    # 최근 영상 먼저
    videos.sort(key=lambda v: v['publishedAt'], reverse=True)
    return {'success': True, 'query': query, 'videos': videos}


def handle(query_string):
    """(status, body, cache) — Vercel 핸들러와 로컬 server.py 가 같이 쓴다."""
    qs = urllib.parse.parse_qs(query_string)
    name = (qs.get('name') or [''])[0].strip()[:80]
    race_date = (qs.get('date') or [''])[0].strip()
    if not name:
        return 400, {'error': '대회명(name)이 필요합니다.'}, False
    api_key = os.environ.get('YOUTUBE_API_KEY', '').strip()
    if not api_key:
        return 503, {'error': 'not_configured', 'message': 'YOUTUBE_API_KEY 가 설정되지 않았습니다.'}, False
    try:
        return 200, search_race_videos(name, race_date, api_key), True
    except urllib.error.HTTPError as e:
        reason = ''
        try:
            reason = json.loads(e.read().decode('utf-8'))['error']['errors'][0]['reason']
        except Exception:
            pass
        status = 429 if reason in ('quotaExceeded', 'rateLimitExceeded') else 502
        return status, {'error': reason or f'youtube_http_{e.code}'}, False
    except Exception as e:
        return 502, {'error': f'유튜브 검색 실패: {e}'}, False


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        status, data, cache = handle(urllib.parse.urlsplit(self.path).query)
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', f'public, s-maxage={CACHE_SECONDS}, stale-while-revalidate=86400'
                         if cache else 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.end_headers()
