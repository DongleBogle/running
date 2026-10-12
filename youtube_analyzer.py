import re
import json
import ssl
import urllib.request
import urllib.parse
from datetime import datetime, timedelta

def extract_video_id(url):
    """유튜브 URL에서 11자리 비디오 ID 추출"""
    patterns = [
        r'(?:v=|\/v\/|youtu\.be\/|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})',
        r'^([a-zA-Z0-9_-]{11})$'
    ]
    for pattern in patterns:
        m = re.search(pattern, url)
        if m:
            return m.group(1)
    return None

def extract_url_timestamp(url):
    """URL의 t= 파라미터에서 초 단위 시간 추출 (예: 1159s, 19m19s, 1159)"""
    m = re.search(r'[?&]t=([0-9hms]+)', url)
    if not m:
        return None
    val = m.group(1)
    if val.isdigit():
        return int(val)
    
    # h, m, s 파싱
    total = 0
    hm_matches = re.findall(r'(\d+)([hms])', val)
    if hm_matches:
        for num, unit in hm_matches:
            if unit == 'h':
                total += int(num) * 3600
            elif unit == 'm':
                total += int(num) * 60
            elif unit == 's':
                total += int(num)
        return total
    
    # 1159s 같은 경우
    m_s = re.match(r'^(\d+)s?$', val)
    if m_s:
        return int(m_s.group(1))
    return None

def fetch_youtube_metadata(url):
    """유튜브 HTML에서 비디오 정보(제목, 채널, 설명, 길이) 추출"""
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
    
    with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
        html = resp.read().decode('utf-8', errors='ignore')
    
    title = ""
    author = ""
    description = ""
    length_seconds = 0
    thumbnail_url = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    
    # ytInitialPlayerResponse 찾기
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
        except Exception:
            pass

    # fallback
    if not title:
        m_title = re.search(r'<meta property="og:title" content="(.*?)"', html)
        if m_title:
            title = m_title.group(1)
            
    if not description:
        m_desc = re.search(r'<meta property="og:description" content="(.*?)"', html)
        if m_desc:
            description = m_desc.group(1)
            
    return {
        "videoId": video_id,
        "cleanUrl": clean_url,
        "title": title,
        "author": author,
        "description": description,
        "lengthSeconds": length_seconds,
        "thumbnailUrl": thumbnail_url
    }

def time_str_to_seconds(time_str):
    """HH:MM:SS 또는 HH:MM 실제 시각(Time of Day) 문자열을 초로 변환"""
    parts = [int(p) for p in str(time_str).strip().split(':')]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    elif len(parts) == 2:
        return parts[0] * 3600 + parts[1] * 60
    return 0

def video_timestamp_to_seconds(ts_str):
    """영상 재생 시간 타임스탬프 (H:MM:SS 또는 MM:SS) -> 초"""
    if not ts_str:
        return 0
    parts = [int(p) for p in str(ts_str).strip().split(':')]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    elif len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return 0

def seconds_to_time_str(seconds):
    """초를 HH:MM:SS 형식으로 변환"""
    seconds = int(seconds)
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"

FINISH_KEYWORDS = r'골인|피니시|결승|마지막\s*꺾|finish'
MAX_CLIP_SECONDS = 60  # 추천 구간 최대 길이
FULL_DISTANCE_KM = 21.0975  # 하프 기준 (랩 정보가 없을 때)


def _clock(h, m, s=0):
    return int(h) * 3600 + int(m) * 60 + int(s)


def parse_chapters(description):
    """
    설명란 챕터에서 (영상 시작초, 실제 시각 시작초, 실제 시각 종료초) 추출
    예: '03:40 촬영시간대 08시 40분~08시 45분' 또는 '00:00 골인 시간대 08시 05분~08시 10분'
    """
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
    """챕터 기준 실제 시각 -> 영상 내 초. 어느 챕터에도 없으면 None"""
    for i, ch in enumerate(chapters):
        if ch["clockStart"] <= clock_sec <= ch["clockEnd"]:
            v_end = chapters[i + 1]["videoStart"] if i + 1 < len(chapters) else (video_length or ch["videoStart"])
            span_c = max(1, ch["clockEnd"] - ch["clockStart"])
            frac = (clock_sec - ch["clockStart"]) / span_c
            return int(ch["videoStart"] + frac * max(0, v_end - ch["videoStart"]))
    return None


def detect_distance(title, desc):
    """제목 우선으로 촬영 지점(km) 탐색. 없으면 None"""
    for text in (title, desc):
        m = re.search(r'(\d+(?:\.\d+)?)\s*(?:km|k)\b', text, re.IGNORECASE)
        if m:
            return float(m.group(1))
    return None


def detect_video_start_clock(title, desc):
    """영상 촬영 시작 시각(초). (초, 근거) 반환"""
    m = re.search(r'([0-1]?[0-9]|2[0-3]):([0-5][0-9])(?::([0-5][0-9]))?\s*(?:부터|촬영|start)', f"{title}\n{desc}")
    if m:
        return _clock(m.group(1), m.group(2), m.group(3) or 0), "설명란 '시각부터'"
    # 제목의 시간 범위: (9:11~9:56) — 설명란은 사진 앨범 시간과 섞이므로 제목만 사용
    m = re.search(r'(\d{1,2})[:;]([0-5]\d)\s*[~\-–]\s*(\d{1,2})[:;]([0-5]\d)', title)
    if m:
        return _clock(m.group(1), m.group(2)), "제목의 시간 범위"
    m = re.search(r'([0-1]?[0-9]|2[0-3])\s*시\s*([0-5][0-9])\s*분(?:\s*([0-5][0-9])\s*초)?', f"{title}\n{desc}")
    if m:
        return _clock(m.group(1), m.group(2), m.group(3) or 0), "설명란 'N시 M분'"
    return None, None


def runner_time_to_distance(runner_laps, dist_km):
    """랩 정보로 dist_km까지의 누적 소요초. 랩이 없으면 372초/km 가정"""
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
    """
    Step 2 타임라인 표에서 target_dist(예: 17.5km)에 해당하는 시점을 선형 보간하여 반환
    """
    if not timeline:
        return None
    sorted_tl = sorted(timeline, key=lambda r: float(r.get("distance", 0)))

    # 1. 오차 0.05km 이내로 일치하는 행이 있으면 그대로 사용
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

    # 2. 범위를 벗어난 경우 (시작 전 또는 완주 후)
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

    # 3. 앞뒤 인접 행 사이 선형 보간
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


def analyze_video_description(video_meta, url, runner_laps=None, runner_start_time="08:00:00", timeline=None):
    """
    영상 1개를 분석해 '내가 등장할 것으로 예상되는 구간' 추출.
    Step 2의 통합 타임라인(timeline)이 있으면 그 결과를 우선 사용하고, 없으면 runner_laps/runner_start_time으로 계산한다.
    """
    title = video_meta.get('title', '')
    desc = video_meta.get('description', '')
    length = int(video_meta.get('lengthSeconds', 0) or 0)
    runner_start_secs = time_str_to_seconds(runner_start_time)

    chapters = parse_chapters(desc)
    is_finish = bool(re.search(FINISH_KEYWORDS, title, re.IGNORECASE))
    detected_distance = detect_distance(title, desc)
    total_km = sum(float(l.get('distance', 0)) for l in (runner_laps or [])) or FULL_DISTANCE_KM

    notes = []
    mode = None
    video_start_secs = None
    calculated = None      # 영상 내 예상 시점(초)
    window = None          # (시작초, 종료초)
    pass_clock = None
    pass_clock_str = None
    point_label = None

    # 1. Step 2 타임라인 표(timeline) 결과 우선 사용
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

    # 2. 타임라인이 없거나 매칭되지 않은 경우 fallback
    if pass_clock is None:
        if detected_distance is None and is_finish:
            detected_distance = round(total_km, 2)

        if detected_distance is not None:
            pass_secs = runner_time_to_distance(runner_laps, detected_distance)
            pass_clock = runner_start_secs + pass_secs
            pass_clock_str = seconds_to_time_str(pass_clock)
            notes.append(f"📍 촬영 지점: **{detected_distance:g}km**" + (" (골인 부근)" if is_finish else ""))
            notes.append(f"🏃 {detected_distance:g}km 통과 예상 시각: **{pass_clock_str}** (출발 {runner_start_time} + {int(pass_secs//60)}분 {int(pass_secs%60)}초)")

    if chapters and detected_distance is not None:
        mode = "chapters"
        notes.append(f"🗂️ 설명란 촬영시간 챕터 {len(chapters)}개 감지")
        if is_finish:
            # 설명란에 '골인 시각보다 약 N~M분 앞선' 안내가 있으면 그 범위, 없으면 골인 시각 ±1분
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
        if video_start_secs is None:
            notes.append("⚠️ 촬영 시작 시각을 찾지 못했습니다.")
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

    # URL의 t= 는 사용자가 붙인 링크 시간일 뿐이므로 무시한다.
    source = "calculated" if calculated is not None else "none"

    clip_start = clip_end = duration = None
    if window is not None:
        w_lo, w_hi = int(window[0]), int(window[1])
        if w_hi - w_lo > MAX_CLIP_SECONDS:  # 최대 길이 초과 시 중앙 기준으로 자름
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
