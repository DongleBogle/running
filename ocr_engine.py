"""RapidOCR(PaddleOCR 모델의 ONNX 버전, Apache-2.0) 기반 러닝 기록 OCR + 파서."""
import base64
import re
from collections import defaultdict

_engine = None


def _get_engine():
    global _engine
    if _engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _engine = RapidOCR()
    return _engine


def run_ocr(image_bytes):
    """이미지 -> [{text, score, box(px 4점)}] , (width, height)"""
    import io
    import numpy as np
    from PIL import Image

    img = Image.open(io.BytesIO(image_bytes)).convert('RGB')
    w, h = img.size
    result, _ = _get_engine()(np.array(img))
    items = []
    for box, text, score in (result or []):
        items.append({"text": text, "score": float(score), "box": box})
    return items, (w, h)


def _group_rows(items):
    """y 중심이 비슷한 텍스트 조각을 한 행으로 묶고 x 순으로 정렬."""
    if not items:
        return []
    for it in items:
        ys = [p[1] for p in it["box"]]
        xs = [p[0] for p in it["box"]]
        it["cy"], it["x0"], it["x1"] = sum(ys) / 4, min(xs), max(xs)
        it["y0"], it["y1"] = min(ys), max(ys)
        it["hh"] = it["y1"] - it["y0"]
    items = sorted(items, key=lambda i: i["cy"])
    rows, cur = [], [items[0]]
    for it in items[1:]:
        ref = sum(c["cy"] for c in cur) / len(cur)
        if abs(it["cy"] - ref) <= max(it["hh"], cur[0]["hh"]) * 0.6:
            cur.append(it)
        else:
            rows.append(cur)
            cur = [it]
    rows.append(cur)
    return [sorted(r, key=lambda i: i["x0"]) for r in rows]


CLOCK_RE = re.compile(r'\b([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)\b')
LAP_RE = re.compile(r'\b(\d{1,2}):([0-5]\d)(?:\.(\d))?\b')
KM_RE = re.compile(r'(\d+(?:\.\d+)?)\s*km', re.I)
DIST_RE = re.compile(r'(?<![\d:.])\d{1,2}\.\d{2}(?![\d:])')


def _norm(t):
    # OCR에서 흔한 오인식 보정
    return t.replace('；', ':').replace(';', ':').replace('·', '.').replace(',', '.')


def parse_running(items, size):
    w, h = size
    rows = _group_rows(items)
    raw_lines, parsed = [], []
    last_lap = 0
    for row in rows:
        line = ' '.join(_norm(i["text"]) for i in row)
        raw_lines.append(line)
        clock_toks = [f"{int(c[0]):02d}:{c[1]}:{c[2]}" for c in CLOCK_RE.findall(line)]
        rest = CLOCK_RE.sub(' ', line)
        km = KM_RE.search(line)
        dist = DIST_RE.search(rest)
        laps = [m.group(0) for m in LAP_RE.finditer(rest)]

        if km and len(clock_toks) >= 1:
            # 체크포인트 행: POINT  TIME  TIME-of-DAY  PACE
            time_str = clock_toks[0]
            clock = clock_toks[1] if len(clock_toks) >= 2 else ''
            pace = laps[-1] if laps else ''
            point, typ = km.group(0), "verified"
        elif dist and laps and '.' in laps[0]:
            # 랩 행: [번호] 시간(M:SS.S) 거리 페이스
            lead = re.match(r'\s*(\d{1,2})\s', line)
            lap_no = int(lead.group(1)) if lead else None
            if lap_no is None or (last_lap and lap_no != last_lap + 1):
                lap_no = last_lap + 1  # 누락/오인식된 번호는 순번으로 보정
            last_lap = lap_no
            time_str, clock = laps[0], ''
            pace = laps[-1] if len(laps) >= 2 else ''
            point, typ = f"Lap {lap_no}", "lap"
            lap_dist = dist.group(0)
        else:
            continue

        x0 = min(i["x0"] for i in row)
        x1 = max(i["x1"] for i in row)
        y0 = min(i["y0"] for i in row)
        y1 = max(i["y1"] for i in row)
        box = {"top": round(y0 / h * 100, 2), "left": round(x0 / w * 100, 2),
               "width": round((x1 - x0) / w * 100, 2), "height": round((y1 - y0) / h * 100, 2)}
        item = {"point": point, "time": time_str, "clock": clock, "pace": pace,
                "type": typ, "box": box}
        if typ == "lap":
            item["lapNo"] = lap_no
            item["dist"] = lap_dist
        parsed.append(item)
    avg = (sum(i["score"] for i in items) / len(items) * 100) if items else 0
    return {"items": parsed, "rawText": '\n'.join(raw_lines),
            "confidence": f"{avg:.1f}", "boxCount": len(items)}


def analyze_image_b64(data_url_or_b64):
    s = data_url_or_b64
    if ',' in s and s.startswith('data:'):
        s = s.split(',', 1)[1]
    items, size = run_ocr(base64.b64decode(s))
    return parse_running(items, size)
