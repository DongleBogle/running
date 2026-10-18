// 홈 탭: data/calendar/*.json 으로 곧 열리는 대회(D-day)와 접수중인 대회를 보여준다.
(() => {
  const UPCOMING_DAYS = 14;  // D-day ~ D-14 까지
  const PREVIEW = 6;         // 섹션별로 보여줄 개수 (나머지는 캘린더에서)
  const DAY = 86400000;

  const pad2 = n => String(n).padStart(2, '0');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dayOf = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysFromToday = s => Math.round((dayOf(s) - today) / DAY);
  const fmtDay = s => { const d = dayOf(s); return `${d.getMonth() + 1}/${d.getDate()}(${'일월화수목금토'[d.getDay()]})`; };
  const fmtDateTime = s => !s ? '?' : (s.length > 10 ? `${fmtDay(s)} ${s.slice(11, 16)}` : fmtDay(s));

  // calendar.html 의 calStatus 와 같은 기준
  function isOpen(r) {
    const reg = r.registration || {};
    if (reg.closed || (!reg.opensAt && !reg.closesAt)) return false;
    const opens = reg.opensAt ? new Date(reg.opensAt.length <= 10 ? reg.opensAt + 'T00:00:00' : reg.opensAt) : null;
    const closes = reg.closesAt ? new Date(reg.closesAt.length <= 10 ? reg.closesAt + 'T23:59:59' : reg.closesAt) : null;
    if (opens && now < opens) return false;
    if (closes && now > closes) return false;
    return new Date(r.date + 'T23:59:59') >= now;
  }

  function distClass(d) {
    const t = String(d).toLowerCase().replace(/\s/g, '');
    return { '5km': 'd5', '10km': 'd10', '하프': 'dhalf', half: 'dhalf', '풀': 'dfull', full: 'dfull' }[t] || '';
  }

  // 대표 이미지(정사각형 썸네일). 없거나 못 불러오면 🏃 자리표시
  function thumb(r) {
    return r.image
      ? `<img class="thumb" src="${esc(r.image)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;thumb&quot;>🏃</div>'">`
      : '<div class="thumb">🏃</div>';
  }

  function item(r, badge, extra) {
    const dists = (r.distances || []).map(d => `<span class="dist ${distClass(d)}">${esc(d)}</span>`).join('');
    const detail = `race.html?id=${encodeURIComponent(r.id)}`;
    return `<div class="home-item"><a class="visual" href="${detail}">${thumb(r)}${badge}</a><div class="info">
      <a class="name" href="${detail}">${esc(r.name)} <span class="more">›</span></a>
      <div class="meta">${fmtDay(r.date)} · ${esc(r.location || '')}</div>
      ${dists ? `<div class="dists">${dists}</div>` : ''}${extra || ''}</div></div>`;
  }

  function renderList(listId, html, emptyMsg) {
    document.getElementById(listId).innerHTML = html.length ? html.slice(0, PREVIEW).join('') : `<div class="empty">${emptyMsg}</div>`;
  }

  function render(races) {
    const upcoming = races
      .map(r => ({ r, n: daysFromToday(r.date) }))
      .filter(x => x.n >= 0 && x.n <= UPCOMING_DAYS)
      .sort((a, b) => a.n - b.n || a.r.name.localeCompare(b.r.name));
    document.getElementById('upcomingSub').textContent = `D-day ~ D-${UPCOMING_DAYS} · ${upcoming.length}개`;
    renderList('upcomingList', upcoming.map(({ r, n }) => {
      const cls = n === 0 ? 'today' : n <= 3 ? 'soon' : '';
      return item(r, `<div class="home-dday ${cls}">${n === 0 ? 'D-day' : 'D-' + n}</div>`);
    }), `앞으로 ${UPCOMING_DAYS}일 안에 열리는 대회가 없어요.`);

    // 마감일 가까운 순, 마감일 없는 대회는 뒤로
    const open = races.filter(isOpen).sort((a, b) =>
      (a.registration.closesAt || '9999').localeCompare(b.registration.closesAt || '9999') || a.date.localeCompare(b.date));
    document.getElementById('openSub').textContent = `마감 임박 순 · ${open.length}개`;
    renderList('openList', open.map(r => {
      const reg = r.registration;
      const left = reg.closesAt ? daysFromToday(reg.closesAt) : null;
      const label = left == null ? '접수중' : left === 0 ? '오늘 마감' : `마감 D-${left}`;
      const badge = `<div class="home-dday reg ${left != null && left <= 3 ? 'soon' : ''}">${label}</div>`;
      const extra = `<div class="meta">접수 ${fmtDateTime(reg.opensAt)} ~ ${fmtDateTime(reg.closesAt)}</div>` +
        (reg.url ? `<div class="item-actions"><a class="btn btn-green" href="${esc(reg.url)}" target="_blank" rel="noopener noreferrer">공식 홈페이지에서 신청 ➔</a></div>` : '');
      return item(r, badge, extra);
    }), '지금 접수중인 대회가 없어요.');
  }

  async function loadHome() {
    try {
      const get = async f => (await fetch('data/calendar/' + f, { cache: 'no-cache' })).json();
      const { months = [] } = await get('index.json');
      const files = await Promise.all(months.map(m => get(m + '.json').catch(() => ({ races: [] }))));
      render(files.flatMap(f => f.races || []));
    } catch (e) {
      for (const id of ['upcomingList', 'openList'])
        document.getElementById(id).innerHTML = '<div class="empty">대회 정보를 불러오지 못했습니다.</div>';
    }
  }

  loadHome();
})();
