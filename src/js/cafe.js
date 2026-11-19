// 러닝 기록 인증 할인 카페 탭 (#view-cafe): data/cafes.json 을 불러와 지역·코스·혜택 필터 및 키워드 검색을 제공한다.
(() => {
  const root = document.getElementById('view-cafe');
  if (!root) return;

  const searchInput = document.getElementById('cafeSearch');
  const regionWrap = document.getElementById('cafeRegionChips');
  const spotWrap = document.getElementById('cafeSpotChips');
  const perkWrap = document.getElementById('cafePerkChips');
  const countEl = document.getElementById('cafeCount');
  const resetBtn = document.getElementById('cafeResetBtn');
  const gridEl = document.getElementById('cafeList');

  const state = {
    region: 'all',
    spot: 'all',
    perk: 'all',
    query: '',
  };

  let allCafes = [];

  const compact = s => String(s || '').toLowerCase().replace(/\s+/g, '');

  function matchPerk(c, perk) {
    if (perk === 'all') return true;
    if (perk === 'distance') return c.discountType === 'distance';
    if (perk === 'storage') return (c.perks || []).some(p => p.includes('보관') || p.includes('샤워') || p.includes('탈의'));
    if (perk === 'fullfree') return /100%|무료/.test(c.discountDetail || '') || /100%|무료/.test(c.discountBadge || '');
    return true;
  }

  function matchWords(c, words) {
    if (!words.length) return true;
    const text = [
      c.name, c.region, c.district, c.spot, c.address,
      c.course, c.discountBadge, c.discountDetail, c.condition,
      ...(c.perks || []),
    ].map(compact).join('|');
    return words.every(w => text.includes(w));
  }

  function renderRegionChips() {
    const counts = new Map();
    for (const c of allCafes) counts.set(c.region, (counts.get(c.region) || 0) + 1);
    const regions = ['all', ...counts.keys()];
    regionWrap.innerHTML = regions.map(r => {
      const label = r === 'all' ? '전체' : r;
      const cnt = r === 'all' ? allCafes.length : counts.get(r);
      const active = state.region === r ? 'active' : '';
      return `<button type="button" class="cafe-chip ${active}" data-region="${esc(r)}">${esc(label)}<span class="cnt">${cnt}</span></button>`;
    }).join('');
  }

  function renderSpotChips() {
    const pool = state.region === 'all' ? allCafes : allCafes.filter(c => c.region === state.region);
    const spots = [...new Set(pool.map(c => c.spot).filter(Boolean))];
    if (state.spot !== 'all' && !spots.includes(state.spot)) {
      state.spot = 'all';
    }
    spotWrap.innerHTML = ['all', ...spots].map(s => {
      const label = s === 'all' ? '전체 동네·코스' : s;
      const active = state.spot === s ? 'active' : '';
      return `<button type="button" class="cafe-chip ${active}" data-spot="${esc(s)}">${esc(label)}</button>`;
    }).join('');
  }

  function renderPerkChips() {
    perkWrap.querySelectorAll('.cafe-chip').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.perk === state.perk);
    });
  }

  function thumbHtml(c) {
    const fallback = `<div class="cafe-thumb-fallback"><span class="ico">☕🏃</span><span>${esc(c.spot)}</span></div>`;
    if (!c.image) return `<div class="cafe-thumb-wrap">${fallback}</div>`;
    return `<div class="cafe-thumb-wrap"><img class="cafe-thumb" src="${esc(c.image)}" alt="${esc(c.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;cafe-thumb-fallback&quot;><span class=&quot;ico&quot;>☕🏃</span><span>${esc(c.spot)}</span></div>'"></div>`;
  }

  function cardHtml(c) {
    const q = encodeURIComponent(c.mapQuery || `${c.address} ${c.name}`);
    const naverUrl = `https://map.naver.com/p/search/${q}`;
    const kakaoUrl = `https://map.kakao.com/?q=${q}`;
    const perks = (c.perks || []).map(p => `<span class="cafe-perk">#${esc(p)}</span>`).join('');
    const badgeCls = c.discountType === 'distance' ? 'distance' : '';

    return `<article class="cafe-card">
      ${thumbHtml(c)}
      <div class="cafe-card-body">
        <div class="cafe-card-top">
          <span class="cafe-region-tag">📍 ${esc(c.region)} ${esc(c.district)} · ${esc(c.spot)}</span>
          <span class="cafe-discount-badge ${badgeCls}">${esc(c.discountBadge)}</span>
        </div>
        <div class="cafe-title-box">
          <h3>${esc(c.name)}</h3>
          <div class="cafe-course">🏃 연계 코스: ${esc(c.course)}</div>
        </div>
        <div class="cafe-benefit-box">
          <div class="cafe-benefit-row">
            <span class="k">할인 혜택</span>
            <span class="v">${esc(c.discountDetail)}</span>
          </div>
          <div class="cafe-benefit-row cond">
            <span class="k">인증 방법</span>
            <span class="v">${esc(c.condition)}</span>
          </div>
        </div>
        ${perks ? `<div class="cafe-perks">${perks}</div>` : ''}
        <div class="cafe-address">🗺️ ${esc(c.address)}</div>
        <div class="cafe-actions">
          <a class="cafe-btn naver" href="${naverUrl}" target="_blank" rel="noopener noreferrer">네이버 지도 ➔</a>
          <a class="cafe-btn kakao" href="${kakaoUrl}" target="_blank" rel="noopener noreferrer">카카오맵 ➔</a>
          ${c.instagram ? `<a class="cafe-btn insta" href="${esc(c.instagram)}" target="_blank" rel="noopener noreferrer" title="${esc(c.instagramHandle || '공식 인스타그램')}">인스타그램 ➔</a>` : ''}
        </div>
      </div>
    </article>`;
  }

  function render() {
    renderRegionChips();
    renderSpotChips();
    renderPerkChips();

    const words = state.query.trim().split(/\s+/).filter(Boolean).map(compact);
    const filtered = allCafes.filter(c =>
      (state.region === 'all' || c.region === state.region) &&
      (state.spot === 'all' || c.spot === state.spot) &&
      matchPerk(c, state.perk) &&
      matchWords(c, words)
    );

    const hasFilter = state.region !== 'all' || state.spot !== 'all' || state.perk !== 'all' || words.length > 0;
    resetBtn.hidden = !hasFilter;
    countEl.innerHTML = `검색 결과 <strong>${filtered.length}</strong>곳` + (hasFilter ? ` (전체 ${allCafes.length}곳 중)` : '');

    if (!filtered.length) {
      gridEl.innerHTML = '<div class="cafe-empty">조건에 맞는 러닝 할인 카페가 없어요. 다른 지역명이나 코스로 검색해 보세요.</div>';
      return;
    }
    gridEl.innerHTML = filtered.map(cardHtml).join('');
  }

  regionWrap.addEventListener('click', e => {
    const btn = e.target.closest('button[data-region]');
    if (!btn) return;
    state.region = btn.dataset.region;
    state.spot = 'all';
    render();
  });

  spotWrap.addEventListener('click', e => {
    const btn = e.target.closest('button[data-spot]');
    if (!btn) return;
    state.spot = btn.dataset.spot;
    render();
  });

  perkWrap.addEventListener('click', e => {
    const btn = e.target.closest('button[data-perk]');
    if (!btn) return;
    state.perk = btn.dataset.perk;
    render();
  });

  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    render();
  });
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') searchInput.blur();
  });

  resetBtn.addEventListener('click', () => {
    state.region = 'all';
    state.spot = 'all';
    state.perk = 'all';
    state.query = '';
    searchInput.value = '';
    render();
  });

  async function init() {
    try {
      const res = await fetch(Platform.dataUrl('cafes.json'), { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      allCafes = data.cafes || [];
      render();
    } catch (e) {
      gridEl.innerHTML = '<div class="cafe-empty">카페 정보를 불러오지 못했습니다.</div>';
    }
  }

  init();
})();
