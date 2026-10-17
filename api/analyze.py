import json
import re
import ssl
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler

def extract_video_id(url):
    patterns = [
        r'(?:v=|\/v\/|youtu\.be\/|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})',
        r'^([a-zA-Z0-9_-]{11})$'
    ]
    for pattern in patterns:
        m = re.search(pattern, url)
        if m:
            return m.group(1)
    return None

def fetch_pinned_comment_light(html):
    """yt-dlp 없이 유튜브 웹 내부 Innertube API로 상위/고정 댓글 파싱"""
    try:
        api_key_m = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html)
        token_m = re.search(r'"continuationCommand":\{"token":"([^"]+)"', html)
        if not api_key_m or not token_m:
            return ""
        api_key = api_key_m.group(1)
        token = token_m.group(1)
        
        post_url = f"https://www.youtube.com/youtubei/v1/next?key={api_key}"
        payload = json.dumps({
            "context": {"client": {"clientName": "WEB", "clientVersion": "2.20240101.00.00"}},
            "continuation": token
        }).encode('utf-8')
        
        ctx = ssl._create_unverified_context()
        p_req = urllib.request.Request(
            post_url, data=payload,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
        )
        with urllib.request.urlopen(p_req, context=ctx, timeout=8) as resp:
            data = json.loads(resp.read().decode('utf-8', errors='ignore'))
            
        comments = []
        mutations = data.get('frameworkUpdates', {}).get('entityBatchUpdate', {}).get('mutations', [])
        for m in mutations:
            comment_payload = m.get('payload', {}).get('commentEntityPayload', {})
            if comment_payload:
                content = comment_payload.get('properties', {}).get('content', {}).get('content', '')
                if content:
                    comments.append(content)
        
        for c in comments:
            if re.search(r'촬영\s*시간', c):
                return c
        if comments:
            return comments[0]
    except Exception:
        pass
    return ""

def parse_initial_data(html):
    """watch 페이지 ytInitialData에서 제목/채널/설명란 추출 (videoDetails가 빠진 응답 대비)"""
    try:
        m = re.search(r'ytInitialData\s*=\s*({.+?});\s*</script>', html)
        if not m:
            return "", "", ""
        data = json.loads(m.group(1))
        contents = (data.get('contents', {}).get('twoColumnWatchNextResults', {})
                    .get('results', {}).get('results', {}).get('contents', []))
        title = author = desc = ""
        for c in contents:
            p = c.get('videoPrimaryInfoRenderer')
            if p:
                title = ''.join(r.get('text', '') for r in p.get('title', {}).get('runs', []))
            s = c.get('videoSecondaryInfoRenderer')
            if s:
                desc = s.get('attributedDescription', {}).get('content', '') or \
                    ''.join(r.get('text', '') for r in s.get('description', {}).get('runs', []))
                owner = s.get('owner', {}).get('videoOwnerRenderer', {}).get('title', {})
                author = ''.join(r.get('text', '') for r in owner.get('runs', []))
        return title, author, desc
    except Exception:
        return "", "", ""

def fetch_player_mweb(video_id):
    """Innertube player API(MWEB 클라이언트)로 videoDetails 조회. 영상 길이 확보용 폴백"""
    try:
        payload = json.dumps({
            "context": {"client": {"clientName": "MWEB", "clientVersion": "2.20240101.00.00", "hl": "ko"}},
            "videoId": video_id
        }).encode('utf-8')
        req = urllib.request.Request(
            "https://www.youtube.com/youtubei/v1/player?prettyPrint=false", data=payload,
            headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, context=ssl._create_unverified_context(), timeout=6) as resp:
            return json.loads(resp.read().decode('utf-8', errors='ignore')).get('videoDetails', {}) or {}
    except Exception:
        return {}

def fetch_youtube_metadata(url):
    video_id = extract_video_id(url)
    if not video_id:
        raise ValueError("유효한 유튜브 영상 링크가 아닙니다.")
    
    clean_url = f"https://www.youtube.com/watch?v={video_id}"
    ctx = ssl._create_unverified_context()
    req = urllib.request.Request(
        clean_url,
        headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
        }
    )
    
    with urllib.request.urlopen(req, context=ctx, timeout=8) as resp:
        html = resp.read().decode('utf-8', errors='ignore')
    
    title = ""
    author = ""
    description = ""
    length_seconds = 0
    thumbnail_url = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    
    m_player = re.search(r'ytInitialPlayerResponse\s*=\s*({.+?});(?:var\s|window\[|</script>)', html)
    if m_player:
        try:
            player_data = json.loads(m_player.group(1))
            vd = player_data.get('videoDetails', {})
            title = vd.get('title', '')
            author = vd.get('author', '')
            description = vd.get('shortDescription', '')
            length_seconds = int(vd.get('lengthSeconds', 0))
            thumbs = vd.get('thumbnail', {}).get('thumbnails', [])
            if thumbs:
                thumbnail_url = thumbs[-1].get('url', thumbnail_url)
            if not length_seconds:
                mf = player_data.get('microformat', {}).get('playerMicroformatRenderer', {})
                length_seconds = int(mf.get('lengthSeconds', 0) or 0)
        except Exception:
            pass

    # Vercel(데이터센터 IP)에서는 유튜브가 videoDetails 없는 페이지를 주는 경우가 많아 ytInitialData로 보완
    if not title or not description:
        d_title, d_author, d_desc = parse_initial_data(html)
        title = title or d_title
        author = author or d_author
        description = description or d_desc

    if not title or not length_seconds:
        p = fetch_player_mweb(video_id)
        title = title or p.get('title', '')
        author = author or p.get('author', '')
        description = description or p.get('shortDescription', '')
        try:
            length_seconds = length_seconds or int(p.get('lengthSeconds', 0) or 0)
        except Exception:
            pass

    if not title:
        m_title = re.search(r'<meta property="og:title" content="(.*?)"', html)
        if m_title:
            title = m_title.group(1)
            
    if not description:
        m_desc = re.search(r'<meta property="og:description" content="(.*?)"', html)
        if m_desc:
            description = m_desc.group(1)
            
    pinned_comment = fetch_pinned_comment_light(html)
    if pinned_comment:
        description = f"{description}\n{pinned_comment}"
            
    return {
        "videoId": video_id,
        "cleanUrl": clean_url,
        "title": title,
        "author": author,
        "description": description,
        "pinnedComment": pinned_comment,
        "lengthSeconds": length_seconds,
        "thumbnailUrl": thumbnail_url
    }

def time_str_to_seconds(time_str):
    parts = [int(p) for p in str(time_str).strip().split(':')]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    elif len(parts) == 2:
        return parts[0] * 3600 + parts[1] * 60
    return 0

def video_timestamp_to_seconds(ts_str):
    if not ts_str:
        return 0
    parts = [int(p) for p in str(ts_str).strip().split(':')]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    elif len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return 0

def seconds_to_time_str(seconds):
    seconds = int(seconds)
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"

FINISH_KEYWORDS = r'골인|피니시|피니쉬|결승|마지막\s*꺾|finish'
MAX_CLIP_SECONDS = 60
FULL_DISTANCE_KM = 21.0975

def _clock(h, m, s=0):
    return int(h) * 3600 + int(m) * 60 + int(s)

def parse_chapters(description):
    pat = re.compile(
        r'^\s*((?:\d+:)?\d{1,2}:\d{2})\s+.*?(\d{1,2})\s*시\s*(\d{1,2})\s*분\s*[~\-–]\s*(\d{1,2})\s*시\s*(\d{1,2})\s*분',
        re.MULTILINE)
    chapters = []
    for m in pat.finditer(description or ''):
        chapters.append({
            "videoStart": video_timestamp_to_seconds(m.group(1)),
            "clockStart": _clock(m.group(2), m.group(3)),
            "clockEnd": _clock(m.group(4), m.group(5)),
        })
    chapters.sort(key=lambda c: c["videoStart"])
    return chapters

def clock_to_video_seconds(chapters, clock_sec, video_length):
    for i, ch in enumerate(chapters):
        if ch["clockStart"] <= clock_sec <= ch["clockEnd"]:
            v_end = chapters[i + 1]["videoStart"] if i + 1 < len(chapters) else (video_length or ch["videoStart"])
            span_c = max(1, ch["clockEnd"] - ch["clockStart"])
            frac = (clock_sec - ch["clockStart"]) / span_c
            return int(ch["videoStart"] + frac * max(0, v_end - ch["videoStart"]))
    return None

def detect_finish_offset_m(title, desc):
    pat = r'(?:골인|피니시|피니쉬|결승(?:선)?|finish)\s*(?:지점\s*)?(\d+)\s*m\s*(?:직전|전|앞|남|막판)'
    for text in (title, desc):
        m = re.search(pat, text or '', re.IGNORECASE)
        if m:
            return int(m.group(1))
    return None

def detect_distance_candidates(title, desc):
    """제목 우선으로 km 후보를 모두 수집. '[4K]' 같은 화질 표기는 거리로 보지 않는다."""
    for text in (title, desc):
        cleaned = re.sub(r'[\[\(]\s*\d+\s*K\s*[\]\)]|\d+\s*K\s*(?:UHD|HDR|화질)|\b\d{3,4}p\b', ' ', text or '', flags=re.IGNORECASE)
        found = []
        for m in re.finditer(r'(\d+(?:\.\d+)?)\s*(?:km|k)\b', cleaned, re.IGNORECASE):
            v = float(m.group(1))
            if v not in found:
                found.append(v)
        if found:
            return found
    return []

def detect_distance(title, desc):
    c = detect_distance_candidates(title, desc)
    return c[0] if c else None

def detect_video_start_clock(title, desc):
    m = re.search(r'촬영\s*시간\s*[:：]?\s*(\d{1,2})\s*시\s*(\d{1,2})\s*분', f"{title}\n{desc}")
    if m:
        return _clock(m.group(1), m.group(2)), "설명란/고정댓글 '촬영시간'"
    m = re.search(r'([0-1]?[0-9]|2[0-3]):([0-5][0-9])(?::([0-5][0-9]))?\s*(?:부터|촬영|start)', f"{title}\n{desc}")
    if m:
        return _clock(m.group(1), m.group(2), m.group(3) or 0), "설명란 '시각부터'"
    m = re.search(r'(\d{1,2})[:;]([0-5]\d)\s*[~\-–]\s*(\d{1,2})[:;]([0-5]\d)', title)
    if m:
        return _clock(m.group(1), m.group(2)), "제목의 시간 범위"
    real_lines = '\n'.join(l for l in f"{title}\n{desc}".split('\n') if not re.search(r'라면|이면|예시|예를\s*들', l))
    m = re.search(r'([0-1]?[0-9]|2[0-3])\s*시\s*([0-5][0-9])\s*분(?:\s*([0-5][0-9])\s*초)?', real_lines)
    if m:
        return _clock(m.group(1), m.group(2), m.group(3) or 0), "설명란 'N시 M분'"
    return None, None

def runner_time_to_distance(runner_laps, dist_km):
    if not runner_laps:
        return dist_km * 372.0
    secs, cum = 0.0, 0.0
    for lap in runner_laps:
        d = float(lap.get('distance', 1.0))
        s = float(lap.get('seconds', 0))
        if cum + d <= dist_km + 1e-9:
            secs += s
            cum += d
        else:
            if d > 0:
                secs += s * (dist_km - cum) / d
            break
    return secs

def interpolate_timeline_point(timeline, target_dist, runner_start_secs):
    if not timeline:
        return None
    sorted_tl = sorted(timeline, key=lambda r: float(r.get("distance", 0)))
    exact = next((r for r in sorted_tl if abs(float(r.get("distance", 0)) - target_dist) < 0.05), None)
    if exact:
        pass_clock = int(exact.get("clockSec", 0)) or (runner_start_secs + int(exact.get("elapsedSec", 0)))
        pass_secs = float(exact.get("elapsedSec", max(0, pass_clock - runner_start_secs)))
        return {
            "distance": float(exact.get("distance", target_dist)),
            "pass_clock": pass_clock,
            "pass_clock_str": exact.get("clockStr") or seconds_to_time_str(pass_clock),
            "pass_secs": pass_secs,
            "label": exact.get("label", f"{target_dist:g}km 지점"),
            "is_interpolated": False
        }

    if target_dist <= float(sorted_tl[0].get("distance", 0)):
        first = sorted_tl[0]
        pass_clock = int(first.get("clockSec", 0)) or (runner_start_secs + int(first.get("elapsedSec", 0)))
        pass_secs = float(first.get("elapsedSec", 0))
        return {
            "distance": target_dist,
            "pass_clock": pass_clock,
            "pass_clock_str": seconds_to_time_str(pass_clock),
            "pass_secs": pass_secs,
            "label": f"{target_dist:g}km 지점",
            "is_interpolated": False
        }
    if target_dist >= float(sorted_tl[-1].get("distance", 0)):
        last = sorted_tl[-1]
        pass_clock = int(last.get("clockSec", 0)) or (runner_start_secs + int(last.get("elapsedSec", 0)))
        pass_secs = float(last.get("elapsedSec", 0))
        return {
            "distance": target_dist,
            "pass_clock": pass_clock,
            "pass_clock_str": last.get("clockStr") or seconds_to_time_str(pass_clock),
            "pass_secs": pass_secs,
            "label": f"{target_dist:g}km 지점",
            "is_interpolated": False
        }

    for i in range(len(sorted_tl) - 1):
        d_lo = float(sorted_tl[i].get("distance", 0))
        d_hi = float(sorted_tl[i + 1].get("distance", 0))
        if d_lo <= target_dist <= d_hi:
            frac = (target_dist - d_lo) / (d_hi - d_lo) if d_hi > d_lo else 0
            c_lo = int(sorted_tl[i].get("clockSec", 0)) or (runner_start_secs + int(sorted_tl[i].get("elapsedSec", 0)))
            c_hi = int(sorted_tl[i + 1].get("clockSec", 0)) or (runner_start_secs + int(sorted_tl[i + 1].get("elapsedSec", 0)))
            pass_clock = int(round(c_lo + (c_hi - c_lo) * frac))
            e_lo = float(sorted_tl[i].get("elapsedSec", 0))
            e_hi = float(sorted_tl[i + 1].get("elapsedSec", 0))
            pass_secs = e_lo + (e_hi - e_lo) * frac
            lbl_lo = sorted_tl[i].get("label", f"{d_lo:g}km")
            lbl_hi = sorted_tl[i + 1].get("label", f"{d_hi:g}km")

            return {
                "distance": target_dist,
                "pass_clock": pass_clock,
                "pass_clock_str": seconds_to_time_str(pass_clock),
                "pass_secs": pass_secs,
                "label": f"{target_dist:g}km 지점",
                "is_interpolated": True,
                "interp_range": f"{lbl_lo} ~ {lbl_hi}"
            }
    return None

def analyze_video_description(video_meta, url, runner_laps=None, runner_start_time="08:00:00", timeline=None,
                              override_distance_km=None, override_start_clock=None):
    title = video_meta.get('title', '')
    desc = video_meta.get('description', '')
    length = int(video_meta.get('lengthSeconds', 0) or 0)
    runner_start_secs = time_str_to_seconds(runner_start_time)

    chapters = parse_chapters(desc)
    is_finish = bool(re.search(FINISH_KEYWORDS, title, re.IGNORECASE))
    distance_candidates = detect_distance_candidates(title, desc)
    detected_distance = distance_candidates[0] if distance_candidates else None

    if timeline:
        total_km = float(timeline[-1].get("distance", 0)) or FULL_DISTANCE_KM
    else:
        total_km = sum(float(l.get('distance', 0)) for l in (runner_laps or [])) or FULL_DISTANCE_KM

    finish_offset_m = detect_finish_offset_m(title, desc)
    if finish_offset_m is not None:
        detected_distance = round(total_km - finish_offset_m / 1000.0, 4)
        is_finish = False

    override_note = None
    if override_distance_km not in (None, ''):
        detected_distance = float(override_distance_km)
        is_finish = False
        finish_offset_m = None
        override_note = f"✏️ 촬영 지점을 사용자가 **{detected_distance:g}km**로 지정했습니다."

    notes = []
    if override_note:
        notes.append(override_note)
    if len(distance_candidates) > 1 and override_distance_km in (None, ''):
        notes.append("ℹ️ 영상에 촬영 지점이 여러 개 감지됨: " + ", ".join(f"{d:g}km" for d in distance_candidates) + f" → 우선 {distance_candidates[0]:g}km로 계산했습니다. 다른 지점은 촬영 지점을 직접 지정하세요.")
    mode = None
    video_start_secs = None
    calculated = None
    window = None
    pass_clock = None
    pass_clock_str = None
    point_label = None

    if timeline and len(timeline) > 0:
        if is_finish:
            target_row = timeline[-1]
            detected_distance = float(target_row.get("distance", total_km))
            pass_clock = int(target_row.get("clockSec", 0)) or (runner_start_secs + int(target_row.get("elapsedSec", 0)))
            pass_clock_str = target_row.get("clockStr") or seconds_to_time_str(pass_clock)
            pass_secs = float(target_row.get("elapsedSec", max(0, pass_clock - runner_start_secs)))
            point_label = target_row.get("label", "완주 (Finish)")
            notes.append(f"📍 촬영 지점: **{point_label} ({detected_distance:g}km)**")
            notes.append(f"🏃 {point_label} 통과 시각: **{pass_clock_str}** (Step 2 정밀 타임라인 표 기준, 소요 시간 {int(pass_secs//60)}분 {int(pass_secs%60)}초)")
        elif detected_distance is not None:
            matched = interpolate_timeline_point(timeline, detected_distance, runner_start_secs)
            if matched:
                pass_clock = matched["pass_clock"]
                pass_clock_str = matched["pass_clock_str"]
                pass_secs = matched["pass_secs"]
                point_label = matched["label"]
                interp_info = f" ({matched['interp_range']} 사이 보간)" if matched.get("is_interpolated") else ""
                notes.append(f"📍 촬영 지점: **{point_label}**{interp_info}")
                notes.append(f"🏃 {point_label} 통과 예상 시각: **{pass_clock_str}** (Step 2 정밀 타임라인 표 기준, 출발 {runner_start_time} + {int(pass_secs//60)}분 {int(pass_secs%60)}초)")

    if pass_clock is None:
        if detected_distance is None and is_finish:
            detected_distance = round(total_km, 2)

        if detected_distance is not None:
            pass_secs = runner_time_to_distance(runner_laps, detected_distance)
            pass_clock = runner_start_secs + pass_secs
            pass_clock_str = seconds_to_time_str(pass_clock)
            notes.append(f"📍 촬영 지점: **{detected_distance:g}km**" + (" (골인 부근)" if is_finish else (f" (결승선 {finish_offset_m}m 전)" if finish_offset_m is not None else "")))
            notes.append(f"🏃 {detected_distance:g}km 통과 예상 시각: **{pass_clock_str}** (출발 {runner_start_time} + {int(pass_secs//60)}분 {int(pass_secs%60)}초)")

    if chapters and detected_distance is not None:
        mode = "chapters"
        notes.append(f"🗂️ 설명란 촬영시간 챕터 {len(chapters)}개 감지")
        if is_finish:
            mg = re.search(r'(\d+)\s*[~\-]\s*(\d+)\s*분\s*(?:정도\s*)?앞', desc)
            if mg:
                t_lo, t_hi = pass_clock - int(mg.group(2)) * 60, pass_clock - int(mg.group(1)) * 60
                label = f"골인 {mg.group(1)}~{mg.group(2)}분 전"
            else:
                t_lo, t_hi = pass_clock - 30, pass_clock + 30
                label = "골인 ±30초"
            v_lo = clock_to_video_seconds(chapters, t_lo, length)
            v_hi = clock_to_video_seconds(chapters, t_hi, length)
            if v_lo is not None and v_hi is not None:
                window = (v_lo, v_hi)
                calculated = (v_lo + v_hi) // 2
                notes.append(f"🎯 {label} ({seconds_to_time_str(t_lo)}~{seconds_to_time_str(t_hi)}) 구간")
        else:
            calculated = clock_to_video_seconds(chapters, pass_clock, length)
            if calculated is not None:
                window = (calculated - 30, calculated + 30)
        if calculated is None:
            notes.append("⚠️ 예상 통과 시각이 챕터 촬영 범위 밖입니다.")
    elif detected_distance is not None:
        video_start_secs, basis = detect_video_start_clock(title, desc)
        if override_start_clock not in (None, ''):
            video_start_secs, basis = time_str_to_seconds(override_start_clock), "사용자 지정"
        if video_start_secs is None:
            notes.append("⚠️ 설명란에서 촬영 시작 시각을 찾지 못했습니다. 영상 화면에 표시된 시각을 보고 '촬영 시작 시각'을 직접 지정해주세요.")
        else:
            mode = "start_time"
            notes.append(f"⏱️ 촬영 시작 시각: **{seconds_to_time_str(video_start_secs)}** ({basis})")
            calculated = int(pass_clock - video_start_secs)
            if calculated < 0 or (length and calculated > length):
                notes.append(f"⚠️ 계산된 시점({calculated}초)이 영상 범위(0~{length}초) 밖입니다. 이 영상에는 등장하지 않을 수 있습니다.")
                calculated = None
            else:
                window = (calculated - 30, calculated + 30)
    else:
        notes.append("⚠️ 촬영 지점(km)을 찾지 못했습니다.")

    source = "calculated" if calculated is not None else "none"

    clip_start = clip_end = duration = None
    if window is not None:
        w_lo, w_hi = int(window[0]), int(window[1])
        if w_hi - w_lo > MAX_CLIP_SECONDS:
            mid = (w_lo + w_hi) // 2
            w_lo, w_hi = mid - MAX_CLIP_SECONDS // 2, mid + MAX_CLIP_SECONDS // 2
        clip_start = max(0, w_lo)
        clip_end = w_hi
        if length:
            clip_end = min(clip_end, length)
        duration = max(10, min(MAX_CLIP_SECONDS, clip_end - clip_start))
        clip_end = clip_start + duration
        notes.append(f"✂️ 추천 구간: **{seconds_to_time_str(clip_start)} ~ {seconds_to_time_str(clip_end)}** ({duration}초)")

    return {
        "mode": mode,
        "source": source,
        "detectedDistanceKm": detected_distance,
        "pointLabel": point_label,
        "videoStartTimeStr": seconds_to_time_str(video_start_secs) if video_start_secs is not None else None,
        "videoStartSeconds": video_start_secs,
        "runnerPassClockStr": pass_clock_str or (seconds_to_time_str(pass_clock) if pass_clock is not None else None),
        "calculatedVideoSeconds": calculated if source == "calculated" else None,
        "urlTimestamp": None,
        "primaryTimestamp": calculated,
        "recommendedClipStart": clip_start,
        "recommendedClipEnd": clip_end,
        "recommendedDuration": duration,
        "explanationPoints": notes
    }

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length)
        try:
            req_data = json.loads(post_data.decode('utf-8'))
        except Exception:
            self._send_json({"error": "잘못된 JSON 요청입니다."}, 400)
            return

        url = req_data.get('url', '').strip()
        if not url:
            self._send_json({"error": "유튜브 URL을 입력해주세요."}, 400)
            return

        runner_start_time = req_data.get('startTime', '08:00:00')
        runner_laps = req_data.get('laps', [])
        timeline = req_data.get('timeline', [])

        try:
            meta = req_data.get('video') or fetch_youtube_metadata(url)
            analysis = analyze_video_description(
                meta, url,
                runner_laps=runner_laps,
                runner_start_time=runner_start_time,
                timeline=timeline,
                override_distance_km=req_data.get('overrideDistanceKm'),
                override_start_clock=req_data.get('overrideStartClock')
            )
            self._send_json({
                "success": True,
                "video": meta,
                "analysis": analysis
            }, 200)
        except Exception as e:
            self._send_json({"error": f"유튜브 분석 실패: {str(e)}"}, 500)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
