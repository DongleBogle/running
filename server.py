import json
from http.server import HTTPServer, SimpleHTTPRequestHandler
import os
import sys
import subprocess
import time
import uuid
import urllib.parse
from youtube_analyzer import fetch_youtube_metadata, analyze_video_description

PORT = 8080
CLIPS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'clips')
os.makedirs(CLIPS_DIR, exist_ok=True)

# yt-dlp & ffmpeg PATH 보장
ENV = os.environ.copy()
if '/opt/homebrew/bin' not in ENV.get('PATH', ''):
    ENV['PATH'] = f"/opt/homebrew/bin:{ENV.get('PATH', '')}"

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
# 프론트엔드는 `node scripts/build.mjs web` 결과물(dist/web)을 서빙
WEB_DIR = os.path.join(ROOT_DIR, 'dist', 'web')

class RunningAppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == '/api/sample-data':
            sample_data = {
                "title": "2026 서울레이스 (샘플 기록)",
                "startTime": "08:00:00",
                "laps": [
                    {"lap": 1, "timeStr": "5:38.4", "seconds": 338.4, "distance": 1.00, "pace": "5:38"},
                    {"lap": 2, "timeStr": "5:57.8", "seconds": 357.8, "distance": 1.00, "pace": "5:58"},
                    {"lap": 3, "timeStr": "6:04.7", "seconds": 364.7, "distance": 1.00, "pace": "6:05"},
                    {"lap": 4, "timeStr": "6:07.0", "seconds": 367.0, "distance": 1.00, "pace": "6:07"},
                    {"lap": 5, "timeStr": "6:23.7", "seconds": 383.7, "distance": 1.00, "pace": "6:24"},
                    {"lap": 6, "timeStr": "6:35.8", "seconds": 395.8, "distance": 1.00, "pace": "6:36"},
                    {"lap": 7, "timeStr": "6:37.6", "seconds": 397.6, "distance": 1.00, "pace": "6:38"},
                    {"lap": 8, "timeStr": "6:34.1", "seconds": 394.1, "distance": 1.00, "pace": "6:34"},
                    {"lap": 9, "timeStr": "6:04.2", "seconds": 364.2, "distance": 1.00, "pace": "6:04"},
                    {"lap": 10, "timeStr": "6:38.9", "seconds": 398.9, "distance": 1.00, "pace": "6:39"},
                    {"lap": 11, "timeStr": "6:14.1", "seconds": 374.1, "distance": 1.00, "pace": "6:14"},
                    {"lap": 12, "timeStr": "6:30.3", "seconds": 390.3, "distance": 1.00, "pace": "6:30"},
                    {"lap": 13, "timeStr": "6:43.0", "seconds": 403.0, "distance": 1.00, "pace": "6:43"},
                    {"lap": 14, "timeStr": "6:55.8", "seconds": 415.8, "distance": 1.00, "pace": "6:56"},
                    {"lap": 15, "timeStr": "7:33.2", "seconds": 453.2, "distance": 1.00, "pace": "7:33"},
                    {"lap": 16, "timeStr": "7:44.7", "seconds": 464.7, "distance": 1.00, "pace": "7:45"},
                    {"lap": 17, "timeStr": "7:57.5", "seconds": 477.5, "distance": 1.00, "pace": "7:58"},
                    {"lap": 18, "timeStr": "8:08.0", "seconds": 488.0, "distance": 1.00, "pace": "8:08"},
                    {"lap": 19, "timeStr": "8:01.6", "seconds": 481.6, "distance": 1.00, "pace": "8:02"},
                    {"lap": 20, "timeStr": "8:32.7", "seconds": 512.7, "distance": 1.00, "pace": "8:33"},
                    {"lap": 21, "timeStr": "9:18.0", "seconds": 558.0, "distance": 1.00, "pace": "9:18"},
                    {"lap": 22, "timeStr": "1:31.7", "seconds": 91.7, "distance": 0.14, "pace": "10:39"}
                ],
                "defaultYoutubeUrl": "https://www.youtube.com/watch?v=BrF3rE68tWY&t=1159s"
            }
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            self.wfile.write(json.dumps(sample_data, ensure_ascii=False).encode('utf-8'))
            return

        # 다운로드 전용 라우트 (/api/download?file=...)
        if path == '/api/download':
            query = urllib.parse.parse_qs(parsed.query)
            filename = query.get('file', [''])[0]
            if not filename or '/' in filename or '\\' in filename:
                self.send_error(400, "Invalid file")
                return
            filepath = os.path.join(CLIPS_DIR, filename)
            if not os.path.exists(filepath):
                self.send_error(404, "File not found")
                return

            self.send_response(200)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
            self.send_header('Content-Length', str(os.path.getsize(filepath)))
            self.end_headers()
            with open(filepath, 'rb') as f:
                while chunk := f.read(65536):
                    self.wfile.write(chunk)
            return

        return super().do_GET()

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')
        
        try:
            req_data = json.loads(body) if body else {}
        except Exception:
            self.send_json_response({"error": "잘못된 JSON 요청입니다."}, status=400)
            return

        if self.path == '/api/ocr':
            image = req_data.get('image', '')
            if not image:
                self.send_json_response({"error": "이미지가 없습니다."}, status=400)
                return
            try:
                from ocr_engine import analyze_image_b64
                self.send_json_response({"success": True, **analyze_image_b64(image)})
            except ImportError:
                self.send_json_response({"error": "rapidocr-onnxruntime 미설치: pip install rapidocr-onnxruntime"}, status=500)
            except Exception as e:
                self.send_json_response({"error": f"OCR 실패: {str(e)}"}, status=500)
            return

        if self.path == '/api/youtube/analyze':
            url = req_data.get('url', '').strip()
            if not url:
                self.send_json_response({"error": "유튜브 URL을 입력해주세요."}, status=400)
                return

            runner_start_time = req_data.get('startTime', '08:00:00')
            runner_laps = req_data.get('laps', [])
            timeline = req_data.get('timeline', [])

            try:
                # 재계산 시에는 클라이언트가 보낸 영상 정보를 재사용 (유튜브 재조회 생략)
                meta = req_data.get('video') or fetch_youtube_metadata(url)
                analysis = analyze_video_description(
                    meta, url,
                    runner_laps=runner_laps,
                    runner_start_time=runner_start_time,
                    timeline=timeline,
                    override_distance_km=req_data.get('overrideDistanceKm'),
                    override_start_clock=req_data.get('overrideStartClock')
                )
                self.send_json_response({
                    "success": True,
                    "video": meta,
                    "analysis": analysis
                })
            except Exception as e:
                self.send_json_response({"error": f"유튜브 분석 실패: {str(e)}"}, status=500)
            return

        elif self.path == '/api/youtube/create-clip':
            url = req_data.get('url', '').strip()
            start_sec = int(req_data.get('startSeconds', 0))
            duration = int(req_data.get('durationSeconds', 30))
            if duration <= 0:
                duration = 30
            if duration > 60:
                duration = 60  # 최대 1분 제한
            
            end_sec = start_sec + duration
            video_id = req_data.get('videoId', 'clip')
            
            filename = f"marathon_{video_id}_{start_sec}s_{duration}s_{uuid.uuid4().hex[:6]}.mp4"
            output_path = os.path.join(CLIPS_DIR, filename)

            # yt-dlp 명령어로 지정된 시간대 구간(duration초)만 다운로드
            yt_dlp_bin = '/opt/homebrew/bin/yt-dlp'
            if not os.path.exists(yt_dlp_bin):
                yt_dlp_bin = 'yt-dlp'

            cmd = [
                yt_dlp_bin,
                '--no-check-certificates',
                '--extractor-args', 'youtube:player_client=android',
                '--download-sections', f'*{start_sec}-{end_sec}',
                '--force-keyframes-at-cuts',
                '-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
                '--merge-output-format', 'mp4',
                '-o', output_path,
                url
            ]

            try:
                t0 = time.time()
                result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=ENV, timeout=120)
                if result.returncode != 0:
                    err_msg = result.stderr or result.stdout
                    self.send_json_response({"error": f"클립 생성 실패: {err_msg}"}, status=500)
                    return

                if not os.path.exists(output_path):
                    self.send_json_response({"error": "클립 파일이 생성되지 않았습니다."}, status=500)
                    return

                file_size_mb = round(os.path.getsize(output_path) / (1024 * 1024), 2)
                elapsed_proc = round(time.time() - t0, 1)

                self.send_json_response({
                    "success": True,
                    "filename": filename,
                    "downloadUrl": f"/api/download?file={filename}",
                    "directPlayUrl": f"/clips/{filename}",
                    "fileSizeBytes": os.path.getsize(output_path),
                    "fileSizeMb": file_size_mb,
                    "clipStart": start_sec,
                    "clipEnd": end_sec,
                    "duration": duration,
                    "processTimeSec": elapsed_proc
                })
            except subprocess.TimeoutExpired:
                self.send_json_response({"error": "다운로드 시간이 초과되었습니다 (제한 시간 초과)."}, status=504)
            except Exception as e:
                self.send_json_response({"error": f"서버 오류: {str(e)}"}, status=500)
            return

        self.send_error(404, "Endpoint not found")

    def send_json_response(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

def run(port=PORT):
    server_address = ('', port)
    httpd = HTTPServer(server_address, RunningAppHandler)
    print(f"🚀 러닝 타임 컨버터 & 유튜브 클립 서버 시작: http://localhost:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n서버 종료")

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    run(port)
