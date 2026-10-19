// 홈 · 캘린더 · 변환기 · 대회 상세(race.html)가 같이 쓰는 도우미. platform.js 바로 다음에 불러온다.
const DAY_MS = 86400000;
// 구간 변환기 주로영상 검색은 오늘부터 이 날수 전까지 열린 대회만 (그보다 오래된 대회는 링크를 직접 붙여넣게 안내) (유튜브 검색 할당량 절약). api/race_videos.py 와 맞춘다
const COURSE_SEARCH_DAYS = 21;
const pad2 = n => String(n).padStart(2, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 'YYYY-MM-DD'(뒤에 시각이 붙어도 됨) → 그 날 0시(로컬)
const dayOf = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };

// 종목 배지 색 클래스
function distClass(d) {
  const t = String(d).toLowerCase().replace(/\s/g, '');
  return { '5km': 'd5', '10km': 'd10', '하프': 'dhalf', half: 'dhalf', '풀': 'dfull', full: 'dfull' }[t] || '';
}

// 접수 상태: open | upcoming | closed | unknown. 날짜만 있는 마감일은 그날 끝까지 접수중으로 본다
function regStatus(r) {
  const reg = r.registration || {};
  if (reg.closed) return 'closed';
  const parse = s => s ? new Date(s.length <= 10 ? s + 'T00:00:00' : s) : null;
  const now = new Date();
  const opens = parse(reg.opensAt);
  let closes = parse(reg.closesAt);
  if (closes && String(reg.closesAt).length <= 10) closes = new Date(closes.getTime() + DAY_MS - 1);
  if (!opens && !closes) return 'unknown';
  if (opens && now < opens) return 'upcoming';
  if (closes && now > closes) return 'closed';
  if (new Date(r.date + 'T23:59:59') < now) return 'closed';
  return 'open';
}
const REG_LABEL = { open: '접수중', upcoming: '접수예정', closed: '접수마감', unknown: '접수정보 없음' };

// data/calendar 의 전체 대회 목록(월 파일 합본). 여러 탭이 불러도 한 번만 받는다
let _racesPromise = null;
function loadRaces() {
  if (!_racesPromise) {
    const get = async f => {
      const res = await fetch(Platform.dataUrl('calendar/' + f), { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      return res.json();
    };
    _racesPromise = (async () => {
      const { months = [] } = await get('index.json');
      const files = await Promise.all(months.map(m => get(m + '.json').catch(() => ({ races: [] }))));
      return files.flatMap(f => f.races || []);
    })();
    _racesPromise.catch(() => { _racesPromise = null; });  // 실패하면 다음 호출에서 다시 시도
  }
  return _racesPromise;
}
