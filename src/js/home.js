// 홈 탭: data/calendar/*.json 으로 곧 열리는 대회(D-day)와 접수중인 대회를 보여준다.
(() => {
  const UPCOMING_DAYS = 14;  // D-day ~ D-14 까지
  const PREVIEW = 6;         // 섹션별로 보여줄 개수 (나머지는 캘린더에서)

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysFromToday = s => Math.round((dayOf(s) - today) / DAY_MS);
  const fmtDay = s => { const d = dayOf(s); return `${d.getMonth() + 1}/${d.getDate()}(${'일월화수목금토'[d.getDay()]})`; };
  const fmtDateTime = s => !s ? '?' : (s.length > 10 ? `${fmtDay(s)} ${s.slice(11, 16)}` : fmtDay(s));

  // 대표 이미지(정사각형 썸네일). 없거나 못 불러오면 🏃 자리표시
  function thumb(r) {
    return r.image
      ? `<img class="thumb" src="${esc(r.image)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;thumb&quot;>🏃</div>'">`
      : '<div class="thumb">🏃</div>';
  }

  function item(r, badge, extra) {
    const dists = (r.distances || []).map(d => `<span class="dist ${distClass(d)}">${esc(d)}</span>`).join('');
    const detail = `race/${encodeURIComponent(r.id)}`;
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
    const open = races.filter(r => regStatus(r) === 'open').sort((a, b) =>
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

  // 띄어쓰기가 달라도 찾히도록 공백을 없애고 비교한다. 검색어가 여러 단어면 모두 포함된 대회만
  const compact = s => String(s || '').toLowerCase().replace(/\s/g, '');
  const matches = (r, words) => {
    const text = [r.name, r.location, ...(r.distances || [])].map(compact).join('|');
    return words.every(w => text.includes(w));
  };

  function renderSearch(races) {
    const words = document.getElementById('homeSearch').value.trim().split(/\s+/).filter(Boolean).map(compact);
    document.getElementById('searchSection').hidden = !words.length;
    document.getElementById('homeBrowse').hidden = !!words.length;
    if (!words.length) return;

    // 앞으로 열릴 대회를 가까운 순으로 먼저, 끝난 대회는 최근 순으로 뒤에
    const found = races.filter(r => matches(r, words)).map(r => ({ r, n: daysFromToday(r.date) })).sort((a, b) =>
      (a.n < 0) - (b.n < 0) || (a.n < 0 ? b.n - a.n : a.n - b.n) || a.r.name.localeCompare(b.r.name));
    document.getElementById('searchSub').textContent = `${found.length}개`;
    document.getElementById('searchList').innerHTML = found.map(({ r, n }) => {
      const label = n < 0 ? '종료' : n === 0 ? 'D-day' : 'D-' + n;
      const cls = n < 0 ? 'past' : n === 0 ? 'today' : n <= 3 ? 'soon' : '';
      const extra = n < 0 ? '' : `<div class="meta">${REG_LABEL[regStatus(r)]}</div>`;
      return item(r, `<div class="home-dday ${cls}">${label}</div>`, extra);
    }).join('') || '<div class="empty">검색 결과가 없어요. 다른 대회명이나 지역으로 찾아보세요.</div>';
  }

  async function loadHome() {
    try {
      const races = await loadRaces();
      render(races);
      const input = document.getElementById('homeSearch');
      input.addEventListener('input', () => renderSearch(races));
      input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });  // 모바일 키보드 닫기
      renderSearch(races);  // 뒤로 가기로 입력값이 복원된 경우
    } catch (e) {
      for (const id of ['upcomingList', 'openList'])
        document.getElementById(id).innerHTML = '<div class="empty">대회 정보를 불러오지 못했습니다.</div>';
    }
  }

  loadHome();
})();
