// 러닝 기록 인증 할인 카페 탭 (#view-cafe):
// 서버리스 API(/api/cafes)를 통해 지역·코스·혜택 필터링과 페이지네이션된 카페 목록을 불러온다.
(() => {
  const root = document.getElementById('view-cafe');
  if (!root) return;

  const PAGE_SIZE = 8;

  const searchInput = document.getElementById('cafeSearch');
  const regionWrap = document.getElementById('cafeRegionChips');
  const spotWrap = document.getElementById('cafeSpotChips');
  const perkWrap = document.getElementById('cafePerkChips');
  const countEl = document.getElementById('cafeCount');
  const resetBtn = document.getElementById('cafeResetBtn');
  const gridEl = document.getElementById('cafeList');
  const moreWrap = document.getElementById('cafeMoreWrap');
  const moreBtn = document.getElementById('cafeMoreBtn');

  const state = {
    region: 'all',
    spot: 'all',
    perk: 'all',
    query: '',
    page: 1,
  };

  let loadedCafes = [];
  let metaRegions = [];
  let metaSpots = [];
  let totalMatched = 0;
  let totalAll = 0;
  let hasMore = false;
  let activeController = null;
  let debounceTimer = null;

  function renderRegionChips() {
    const chips = [{ name: 'all', count: totalAll }, ...metaRegions];
    regionWrap.innerHTML = chips.map(r => {
      const label = r.name === 'all' ? '전체' : r.name;
      const active = state.region === r.name ? 'active' : '';
      return `<button type="button" class="cafe-chip ${active}" data-region="${esc(r.name)}">${esc(label)}<span class="cnt">${r.count}</span></button>`;
    }).join('');
  }

  function renderSpotChips() {
    if (state.spot !== 'all' && !metaSpots.includes(state.spot)) {
      state.spot = 'all';
    }
    spotWrap.innerHTML = ['all', ...metaSpots].map(s => {
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

    const hasFilter = state.region !== 'all' || state.spot !== 'all' || state.perk !== 'all' || state.query.trim().length > 0;
    resetBtn.hidden = !hasFilter;
    countEl.innerHTML = `검색 결과 <strong>${totalMatched}</strong>곳` + (hasFilter ? ` (전체 ${totalAll}곳 중)` : '');

    if (!loadedCafes.length) {
      gridEl.innerHTML = '<div class="cafe-empty">조건에 맞는 러닝 할인 카페가 없어요. 다른 지역명이나 코스로 검색해 보세요.</div>';
      moreWrap.hidden = true;
      return;
    }

    gridEl.innerHTML = loadedCafes.map(cardHtml).join('');
    moreWrap.hidden = !hasMore;
    if (hasMore) {
      const remain = Math.max(0, totalMatched - loadedCafes.length);
      moreBtn.textContent = `카페 더 보기 (${remain}곳 남음) ▾`;
      moreBtn.disabled = false;
    }
  }

  async function fetchCafes(append = false) {
    if (activeController) activeController.abort();
    activeController = new AbortController();

    if (append) {
      moreBtn.disabled = true;
      moreBtn.textContent = '불러오는 중...';
    }

    const params = new URLSearchParams({
      region: state.region,
      spot: state.spot,
      perk: state.perk,
      q: state.query.trim(),
      page: String(state.page),
      limit: String(PAGE_SIZE),
    });

    try {
      const res = await fetch(Platform.apiUrl('/api/cafes?' + params.toString()), {
        headers: { 'X-Requested-With': 'MarathonNote' },
        cache: 'no-store',
        signal: activeController.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      metaRegions = data.regions || [];
      metaSpots = data.spots || [];
      totalMatched = data.total ?? 0;
      totalAll = data.totalAll ?? 0;
      hasMore = Boolean(data.hasMore);
      loadedCafes = append ? loadedCafes.concat(data.cafes || []) : (data.cafes || []);
      render();
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (!append) {
        gridEl.innerHTML = `<div class="cafe-empty">${esc(e.message || '카페 정보를 불러오지 못했습니다.')}</div>`;
        moreWrap.hidden = true;
      } else {
        moreBtn.disabled = false;
        moreBtn.textContent = '다시 시도 ▾';
      }
    }
  }

  function resetAndFetch() {
    state.page = 1;
    fetchCafes(false);
  }

  regionWrap.addEventListener('click', e => {
    const btn = e.target.closest('button[data-region]');
    if (!btn) return;
    state.region = btn.dataset.region;
    state.spot = 'all';
    resetAndFetch();
  });

  spotWrap.addEventListener('click', e => {
    const btn = e.target.closest('button[data-spot]');
    if (!btn) return;
    state.spot = btn.dataset.spot;
    resetAndFetch();
  });

  perkWrap.addEventListener('click', e => {
    const btn = e.target.closest('button[data-perk]');
    if (!btn) return;
    state.perk = btn.dataset.perk;
    resetAndFetch();
  });

  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(resetAndFetch, 200);
  });
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      clearTimeout(debounceTimer);
      resetAndFetch();
      searchInput.blur();
    }
  });

  resetBtn.addEventListener('click', () => {
    state.region = 'all';
    state.spot = 'all';
    state.perk = 'all';
    state.query = '';
    searchInput.value = '';
    resetAndFetch();
  });

  moreBtn.addEventListener('click', () => {
    if (!hasMore) return;
    state.page += 1;
    fetchCafes(true);
  });

  fetchCafes(false);
})();
