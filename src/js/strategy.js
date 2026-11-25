// 레이스 전략 카드 (날씨 + 목표 기록 + 복장 + 에너지젤 보급 + 준비물 체크리스트 + PNG 저장)
// 대회 상세(race.html)와 페이스 계산기(#view-pace) 양쪽에서 공용으로 사용한다.
(() => {
  const FULL = 42.195;
  const HALF = 21.0975;

  const DIST_LIST = [
    { key: 'full', name: '풀코스', short: '풀', km: FULL },
    { key: 'half', name: '하프', short: '하프', km: HALF },
    { key: '10', name: '10km', short: '10km', km: 10 },
    { key: '5', name: '5km', short: '5km', km: 5 },
  ];

  const PRESETS = {
    5: [['20분', 1200], ['25분', 1500], ['30분', 1800], ['35분', 2100]],
    10: [['40분', 2400], ['50분', 3000], ['55분', 3300], ['1시간', 3600]],
    [HALF]: [['1:30', 5400], ['1:45', 6300], ['서브2', 7200], ['2:15', 8100]],
    [FULL]: [['서브3', 10800], ['3:30', 12600], ['서브4', 14400], ['4:30', 16200], ['서브5', 18000]],
  };

  const DEFAULT_GOAL = { 5: 1800, 10: 3300, [HALF]: 7200, [FULL]: 14400 };

  // 기온 구간 프리셋
  const TEMP_PRESETS = [
    { id: 'cold', label: '~2°C 한겨울', temp: 1 },
    { id: 'chilly', label: '3~7°C 쌀쌀', temp: 6 },
    { id: 'ideal', label: '8~13°C 최적', temp: 11 },
    { id: 'warm', label: '14~19°C 따뜻', temp: 17 },
    { id: 'hot', label: '20°C+ 더움', temp: 23 },
  ];

  const p2 = n => String(n).padStart(2, '0');
  const fmtDur = sec => {
    const t = Math.max(0, Math.round(sec));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    return h ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
  };
  const fmtHm = sec => {
    const t = Math.max(0, Math.round(sec));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    return h ? `${h}시간 ${m ? m + '분' : ''}`.trim() : `${m}분`;
  };
  const fmtPace = secPerKm => `${Math.floor(secPerKm / 60)}'${p2(Math.floor(secPerKm % 60))}"`;
  const distName = km => (DIST_LIST.find(d => Math.abs(d.km - km) < 0.2) || {}).name || `${+km.toFixed(1)}km`;

  function tempBucket(temp) {
    if (temp < 3) return 'cold';
    if (temp < 8) return 'chilly';
    if (temp < 14) return 'ideal';
    if (temp < 20) return 'warm';
    return 'hot';
  }

  // 기온 + 우천 여부에 따른 복장 가이드
  function buildOutfit(temp, rain, wind) {
    const b = tempBucket(temp);
    let top, bottom, acc, wait, note;
    if (b === 'cold') {
      top = '기능성 긴팔 + 방풍 베스트/자켓';
      bottom = '기모/긴 타이츠';
      acc = '러닝 장갑 · 귀마개/비니 · 넥워머';
      wait = '버릴 겉옷 또는 비닐우의 + 핫팩 필수';
      note = '초반 체온이 오르기 전까지 근육이 굳기 쉬워요. 출발 전 충분한 워밍업을 챙기세요.';
    } else if (b === 'chilly') {
      top = '얇은 긴팔 또는 반팔 + 팔토시';
      bottom = '하프 타이츠 또는 반바지';
      acc = '얇은 러닝 장갑 (달리다 벗어 보관)';
      wait = '일회용 비닐우의 또는 버릴 맨투맨';
      note = '출발 대기 중엔 춥지만 3km만 달려도 체감 온도가 8~10°C 올라가요. 두껍게 입지 않는 게 핵심입니다.';
    } else if (b === 'ideal') {
      top = '가벼운 반팔 또는 싱글렛';
      bottom = '러닝 쇼츠 · 하프 타이츠';
      acc = '얇은 팔토시(선택) · 선글라스';
      wait = '바람막이(짐 보관) 또는 얇은 비닐우의';
      note = '기록 내기 가장 좋은 마라톤 최적 기온이에요. 출발 직전 살짝 서늘한 정도가 딱 맞습니다.';
    } else if (b === 'warm') {
      top = '통풍 좋은 싱글렛 · 메쉬 반팔';
      bottom = '가벼운 러닝 쇼츠';
      acc = '러닝 캡 · 선글라스 · 선크림';
      wait = '별도 보온 의류 불필요 (그늘 대기)';
      note = '후반으로 갈수록 기온이 더 올라가요. 급수대마다 물로 목·팔을 식혀주면 체온 조절에 도움이 됩니다.';
    } else {
      top = '초경량 싱글렛 (밝은 색상 추천)';
      bottom = '스플릿 쇼츠 · 통풍 양말';
      acc = '통풍 모자 · 선크림 · 쿨링 타월';
      wait = '출발 전 그늘에서 충분한 수분 섭취';
      note = '20°C 이상에서는 평소보다 페이스를 10~20초/km 여유 있게 잡고, 열사병 예방을 최우선으로 두세요.';
    }

    const extras = [];
    if (rain) {
      acc += ' · 챙 있는 방수 모자';
      extras.push('🌧️ 우천 대비: 젖은 옷 쓸림 방지를 위해 겨드랑이·발가락·허벅지에 바셀린을 넉넉히 바르세요.');
    }
    if (wind != null && wind >= 4) {
      extras.push(`💨 바람(${wind}m/s)이 다소 강해요. 맞바람 구간에서는 앞 주자 뒤에서 페이스를 유지하세요.`);
    }
    return {
      bucket: b,
      items: [
        { part: '상의', rec: top },
        { part: '하의', rec: bottom },
        { part: '소품', rec: acc },
        { part: '출발 대기', rec: wait },
      ],
      note: [note, ...extras].join(' '),
    };
  }

  // 거리 · 목표 시간 · 기온 기반 에너지젤 & 수분 보급 타임라인
  function buildNutrition(km, totalSec, temp) {
    const pace = totalSec / km;
    const steps = [];
    let gelCount = 0;

    if (km <= 10.5) {
      if (totalSec >= 3600) {
        gelCount = 1;
        steps.push({ km: '출발 15분 전', at: '-15분', desc: '에너지젤 1개 + 물 한 모금 (선택)', caffeine: false });
      }
      steps.push({ km: '5km 급수대', at: fmtDur(pace * Math.min(5, km * 0.5)), desc: '입만 적시거나 물 1~2모금으로 가볍게 수분 보충', caffeine: false });
    } else if (km <= 25) {
      // 하프코스
      steps.push({ km: '출발 15분 전', at: '-15분', desc: '에너지젤 1개 + 물 150ml로 초반 혈당 확보', caffeine: false });
      if (totalSec <= 6300) {
        // 1:45 이내 → 총 2개
        gelCount = 2;
        steps.push({ km: '11km', at: fmtDur(pace * 11), desc: '에너지젤 1개 (급수대 직전 섭취 후 물과 함께)', caffeine: true });
      } else {
        // 1:45 초과 → 총 3개
        gelCount = 3;
        steps.push({ km: '8km', at: fmtDur(pace * 8), desc: '에너지젤 1개 (배고프기 전에 미리 보급)', caffeine: false });
        steps.push({ km: '15km', at: fmtDur(pace * 15), desc: '에너지젤 1개 · 후반 스퍼트용', caffeine: true });
      }
    } else {
      // 풀코스 (42.195km)
      steps.push({ km: '출발 15분 전', at: '-15분', desc: '에너지젤 1개 + 물 150ml', caffeine: false });
      let marks;
      if (totalSec <= 12600) {
        // ~3:30: 4회 (+ 출발전 = 총 5개)
        marks = [10, 20, 30, 35];
      } else if (totalSec <= 16200) {
        // 3:30~4:30: 5회 (+ 출발전 = 총 6개)
        marks = [8, 16, 24, 31, 36];
      } else {
        // 4:30+: 6회 (+ 출발전 = 총 7개)
        marks = [7, 14, 21, 28, 34, 38];
      }
      gelCount = marks.length + 1;
      marks.forEach((m, i) => {
        const isLast = i === marks.length - 1;
        const isSecondLast = i === marks.length - 2;
        const caff = isLast || (marks.length >= 5 && isSecondLast);
        const desc = isLast
          ? '마지막 젤! 급수대 직전 섭취 후 결승까지 집중'
          : m >= 28
            ? '30km 벽 대비 보급 · 급수대 물과 함께 천천히 섭취'
            : '급수대 200m 전 섭취 → 물 1~2모금으로 넘기기';
        steps.push({ km: `${m}km`, at: fmtDur(pace * m), desc, caffeine: caff });
      });
    }

    const hydration = temp >= 18
      ? '💧 기온이 높아 땀 손실이 큽니다. 2.5~5km 매 급수대마다 물·이온음료를 번갈아 마시고, 20km 이후 식염포도당(전해질) 1~2정을 챙기세요.'
      : temp >= 12
        ? '💧 5km 급수대마다 물 2~3모금씩 규칙적으로 마시세요. 목마름을 느끼기 전에 조금씩 마시는 게 좋습니다.'
        : '💧 쌀쌀해도 땀으로 수분이 빠집니다. 5km마다 한두 모금씩 보충하고, 하프 이후에는 이온음료를 섞어 드세요.';

    return { gelCount, steps, hydration };
  }

  // 대회 전날 · 당일 준비물 체크리스트
  function buildChecklist(km, gelCount, temp, rain) {
    const nightBefore = [
      { id: 'bib', text: '배번호 · 기록칩 부착 (옷핀 4개 또는 레이스 벨트)' },
      { id: 'watch', text: 'GPS 워치 · 이어폰 100% 충전 확인' },
      { id: 'shoes', text: '길들인 러닝화 · 기능성 러닝 양말 (새 신발 금지)' },
      { id: 'idcard', text: '신분증 · 교통카드 · 비상용 소액 현금' },
      { id: 'bag', text: '물품보관용 가방 · 완주 후 갈아입을 마른 옷/슬리퍼' },
    ];

    const raceDay = [];
    if (gelCount > 0) {
      raceDay.push({ id: 'gels', text: `에너지젤 ${gelCount}개 (테스트해 본 제품으로, 러닝벨트/포켓 수납)` });
    }
    if (km >= 20) {
      raceDay.push({ id: 'vaseline', text: '바셀린 · 니플밴드 (겨드랑이·발가락·허벅지 쓸림 방지)' });
      raceDay.push({ id: 'salt', text: '식염포도당 / 전해질 스틱 (하프·풀 쥐 예방)' });
    } else {
      raceDay.push({ id: 'water', text: '출발 전 마실 소형 생수 (출발 30분 전까지 섭취)' });
    }

    const b = tempBucket(temp);
    if (b === 'cold' || b === 'chilly') {
      raceDay.push({ id: 'gloves', text: '러닝 장갑 · 팔토시 (체온 오르면 주머니 보관)' });
      raceDay.push({ id: 'throwaway', text: '출발 대기용 비닐우의 또는 버릴 겉옷 · 핫팩' });
    } else if (b === 'warm' || b === 'hot') {
      raceDay.push({ id: 'sun', text: '선크림 · 러닝 모자 · 선글라스' });
    }
    if (rain) {
      raceDay.push({ id: 'raincap', text: '챙 있는 모자 · 출발 대기용 투명 우비' });
      raceDay.push({ id: 'ziplock', text: '휴대폰 방수 지퍼백 · 완주 후 여벌 양말/수건' });
    }

    return [
      { title: '🌙 대회 전날 챙기기', items: nightBefore },
      { title: '🏁 대회 당일 · 날씨/코스 맞춤', items: raceDay },
    ];
  }

  // localStorage 체크 상태 관리
  function loadChecks(storageKey) {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || '{}') || {};
    } catch {
      return {};
    }
  }
  function saveChecks(storageKey, map) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(map));
    } catch { /* 사파리 시크릿 등 무시 */ }
  }

  // Canvas로 다크 테마 레이스 전략 카드 PNG 생성 및 다운로드
  function downloadStrategyPng(state, data) {
    const W = 900;
    const pad = 44;
    const gelRows = data.nutrition.steps.length;
    const H = 640 + gelRows * 46 + (state.rain ? 28 : 0);

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // 배경
    ctx.fillStyle = '#0a0e17';
    ctx.fillRect(0, 0, W, H);

    // 상단 강조 바
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#10b981');
    grad.addColorStop(1, '#06b6d4');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, 8);

    const font = (size, weight = 600) => `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
    const roundRect = (x, y, w, h, r, fill, stroke) => {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
    };

    let y = 52;
    ctx.fillStyle = '#10b981';
    ctx.font = font(18, 700);
    ctx.fillText('MARATHONNOTE · RACE STRATEGY', pad, y);

    y += 38;
    ctx.fillStyle = '#f1f5f9';
    ctx.font = font(30, 800);
    const title = state.title || `${distName(state.km)} 레이스 전략`;
    ctx.fillText(title.length > 26 ? title.slice(0, 26) + '…' : title, pad, y);

    if (state.subtitle) {
      y += 28;
      ctx.fillStyle = '#94a3b8';
      ctx.font = font(17, 500);
      ctx.fillText(state.subtitle, pad, y);
    }

    // 요약 4칸
    y += 26;
    const pace = state.totalSec / state.km;
    const stats = [
      ['종목 · 목표', `${distName(state.km)} · ${fmtDur(state.totalSec)}`, '#10b981'],
      ['목표 페이스', `${fmtPace(pace)} /km`, '#34d399'],
      ['예상 날씨', `${state.temp}°C${state.rain ? ' · 비' : ''}`, '#06b6d4'],
      ['에너지젤', data.nutrition.gelCount ? `${data.nutrition.gelCount}개 추천` : '수분 위주', '#facc15'],
    ];
    const boxW = (W - pad * 2 - 30) / 4;
    stats.forEach(([k, v, color], idx) => {
      const bx = pad + idx * (boxW + 10);
      roundRect(bx, y, boxW, 78, 12, '#131b2e', '#1e293b');
      ctx.fillStyle = '#94a3b8';
      ctx.font = font(14, 600);
      ctx.fillText(k, bx + 14, y + 26);
      ctx.fillStyle = color;
      ctx.font = font(21, 800);
      ctx.fillText(v, bx + 14, y + 56);
    });

    // 복장 섹션
    y += 104;
    roundRect(pad, y, W - pad * 2, 168, 14, '#131b2e', '#1e293b');
    ctx.fillStyle = '#f1f5f9';
    ctx.font = font(20, 700);
    ctx.fillText('👕 추천 복장', pad + 20, y + 34);
    data.outfit.items.forEach((it, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const ix = pad + 20 + col * ((W - pad * 2 - 40) / 2);
      const iy = y + 66 + row * 48;
      ctx.fillStyle = '#94a3b8';
      ctx.font = font(14, 600);
      ctx.fillText(it.part, ix, iy);
      ctx.fillStyle = '#f1f5f9';
      ctx.font = font(17, 600);
      ctx.fillText(it.rec, ix, iy + 22);
    });

    // 에너지젤 타임라인
    y += 190;
    const gelBoxH = 66 + gelRows * 42;
    roundRect(pad, y, W - pad * 2, gelBoxH, 14, '#131b2e', '#1e293b');
    ctx.fillStyle = '#f1f5f9';
    ctx.font = font(20, 700);
    ctx.fillText('🍯 에너지젤 · 보급 타임라인', pad + 20, y + 34);
    data.nutrition.steps.forEach((s, i) => {
      const sy = y + 68 + i * 42;
      roundRect(pad + 18, sy - 22, W - pad * 2 - 36, 34, 8, '#0a0e17', '#1e293b');
      ctx.fillStyle = '#facc15';
      ctx.font = font(16, 800);
      ctx.fillText(s.km, pad + 30, sy);
      ctx.fillStyle = '#06b6d4';
      ctx.font = font(15, 700);
      ctx.fillText(s.at, pad + 150, sy);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = font(15, 500);
      const label = s.desc + (s.caffeine ? ' [카페인]' : '');
      ctx.fillText(label.length > 36 ? label.slice(0, 36) + '…' : label, pad + 245, sy);
    });

    // 푸터
    ctx.fillStyle = '#64748b';
    ctx.font = font(15, 500);
    ctx.fillText('marathonnote.co.kr · 마라톤노트 레이스 전략 카드', pad, H - 24);

    const a = document.createElement('a');
    a.download = `marathonnote-strategy-${distName(state.km)}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  }

  function buildCopyText(state, data) {
    const pace = state.totalSec / state.km;
    const lines = [
      `🏃 ${state.title || `${distName(state.km)} 레이스 전략`} (MarathonNote)`,
      state.subtitle ? `📅 ${state.subtitle}` : '',
      `🎯 목표: ${distName(state.km)} ${fmtDur(state.totalSec)} (평균 ${fmtPace(pace)}/km)`,
      `🌤️ 예상 날씨: ${state.temp}°C${state.rain ? ' (비 예보)' : ''}`,
      '',
      '👕 추천 복장',
      ...data.outfit.items.map(i => `- ${i.part}: ${i.rec}`),
      '',
      `🍯 에너지젤 · 보급 (${data.nutrition.gelCount ? `총 ${data.nutrition.gelCount}개` : '수분 위주'})`,
      ...data.nutrition.steps.map(s => `- ${s.km} (${s.at}): ${s.desc}${s.caffeine ? ' [카페인]' : ''}`),
      '',
      '🔗 https://www.marathonnote.co.kr',
    ].filter(v => v !== '');
    return lines.join('\n');
  }

  /**
   * 레이스 전략 카드를 지정한 컨테이너에 마운트한다.
   * @param {HTMLElement} container
   * @param {object} opts
   *   - id: localStorage 키 구분자 (예: race.id 또는 'pace')
   *   - title: 카드/PNG 제목
   *   - subtitle: 날짜·장소 부제
   *   - distances: 선택 가능한 km 배열 (생략 시 [42.195, 21.0975, 10, 5])
   *   - defaultKm: 초기 종목 km
   *   - defaultGoalSec: 초기 목표 시간(초)
   *   - defaultTemp: 초기 기온(°C)
   *   - defaultRain: 초기 비 예보 여부
   *   - wind: 참고 풍속(m/s)
   *   - tempSourceText: 기온 출처 안내 문구 (예: '최근 10년 대회일 오전 평균 7.7°C 자동 반영')
   *   - hideGoalControls: true면 종목·목표 입력을 숨기고 외부(페이스 계산기)에서 update()로 주입
   */
  function mount(container, opts = {}) {
    if (!container) return null;

    const availDists = (opts.distances && opts.distances.length)
      ? opts.distances
      : [FULL, HALF, 10, 5];
    const initKm = opts.defaultKm && availDists.includes(opts.defaultKm) ? opts.defaultKm : availDists[0];
    const state = {
      id: opts.id || 'default',
      title: opts.title || '',
      subtitle: opts.subtitle || '',
      km: initKm,
      totalSec: opts.defaultGoalSec || DEFAULT_GOAL[initKm] || 14400,
      temp: opts.defaultTemp != null ? Number(Number(opts.defaultTemp).toFixed(1)) : 11,
      rain: !!opts.defaultRain,
      wind: opts.wind ?? null,
      hideGoalControls: !!opts.hideGoalControls,
      collapsible: !!opts.collapsible,
      collapsed: !!opts.collapsible,
    };

    const storageKey = `mn_strategy_checks_${state.id}`;
    let checks = loadChecks(storageKey);

    function render() {
      const pace = state.totalSec > 0 ? state.totalSec / state.km : 0;
      const outfit = buildOutfit(state.temp, state.rain, state.wind);
      const nutrition = buildNutrition(state.km, state.totalSec, state.temp);
      const groups = buildChecklist(state.km, nutrition.gelCount, state.temp, state.rain);
      const allItems = groups.flatMap(g => g.items);
      const doneCount = allItems.filter(it => checks[it.id]).length;
      const curBucket = tempBucket(state.temp);

      if (state.collapsible && state.collapsed) {
        container.innerHTML = `
          <div class="strategy-card">
            <div class="strategy-collapsed">
              <div class="strategy-collapsed-info">
                <h2>🎒 레이스 전략 카드 ${doneCount > 0 ? `<span class="strategy-badge" style="margin-left:6px;vertical-align:middle">${doneCount}/${allItems.length} 체크</span>` : ''}</h2>
                <p>${distName(state.km)} · 예상 ${state.temp}°C${state.rain ? ' (우천)' : ''} 기준 맞춤 복장 · 에너지젤 보급 · 준비물 체크리스트</p>
              </div>
              <button type="button" class="strategy-toggle-btn" data-role="toggleOpen">레이스 전략 보기 ▾</button>
            </div>
          </div>
        `;
        container.querySelector('[data-role="toggleOpen"]').addEventListener('click', () => {
          state.collapsed = false;
          render();
        });
        return;
      }

      const h = Math.floor(state.totalSec / 3600);
      const m = Math.floor((state.totalSec % 3600) / 60);
      const presets = PRESETS[state.km] || [];

      const distChipsHtml = availDists.map(km => {
        const active = Math.abs(km - state.km) < 0.2 ? 'active' : '';
        return `<button type="button" class="strategy-chip ${active}" data-km="${km}">${distName(km)}</button>`;
      }).join('');

      const presetChipsHtml = presets.map(([lbl, sec]) => {
        const active = Math.round(state.totalSec) === sec ? 'active' : '';
        return `<button type="button" class="strategy-chip ${active}" data-sec="${sec}">${lbl}</button>`;
      }).join('');

      const tempChipsHtml = TEMP_PRESETS.map(t => {
        const active = curBucket === t.id ? 'active' : '';
        return `<button type="button" class="strategy-chip ${active}" data-temp="${t.temp}">${t.label}</button>`;
      }).join('');

      container.innerHTML = `
        <div class="strategy-card">
          <div class="strategy-head">
            <h2>🎒 레이스 전략 카드</h2>
            <div class="strategy-head-right">
              <span class="strategy-badge">${distName(state.km)} · ${state.temp}°C${state.rain ? ' · 우천' : ''}</span>
              ${state.collapsible ? '<button type="button" class="strategy-toggle-btn ghost" data-role="toggleOpen">접기 ▴</button>' : ''}
            </div>
          </div>
          <p class="strategy-sub">${opts.tempSourceText || '목표 기록과 예상 기온에 맞춰 복장·에너지젤 보급 타이밍·준비물 체크리스트를 한눈에 정리해 드려요.'}</p>

          <div class="strategy-controls">
            ${state.hideGoalControls ? '' : `
              <div class="strategy-row">
                <span class="lbl">종목</span>
                <div class="strategy-chips" data-role="dist">${distChipsHtml}</div>
              </div>
              <div class="strategy-row">
                <span class="lbl">목표 기록</span>
                <div class="strategy-chips" data-role="preset">
                  ${presetChipsHtml}
                  <span class="strategy-time-inputs">
                    <input type="number" inputmode="numeric" min="0" max="12" data-role="goalH" value="${h}" aria-label="목표 시간"><span>시간</span>
                    <input type="number" inputmode="numeric" min="0" max="59" data-role="goalM" value="${m}" aria-label="목표 분"><span>분</span>
                  </span>
                </div>
              </div>
            `}
            <div class="strategy-row">
              <span class="lbl">예상 기온</span>
              <div class="strategy-chips" data-role="temp">
                ${tempChipsHtml}
                <button type="button" class="strategy-chip rain ${state.rain ? 'active' : ''}" data-role="rain">🌧️ 비 예보</button>
              </div>
            </div>
          </div>

          <div class="strategy-summary">
            <div class="strategy-stat"><div class="k">목표 기록</div><div class="v">${fmtDur(state.totalSec)}</div></div>
            <div class="strategy-stat"><div class="k">평균 페이스</div><div class="v">${pace ? fmtPace(pace) : '-'}<small style="font-size:0.72rem;font-weight:600;color:var(--text-muted)">/km</small></div></div>
            <div class="strategy-stat"><div class="k">예상 날씨</div><div class="v cyan">${state.temp}°C${state.rain ? ' 🌧️' : ''}</div></div>
            <div class="strategy-stat"><div class="k">추천 에너지젤</div><div class="v gold">${nutrition.gelCount ? nutrition.gelCount + '개' : '불필요'}</div></div>
          </div>

          <div class="strategy-section">
            <div class="strategy-section-head">
              <h4>👕 기온 맞춤 복장 가이드</h4>
              <span class="strategy-badge info">${TEMP_PRESETS.find(t => t.id === outfit.bucket)?.label || ''}</span>
            </div>
            <div class="outfit-grid">
              ${outfit.items.map(it => `<div class="outfit-item"><div class="part">${esc(it.part)}</div><div class="rec">${esc(it.rec)}</div></div>`).join('')}
            </div>
            <p class="strategy-note">${esc(outfit.note)}</p>
          </div>

          <div class="strategy-section">
            <div class="strategy-section-head">
              <h4>🍯 에너지젤 · 수분 보급 타임라인</h4>
              <span class="strategy-badge ${nutrition.gelCount >= 5 ? 'warn' : ''}">${nutrition.gelCount ? `총 ${nutrition.gelCount}개 · ${fmtHm(state.totalSec)} 기준` : '수분 보충 중심'}</span>
            </div>
            <div class="gel-timeline">
              ${nutrition.steps.map(s => `
                <div class="gel-step">
                  <span class="km">${esc(s.km)}</span>
                  <span class="at">${esc(s.at)}</span>
                  <span class="desc">${esc(s.desc)}${s.caffeine ? '<span class="caff">카페인 추천</span>' : ''}</span>
                </div>
              `).join('')}
            </div>
            <p class="strategy-note">${esc(nutrition.hydration)}</p>
          </div>

          <div class="strategy-section">
            <div class="strategy-section-head">
              <h4>✅ 준비물 체크리스트</h4>
              <div class="check-progress">
                <span><strong>${doneCount}</strong> / ${allItems.length} 완료</span>
                ${doneCount > 0 ? '<button type="button" class="check-reset" data-role="resetChecks">초기화</button>' : ''}
              </div>
            </div>
            <div class="check-groups">
              ${groups.map(g => `
                <div>
                  <div class="check-group-title">${esc(g.title)}</div>
                  <ul class="check-list">
                    ${g.items.map(it => `
                      <li>
                        <label class="${checks[it.id] ? 'done' : ''}">
                          <input type="checkbox" data-check="${esc(it.id)}" ${checks[it.id] ? 'checked' : ''}>
                          <span>${esc(it.text)}</span>
                        </label>
                      </li>
                    `).join('')}
                  </ul>
                </div>
              `).join('')}
            </div>
            <p class="strategy-note">체크 상태는 이 기기에 자동 저장되어 대회 전날 다시 확인하기 좋아요.</p>
          </div>

          <div class="strategy-actions">
            <button type="button" class="strategy-btn primary" data-role="savePng">🖼️ 전략 카드 이미지 저장</button>
            <button type="button" class="strategy-btn" data-role="copyText">📋 전략 요약 복사</button>
            <span class="strategy-toast" data-role="toast"></span>
            ${state.collapsible ? '<button type="button" class="strategy-btn ghost strategy-collapse-bottom" data-role="toggleOpen" data-scroll-top="1">접기 ▴</button>' : ''}
          </div>
        </div>
      `;

      // 이벤트 바인딩
      container.querySelectorAll('[data-role="toggleOpen"]').forEach(toggleBtn => {
        toggleBtn.addEventListener('click', () => {
          const fromBottom = toggleBtn.dataset.scrollTop === '1';
          state.collapsed = !state.collapsed;
          render();
          if (fromBottom && state.collapsed) {
            container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        });
      });

      container.querySelectorAll('[data-role="dist"] [data-km]').forEach(btn => {
        btn.addEventListener('click', () => {
          const nextKm = Number(btn.dataset.km);
          if (Math.abs(nextKm - state.km) < 0.2) return;
          state.km = nextKm;
          state.totalSec = DEFAULT_GOAL[nextKm] || state.totalSec;
          render();
        });
      });

      container.querySelectorAll('[data-role="preset"] [data-sec]').forEach(btn => {
        btn.addEventListener('click', () => {
          state.totalSec = Number(btn.dataset.sec);
          render();
        });
      });

      const hIn = container.querySelector('[data-role="goalH"]');
      const mIn = container.querySelector('[data-role="goalM"]');
      if (hIn && mIn) {
        const onTime = () => {
          const nh = Math.max(0, Math.min(12, Number(hIn.value) || 0));
          const nm = Math.max(0, Math.min(59, Number(mIn.value) || 0));
          const sec = nh * 3600 + nm * 60;
          if (sec >= 600) {
            state.totalSec = sec;
            render();
          }
        };
        hIn.addEventListener('change', onTime);
        mIn.addEventListener('change', onTime);
      }

      container.querySelectorAll('[data-role="temp"] [data-temp]').forEach(btn => {
        btn.addEventListener('click', () => {
          state.temp = Number(btn.dataset.temp);
          render();
        });
      });

      const rainBtn = container.querySelector('[data-role="rain"]');
      if (rainBtn) {
        rainBtn.addEventListener('click', () => {
          state.rain = !state.rain;
          render();
        });
      }

      container.querySelectorAll('input[data-check]').forEach(cb => {
        cb.addEventListener('change', () => {
          const id = cb.dataset.check;
          if (cb.checked) checks[id] = true;
          else delete checks[id];
          saveChecks(storageKey, checks);
          render();
        });
      });

      const resetBtn = container.querySelector('[data-role="resetChecks"]');
      if (resetBtn) {
        resetBtn.addEventListener('click', () => {
          checks = {};
          saveChecks(storageKey, checks);
          render();
        });
      }

      const showToast = msg => {
        const el = container.querySelector('[data-role="toast"]');
        if (!el) return;
        el.textContent = msg;
        clearTimeout(el._t);
        el._t = setTimeout(() => { el.textContent = ''; }, 2400);
      };

      const pngBtn = container.querySelector('[data-role="savePng"]');
      if (pngBtn) {
        pngBtn.addEventListener('click', () => {
          downloadStrategyPng(state, { outfit, nutrition });
          showToast('이미지를 저장했어요!');
        });
      }

      const copyBtn = container.querySelector('[data-role="copyText"]');
      if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
          const text = buildCopyText(state, { outfit, nutrition });
          try {
            await navigator.clipboard.writeText(text);
            showToast('클립보드에 복사했어요!');
          } catch {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            showToast('클립보드에 복사했어요!');
          }
        });
      }
    }

    render();

    return {
      update(next = {}) {
        let changed = false;
        if (next.km != null && next.km > 0 && next.km !== state.km) { state.km = next.km; changed = true; }
        if (next.totalSec != null && next.totalSec > 0 && next.totalSec !== state.totalSec) { state.totalSec = next.totalSec; changed = true; }
        if (next.temp != null && next.temp !== state.temp) { state.temp = next.temp; changed = true; }
        if (changed) render();
      },
      open(scroll = false) {
        if (state.collapsed) {
          state.collapsed = false;
          render();
        }
        if (scroll) container.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    };
  }

  window.RaceStrategy = { mount, FULL, HALF };
})();
