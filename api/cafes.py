"""러닝 기록 인증 할인 카페 검색 API (크롤링·일괄 수집 방지 적용)

GET /api/cafes?region=<시도>&spot=<동네코스>&perk=<혜택>&q=<검색어>&page=1&limit=8
  → {"cafes": [...], "total": N, "totalAll": M, "page": 1, "limit": 8, "hasMore": bool, "regions": [...], "spots": [...]}

방어 계층:
1. data/cafes.json 을 정적 공개 폴더(dist/web/data/)에서 제외하고 서버리스 함수 내부에서만 읽는다.
2. 자사 도메인(Origin/Referer) + 프런트 전용 헤더(X-Requested-With) + 봇 User-Agent 검증으로 단순 curl/스크래퍼 차단.
3. IP당 분당 요청 수 제한(Rate Limit)으로 반복 자동화 수집 차단.
4. 페이지네이션(최대 9개/요청)으로 일괄 덤프 방지.
"""
import json
import os
import re
import time
import urllib.parse
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT_DIR, 'data', 'cafes.json')

DEFAULT_LIMIT = 8
MAX_LIMIT = 9

# IP당 슬라이딩 윈도우 요청 제한 (60초당 최대 30회)
RATE_WINDOW_SECONDS = 60
RATE_MAX_REQUESTS = 30
_rate_buckets = defaultdict(deque)

# 허용 호스트 (로컬 개발 · 운영 도메인 · Vercel 미리보기)
ALLOWED_HOSTS = {
    'marathonnote.co.kr',
    'www.marathonnote.co.kr',
    'localhost',
    '127.0.0.1',
}
EXTRA_HOSTS = {
    h.strip().lower()
    for h in os.environ.get('ALLOWED_ORIGINS', '').split(',')
    if h.strip()
}

# 명백한 자동화·스크래핑·AI 봇 User-Agent 패턴
BOT_UA_RE = re.compile(
    r'curl/|wget/|python-requests|python-urllib|httpx|aiohttp|scrapy|go-http-client|'
    r'java/|okhttp|axios/|node-fetch|undici|libwww-perl|php/|ruby|'
    r'headlesschrome|playwright|puppeteer|selenium|phantomjs|'
    r'gptbot|chatgpt-user|ccbot|claudebot|anthropic-ai|bytespider|perplexitybot|semrushbot|ahrefsbot|mj12bot',
    re.IGNORECASE,
)

_cafes_cache = None


def _load_cafes():
    global _cafes_cache
    if _cafes_cache is None:
        with open(DATA_PATH, encoding='utf-8') as f:
            _cafes_cache = json.load(f).get('cafes', [])
    return _cafes_cache


def _compact(s):
    return re.sub(r'\s+', '', str(s or '')).lower()


def _host_allowed(url):
    if not url:
        return False
    try:
        host = (urllib.parse.urlsplit(url).hostname or '').lower()
    except ValueError:
        return False
    if not host:
        return False
    if host in ALLOWED_HOSTS or host in EXTRA_HOSTS:
        return True
    if host.endswith('.vercel.app') or host.endswith('.marathonnote.co.kr'):
        return True
    return False


def _header(headers, name):
    if not headers:
        return ''
    return (headers.get(name) or headers.get(name.lower()) or '').strip()


def _client_ip(headers, fallback_ip=''):
    xff = _header(headers, 'X-Forwarded-For')
    if xff:
        return xff.split(',')[0].strip()
    xri = _header(headers, 'X-Real-IP')
    if xri:
        return xri
    return fallback_ip or 'unknown'


def _check_rate_limit(ip):
    now = time.monotonic()
    q = _rate_buckets[ip]
    cutoff = now - RATE_WINDOW_SECONDS
    while q and q[0] < cutoff:
        q.popleft()
    if len(q) >= RATE_MAX_REQUESTS:
        return False
    q.append(now)
    # 메모리 누적 방지
    if len(_rate_buckets) > 2000:
        stale = [k for k, dq in _rate_buckets.items() if not dq or dq[-1] < cutoff]
        for k in stale:
            del _rate_buckets[k]
    return True


def _check_access(headers):
    ua = _header(headers, 'User-Agent')
    if not ua or BOT_UA_RE.search(ua):
        return False, '허용되지 않은 클라이언트입니다.'

    # 프런트엔드(js/cafe.js) 전용 커스텀 헤더 확인 (브라우저 주소창 직접 입력 및 단순 스크래퍼 차단)
    if _header(headers, 'X-Requested-With') != 'MarathonNote':
        return False, '허용되지 않은 접근입니다.'

    origin = _header(headers, 'Origin')
    referer = _header(headers, 'Referer')
    fetch_site = _header(headers, 'Sec-Fetch-Site').lower()

    # Cross-site 요청 차단 (허용된 출처 제외)
    if fetch_site == 'cross-site' and not (_host_allowed(origin) or _host_allowed(referer)):
        return False, '외부 도메인에서의 접근은 허용되지 않습니다.'

    if origin and not _host_allowed(origin):
        return False, '허용되지 않은 출처입니다.'
    if referer and not _host_allowed(referer):
        return False, '허용되지 않은 경로입니다.'
    if not origin and not referer and fetch_site not in ('same-origin', 'same-site'):
        return False, '허용되지 않은 접근입니다.'

    return True, ''


def _match_perk(c, perk):
    if not perk or perk == 'all':
        return True
    if perk == 'distance':
        return c.get('discountType') == 'distance'
    if perk == 'storage':
        return any(k in p for p in c.get('perks', []) for k in ('보관', '샤워', '탈의'))
    if perk == 'fullfree':
        text = (c.get('discountDetail') or '') + ' ' + (c.get('discountBadge') or '')
        return bool(re.search(r'100%|무료', text))
    return True


def _match_words(c, words):
    if not words:
        return True
    parts = [
        c.get('name'), c.get('region'), c.get('district'), c.get('spot'), c.get('address'),
        c.get('course'), c.get('discountBadge'), c.get('discountDetail'), c.get('condition'),
        *(c.get('perks') or []),
    ]
    hay = '|'.join(_compact(p) for p in parts)
    return all(w in hay for w in words)


def handle(query_string, headers=None, client_ip=''):
    ok, err = _check_access(headers)
    if not ok:
        return 403, {'error': err}

    ip = _client_ip(headers, client_ip)
    if not _check_rate_limit(ip):
        return 429, {'error': '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'}

    params = urllib.parse.parse_qs(query_string or '')
    region = (params.get('region', ['all'])[0] or 'all').strip()
    spot = (params.get('spot', ['all'])[0] or 'all').strip()
    perk = (params.get('perk', ['all'])[0] or 'all').strip()
    q = (params.get('q', [''])[0] or '').strip()

    try:
        page = max(1, int(params.get('page', ['1'])[0]))
    except (ValueError, TypeError):
        page = 1
    try:
        limit = min(MAX_LIMIT, max(1, int(params.get('limit', [str(DEFAULT_LIMIT)])[0])))
    except (ValueError, TypeError):
        limit = DEFAULT_LIMIT

    all_cafes = _load_cafes()

    # 지역별 카운트 (시·도 필터 칩용)
    region_counts = {}
    for c in all_cafes:
        r = c.get('region') or ''
        region_counts[r] = region_counts.get(r, 0) + 1
    regions = [{'name': r, 'count': cnt} for r, cnt in region_counts.items()]

    # 선택된 시·도에 해당하는 동네·코스 목록
    region_pool = all_cafes if region == 'all' else [c for c in all_cafes if c.get('region') == region]
    spots = list(dict.fromkeys(c.get('spot') for c in region_pool if c.get('spot')))
    if spot != 'all' and spot not in spots:
        spot = 'all'

    words = [_compact(w) for w in q.split() if w.strip()]
    filtered = [
        c for c in region_pool
        if (spot == 'all' or c.get('spot') == spot)
        and _match_perk(c, perk)
        and _match_words(c, words)
    ]

    start = (page - 1) * limit
    items = filtered[start:start + limit]

    return 200, {
        'cafes': items,
        'total': len(filtered),
        'totalAll': len(all_cafes),
        'page': page,
        'limit': limit,
        'hasMore': start + len(items) < len(filtered),
        'regions': regions,
        'spots': spots,
    }


def _cors_origin(headers):
    origin = _header(headers, 'Origin')
    return origin if _host_allowed(origin) else ''


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        client_ip = self.client_address[0] if self.client_address else ''
        status, data = handle(urllib.parse.urlsplit(self.path).query, self.headers, client_ip)
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'private, no-store')
        self.send_header('X-Robots-Tag', 'noindex, nofollow')
        if status == 429:
            self.send_header('Retry-After', str(RATE_WINDOW_SECONDS))
        allow = _cors_origin(self.headers)
        if allow:
            self.send_header('Access-Control-Allow-Origin', allow)
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        allow = _cors_origin(self.headers)
        if allow:
            self.send_header('Access-Control-Allow-Origin', allow)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'X-Requested-With')
        self.end_headers()
