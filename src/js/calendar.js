// 마라톤 캘린더 탭
let calRaces = [], calLoaded = false, calFilterMode = 'all', calSelected = null;
const calNow = new Date();
let calYear = calNow.getFullYear(), calMonth = calNow.getMonth();

async function loadCalendar() {
  try {
    const get = async f => (await fetch('data/calendar/' + f, { cache: 'no-cache' })).json();
    const { months = [] } = await get('index.json');
    const files = await Promise.all(months.map(m => get(m + '.json').catch(() => ({ races: [] }))));
    calRaces = files.flatMap(f => f.races || []);
    calLoaded = true;
  } catch (e) {
    document.getElementById('calList').innerHTML = '<div class="cal-empty">캘린더 데이터를 불러오지 못했습니다.</div>';
    return;
  }
  renderCalendar();
}

const pad2 = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;
function calParse(s) { return s ? new Date(s.length <= 10 ? s + 'T00:00:00' : s) : null; }

function calStatus(r) {
  const reg = r.registration || {};
  const now = new Date();
  if (reg.closed) return 'closed';
  const opens = calParse(reg.opensAt);
  let closes = calParse(reg.closesAt);
  if (closes && String(reg.closesAt).length <= 10) closes = new Date(closes.getTime() + 86400000 - 1); // 마감일 당일 끝까지
  if (!opens && !closes) return 'unknown';
  if (opens && now < opens) return 'upcoming';
  if (closes && now > closes) return 'closed';
  if (new Date(r.date + 'T23:59:59') < now) return 'closed';
  return 'open';
}
const CAL_LABEL = { open: '접수중', upcoming: '접수예정', closed: '접수마감', unknown: '접수정보 없음' };

const calDistSel = new Set();
function calMatches(r) {
  if (calFilterMode !== 'all' && calStatus(r) !== calFilterMode) return false;
  return !calDistSel.size || (r.distances || []).some(d => calDistSel.has(calDistClass(d)));
}
function calToggleDist(k) {
  calDistSel.has(k) ? calDistSel.delete(k) : calDistSel.add(k);
  document.querySelectorAll('#calDistBar [data-d]').forEach(b => b.classList.toggle('on', calDistSel.has(b.dataset.d)));
  document.getElementById('calDistClear').hidden = !calDistSel.size;
  renderCalendar();
}
function calClearDist() {
  calDistSel.clear();
  document.querySelectorAll('#calDistBar [data-d]').forEach(b => b.classList.remove('on'));
  document.getElementById('calDistClear').hidden = true;
  renderCalendar();
}

function calEventsByDay() {
  const map = {};
  const add = (k, ev) => (map[k] = map[k] || []).push(ev);
  for (const r of calRaces) {
    if (!calMatches(r)) continue;
    add(r.date, { race: r, kind: 'race' });
    const o = r.registration && r.registration.opensAt;
    if (o && calStatus(r) !== 'closed') add(o.slice(0, 10), { race: r, kind: 'open' });
  }
  return map;
}

function renderCalendar() {
  document.getElementById('calMonthLabel').textContent = `${calYear}년 ${calMonth + 1}월`;
  const events = calEventsByDay();
  const first = new Date(calYear, calMonth, 1);
  const start = new Date(calYear, calMonth, 1 - first.getDay());
  const todayKey = ymd(calNow.getFullYear(), calNow.getMonth(), calNow.getDate());
  const maxChips = window.innerWidth <= 640 ? 99 : 3;
  let html = ['일', '월', '화', '수', '목', '금', '토'].map(d => `<div class="cal-dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (i >= 35 && d.getMonth() !== calMonth) break;
    const key = ymd(d.getFullYear(), d.getMonth(), d.getDate());
    const evs = events[key] || [];
    const cls = ['cal-cell', d.getMonth() !== calMonth ? 'other' : '', key === todayKey ? 'today' : '',
      key === calSelected ? 'selected' : '', d.getDay() === 0 ? 'sun' : '', d.getDay() === 6 ? 'sat' : ''].join(' ');
    const chips = evs.slice(0, maxChips).map(e => e.kind === 'race'
      ? `<div class="cal-chip ${calStatus(e.race)}" title="${calEsc(e.race.name)}">${calEsc(e.race.name)}</div>`
      : `<div class="cal-chip optick" title="접수 오픈: ${calEsc(e.race.name)}">접수오픈 ${calEsc(e.race.name)}</div>`).join('');
    const more = evs.length > maxChips ? `<div class="cal-more">+${evs.length - maxChips}개</div>` : '';
    html += `<div class="${cls}" onclick="calSelect('${key}')"><span class="cal-daynum">${d.getDate()}</span><div class="chips">${chips}</div>${more}</div>`;
  }
  document.getElementById('calGrid').innerHTML = html;
  renderCalList();
}

function calEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function calDistClass(d) {
  const t = String(d).toLowerCase().replace(/\s/g, '');
  if (t === '5km') return 'd5';
  if (t === '10km') return 'd10';
  if (t === '하프' || t === 'half') return 'dhalf';
  if (t === '풀' || t === 'full') return 'dfull';
  return '';
}

// 대표 이미지(정사각형 썸네일). 없거나 못 불러오면 🏃 자리표시
function calThumb(r) {
  return r.image
    ? `<img class="cal-thumb" src="${calEsc(r.image)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;cal-thumb&quot;>🏃</div>'">`
    : '<div class="cal-thumb">🏃</div>';
}

function calFmt(s) {
  const d = calParse(s);
  if (!d) return '';
  const base = `${d.getMonth() + 1}/${d.getDate()}`;
  return String(s).length > 10 ? `${base} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : base;
}

function renderCalList() {
  let races, title;
  if (calSelected) {
    races = calRaces.filter(r => calMatches(r) && (r.date === calSelected ||
      (r.registration && r.registration.opensAt && r.registration.opensAt.slice(0, 10) === calSelected)));
    title = `${calSelected} 일정`;
  } else {
    const prefix = `${calYear}-${pad2(calMonth + 1)}`;
    races = calRaces.filter(r => calMatches(r) && r.date.startsWith(prefix));
    title = `${calMonth + 1}월 대회`;
  }
  races.sort((a, b) => a.date.localeCompare(b.date));
  const items = races.map(r => {
    const st = calStatus(r), reg = r.registration || {};
    const period = reg.opensAt || reg.closesAt ? `접수 ${calFmt(reg.opensAt) || '?'} ~ ${calFmt(reg.closesAt) || '?'}` : '';
    const btn = reg.url && st !== 'closed'
      ? `<a class="btn btn-green" href="${calEsc(reg.url)}" target="_blank" rel="noopener noreferrer">${st === 'upcoming' ? '공식 홈페이지 보기' : '공식 홈페이지에서 신청'} ➔</a>`
      : (reg.url ? `<a class="btn btn-outline" href="${calEsc(reg.url)}" target="_blank" rel="noopener noreferrer">공식 홈페이지</a>`
        : (st === 'closed' ? '' : '<span class="meta">공식 링크 준비중</span>'));
    return `<div class="cal-item"><div class="main"><div class="cal-visual">${calThumb(r)}<span class="cal-badge ${st}">${CAL_LABEL[st]}</span></div>
      <div class="info"><div class="name">${calEsc(r.name)}</div>
        <div class="meta">${r.date} · ${calEsc(r.location || '')}</div>
        ${r.distances && r.distances.length ? `<div class="cal-dists">${r.distances.map(d => `<span class="cal-dist ${calDistClass(d)}">${calEsc(d)}</span>`).join('')}</div>` : ''}
        ${period ? `<div class="meta">${period}</div>` : ''}</div></div>${btn}</div>`;
  }).join('');
  const clear = calSelected ? ' <button class="cal-btn" onclick="calSelect(null)">월 전체 보기</button>' : '';
  document.getElementById('calList').innerHTML = `<h3>${title}${clear}</h3>` + (items || '<div class="cal-empty">해당하는 대회가 없습니다.</div>');
}

function calSelect(key) { calSelected = key === calSelected ? null : key; renderCalendar(); }
function calMove(delta) {
  const d = new Date(calYear, calMonth + delta, 1);
  calYear = d.getFullYear(); calMonth = d.getMonth(); calSelected = null; renderCalendar();
}
function calToday() { calYear = calNow.getFullYear(); calMonth = calNow.getMonth(); calSelected = null; renderCalendar(); }
function calFilter(mode) {
  calFilterMode = mode;
  document.querySelectorAll('[data-calf]').forEach(b => b.classList.toggle('active', b.dataset.calf === mode));
  renderCalendar();
}
window.addEventListener('resize', () => { if (calLoaded) renderCalendar(); });
loadCalendar();
