import json
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import os
import sys
import urllib.parse
from api import analyze, race_videos

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))


def load_env_local(path=os.path.join(ROOT_DIR, '.env.local')):
    """.env.local 의 KEY=VALUE 를 환경변수로 (이미 설정된 값은 덮어쓰지 않음). Vercel 에서는 프로젝트 환경변수를 쓴다."""
    if not os.path.exists(path):
        return
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"\''))


load_env_local()

PORT = 8080

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

        if path == '/api/race/videos':
            status, data, _ = race_videos.handle(parsed.query)
            self.send_json_response(data, status=status)
            return

        # 탭 경로(/converter, /calendar)는 모두 같은 index.html 을 내려주고, 화면 전환은 js/shell.js 가 한다
        if path in ('/converter/', '/calendar/'):  # 끝 슬래시가 있으면 상대경로(styles/ 등)가 깨지므로 정리
            self.send_response(301)
            self.send_header('Location', path.rstrip('/'))
            self.end_headers()
            return
        if path in ('/converter', '/calendar'):
            self.path = '/index.html'
        # 대회 상세 /race/<id> 는 race.html 이 주소에서 id 를 읽는다 (vercel.json 과 같은 규칙)
        elif path.startswith('/race/') and '/' not in path[len('/race/'):].rstrip('/'):
            self.path = '/race.html'
        return super().do_GET()

    def do_POST(self):
        if self.path == '/api/youtube/analyze':
            content_length = int(self.headers.get('Content-Length', 0))
            status, data = analyze.handle(self.rfile.read(content_length))
            self.send_json_response(data, status=status)
            return
        self.send_error(404, "Endpoint not found")

    def send_json_response(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

def run(port=PORT):
    server_address = ('', port)
    httpd = ThreadingHTTPServer(server_address, RunningAppHandler)
    print(f"🚀 MarathonNote 서버 시작: http://localhost:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n서버 종료")

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    run(port)
