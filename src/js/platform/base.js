// 플랫폼 공통 기본 구현. 타깃별 파일(web/toss/app.js)이 필요한 항목만 덮어쓴다.
// __PLATFORM__, __API_BASE__ 는 scripts/build.mjs 가 치환한다.
window.Platform = {
  name: '__PLATFORM__',
  apiBase: '__API_BASE__',
  // 백엔드 API 주소. web은 같은 도메인(상대경로), toss/app은 배포된 API 절대 URL
  apiUrl(path) { return this.apiBase + path; },
  // 번들에 포함된 정적 데이터(data/*.json)
  dataUrl(file) { return 'data/' + file; },
  // 분석/이벤트 로깅
  track(name, props) {},
  // 외부 링크 열기
  openExternal(url) { window.open(url, '_blank', 'noopener'); },
};
