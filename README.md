# MarathonNote

하나의 웹 코드(`src/`)를 웹 · 토스 인앱 · 네이티브 앱(WebView) 세 타깃으로 빌드한다.

```
src/
  index.html               # 유일한 페이지. 상단 탭(/ · /converter · /calendar)으로 화면 전환
  styles/app.css           # 공통 + 변환기
  styles/{shell,home,calendar}.css
  js/shell.js              # 탭 전환 (경로 기반, pushState)
  js/home.js, js/calendar.js
  js/app.js                # 변환기 (플랫폼 무관 로직)
  js/platform/base.js      # 공통 어댑터 (apiUrl, dataUrl, track, openExternal)
  js/platform/{web,toss,app}.js   # 타깃별 덮어쓰기
data/                      # 빌드 시 dist/<target>/data 로 복사
api/                       # Vercel 서버리스 (세 타깃 공용 백엔드)
scripts/build.mjs          # src → dist/<target> 조립
scripts/seo.mjs            # 웹 빌드 시 탭별 HTML·대회별 race/<id>.html·sitemap.xml·robots.txt 생성
```

## 빌드

| 타깃 | 명령 | 결과물 | 비고 |
|---|---|---|---|
| 웹 (Vercel) | `npm run build:web` | `dist/web` | `vercel.json`이 자동 실행 |
| 토스 인앱 | `npm run build:toss` | `dist/toss` → `.ait` | `apps-in-toss.config.ts` |
| 앱 (Capacitor) | `npm run build:app` | `dist/app` | `capacitor.config.json` |

토스/앱은 같은 도메인에 API가 없으므로 `API_BASE`로 배포된 API 주소를 지정한다.

```bash
API_BASE=https://<배포 도메인> npm run build:toss
```

웹 빌드는 검색엔진용 페이지도 함께 만든다(`scripts/seo.mjs`). canonical·og:url·sitemap 에 쓰는 사이트 주소는
운영 도메인 `https://www.marathonnote.co.kr` (환경변수 `SITE_URL`로 바꿀 수 있음). `marathonnote.co.kr`(www 없음) → www 리다이렉트는 Vercel 도메인 설정에서 한다.
검색엔진 소유 확인 meta 는 Vercel 환경변수 `GOOGLE_SITE_VERIFICATION`, `NAVER_SITE_VERIFICATION`에 발급받은 값을 넣으면 홈에 들어간다.

로컬 개발: `npm run dev` (web 빌드 후 `server.py`가 `dist/web`을 서빙)
