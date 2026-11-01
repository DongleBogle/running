// 마라톤 페이스 계산기 탭 (#view-pace)
// 1) 목표 기록 ↔ 1km 페이스 (서로 바꾸면 다른 쪽이 다시 계산됨) + 구간별 통과 시각표
// 2) 달린 기록 → 페이스, 같은 페이스 유지 기록과 리겔 공식 예상 기록
// 주소에 ?d=full|half|10|5 가 있으면 목표 종목을 그것으로 시작한다 (대회 상세에서 넘어올 때)
(() => {
  const FULL = 42.195, HALF = 21.0975;
  const DISTS = [{ name: '5km', km: 5 }, { name: '10km', km: 10 }, { name: '하프', km: HALF }, { name: '풀', km: FULL }];
  // 종목별 빠른 선택 목표(초)와 기본 목표
  const PRESETS = {
    5: [['20분', 1200], ['25분', 1500], ['30분', 1800], ['35분', 2100]],
    10: [['40분', 2400], ['45분', 2700], ['50분', 3000], ['55분', 3300], ['1시간', 3600]],
    [HALF]: [['1:30', 5400], ['1:45', 6300], ['서브2', 7200], ['2:15', 8100], ['2:30', 9000]],
    [FULL]: [['서브3', 10800], ['3:30', 12600], ['서브4', 14400], ['4:30', 16200], ['서브5', 18000]],
  };
  const DEFAULT_GOAL = { 5: 1800, 10: 3300, [HALF]: 7200, [FULL]: 14400 };
  const RIEGEL = 1.06;

  const $ = id => document.getElementById(id);
  const num = id => Math.max(0, Number($(id).value) || 0);
  const hms = (h, m, s) => num(h) * 3600 + num(m) * 60 + num(s);
  const p2 = n => String(n).padStart(2, '0');
  function fmtDur(sec) {
    const t = Math.round(sec), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return h ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
  }
  // 목표 '이내'로 들어오려면 초 단위 페이스는 내림해야 한다
  const fmtPace = secPerKm => `${Math.floor(secPerKm / 60)}'${p2(Math.floor(secPerKm % 60))}"`;
  const fmtSpeed = secPerKm => `${(3600 / secPerKm).toFixed(1)}km/h`;
  const fmtKm = km => `${+km.toFixed(2)}km`;
  const distName = km => (DISTS.find(d => d.km === km) || {}).name || fmtKm(km);

  function chips(group, onPick) {
    const box = document.querySelector(`#view-pace [data-group="${group}"]`);
    box.addEventListener('click', e => {
      const b = e.target.closest('.pace-chip');
      if (!b) return;
      box.querySelectorAll('.pace-chip').forEach(c => c.classList.toggle('active', c === b));
      onPick(b.dataset);
    });
    return box;
  }
  const activeChip = group => document.querySelector(`#view-pace [data-group="${group}"] .pace-chip.active`).dataset;

  // ---- 1) 목표 기록 → 페이스 · 구간표 ----
  let goalKm = FULL;
  const setGoal = sec => {
    $('goalH').value = Math.floor(sec / 3600);
    $('goalM').value = Math.floor(sec % 3600 / 60);
    $('goalS').value = Math.round(sec % 60);
  };
  function renderPresets() {
    $('goalPresets').innerHTML = PRESETS[goalKm]
      .map(([label, sec]) => `<button type="button" class="pace-chip" data-sec="${sec}">${label}</button>`).join('');
  }
  function splitRows(km, pace, step) {
    const points = [];
    for (let k = step; k < km - 1e-9; k += step) points.push({ km: k, label: fmtKm(k) });
    if (km === FULL && step === 5) points.splice(4, 0, { km: HALF, label: '하프 (21.1km)' });
    points.push({ km, label: `결승 (${distName(km)})`, finish: true });
    return points.map(p => ({ ...p, sec: p.km * pace }));
  }
  function clockAt(start, sec) {
    if (!start) return '-';
    const [h, m] = start.split(':').map(Number);
    const t = Math.round(h * 3600 + m * 60 + sec) % 86400;
    return `${p2(Math.floor(t / 3600))}:${p2(Math.floor(t % 3600 / 60))}:${p2(t % 60)}`;
  }
  function renderGoal(fromPace) {
    let total = hms('goalH', 'goalM', 'goalS');
    if (fromPace) {
      const pace = num('goalPm') * 60 + num('goalPs');
      if (pace > 0) { total = pace * goalKm; setGoal(total); }
    }
    const pace = total / goalKm;
    if (!fromPace) {
      $('goalPm').value = total ? Math.floor(pace / 60) : '';
      $('goalPs').value = total ? Math.floor(pace % 60) : '';
    }
    document.querySelectorAll('#goalPresets .pace-chip').forEach(c => c.classList.toggle('active', Number(c.dataset.sec) === Math.round(total)));
    if (!total) {
      for (const id of ['goalPace', 'goalSpeed', 'goalPer5']) $(id).textContent = '-';
      $('splitBody').innerHTML = '<tr><td colspan="3">목표 기록을 넣어 주세요</td></tr>';
      return;
    }
    $('goalPace').textContent = fmtPace(pace);
    $('goalSpeed').textContent = fmtSpeed(pace);
    $('goalPer5').textContent = fmtDur(pace * 5);
    const start = $('goalStart').value;
    $('splitBody').innerHTML = splitRows(goalKm, pace, Number(activeChip('splitStep').step)).map(r =>
      `<tr class="${r.finish ? 'finish' : ''}"><td>${r.label}</td><td class="num">${fmtDur(r.sec)}</td><td class="num">${clockAt(start, r.sec)}</td></tr>`).join('');
  }
  function pickGoalDist(km) {
    goalKm = km;
    document.querySelectorAll('#view-pace [data-group="goalDist"] .pace-chip')
      .forEach(c => c.classList.toggle('active', Number(c.dataset.km) === km));
    setGoal(DEFAULT_GOAL[km]);
    renderPresets();
    renderGoal(false);
  }
  chips('goalDist', d => pickGoalDist(Number(d.km)));
  chips('splitStep', () => renderGoal(false));
  $('goalPresets').addEventListener('click', e => {
    const b = e.target.closest('.pace-chip');
    if (b) { setGoal(Number(b.dataset.sec)); renderGoal(false); }
  });
  for (const id of ['goalH', 'goalM', 'goalS', 'goalStart']) $(id).addEventListener('input', () => renderGoal(false));
  for (const id of ['goalPm', 'goalPs']) $(id).addEventListener('input', () => renderGoal(true));

  // ---- 2) 달린 기록 → 페이스 · 예상 기록 ----
  function renderRecord() {
    const km = Number($('recKm').value) || 0, total = hms('recH', 'recM', 'recS');
    document.querySelectorAll('#view-pace [data-group="recDist"] .pace-chip')
      .forEach(c => c.classList.toggle('active', Math.abs(Number(c.dataset.km) - km) < 1e-6));
    if (!km || !total) {
      $('recPace').textContent = $('recSpeed').textContent = '-';
      $('predictBody').innerHTML = '<tr><td colspan="3">거리와 기록을 넣어 주세요</td></tr>';
      return;
    }
    const pace = total / km;
    $('recPace').textContent = fmtPace(pace);
    $('recSpeed').textContent = fmtSpeed(pace);
    $('predictBody').innerHTML = DISTS.map(d => {
      const same = Math.abs(d.km - km) < 1e-6;
      return `<tr class="${same ? 'goal' : ''}"><td>${d.name}</td><td class="num">${fmtDur(pace * d.km)}</td>
        <td class="num">${same ? '입력한 기록' : fmtDur(total * Math.pow(d.km / km, RIEGEL))}</td></tr>`;
    }).join('');
  }
  chips('recDist', d => { $('recKm').value = +Number(d.km).toFixed(4); renderRecord(); });
  for (const id of ['recKm', 'recH', 'recM', 'recS']) $(id).addEventListener('input', renderRecord);

  const fromQuery = { full: FULL, half: HALF, 10: 10, 5: 5 }[new URLSearchParams(location.search).get('d')];
  pickGoalDist(fromQuery || FULL);
  renderRecord();
})();
