// -------------------------------------------------------------------------
// 사진 데이터 및 타임 모델
// -------------------------------------------------------------------------
let uploadedPhotos = [];

// 업로드 사진 브라우저 캐싱 (IndexedDB: dataURL이 커서 localStorage 용량으로는 부족)
let _photosLoaded = false;
function openPhotoDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('running-photos', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function loadPersistedPhotos() {
  try {
    const db = await openPhotoDb();
    const saved = await new Promise((resolve, reject) => {
      const r = db.transaction('kv').objectStore('kv').get('uploadedPhotos');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (Array.isArray(saved) && saved.length) uploadedPhotos = saved.concat(uploadedPhotos);
  } catch (e) { /* 저장소를 못 쓰는 환경(시크릿 모드 등)에서는 캐싱 없이 동작 */ }
  _photosLoaded = true;
  renderPhotosGallery();
  restoreEditedRecords();
}
// 동일 사진은 OCR을 다시 돌리지 않도록 결과를 사진 해시 기준으로 캐싱
async function photoHash(src) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(src));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    let h = 5381;
    for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) | 0;
    return 'djb2-' + src.length + '-' + h;
  }
}
async function ocrCacheGet(hash) {
  try {
    const db = await openPhotoDb();
    return await new Promise((resolve) => {
      const r = db.transaction('kv').objectStore('kv').get('ocr:' + hash);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  } catch (e) { return null; }
}
async function ocrCachePut(hash, items) {
  try {
    const db = await openPhotoDb();
    db.transaction('kv', 'readwrite').objectStore('kv').put(items, 'ocr:' + hash);
  } catch (e) { /* 무시 */ }
}
async function persistPhotos() {
  if (!_photosLoaded) return;
  try {
    const db = await openPhotoDb();
    db.transaction('kv', 'readwrite').objectStore('kv').put(uploadedPhotos, 'uploadedPhotos');
  } catch (e) { /* 무시 */ }
}

// 공식 스마트칩 체크포인트 기록 (Time of Day 기준 확실한 시간)
// 2026 SEOUL RACE 하프 마라톤
const officialCheckpoints = [];

// 스마트워치 1km 세부 랩 타임 (페이스 유추용)
const rawWatchLaps = [];

let globalStartTimeStr = "00:00:00";
let timelineRows = []; // 통합 타임테이블 행 (공식 체크포인트 + 1km 랩 유추)
let totalRaceSeconds = 0;
let totalRaceDistance = 0;
let tableFilterMode = 'all'; // 'all' or 'verified'

// -------------------------------------------------------------------------
// 시간 유틸리티
// -------------------------------------------------------------------------
function parseTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
  return 0;
}

function secondsToClockString(totalSec) {
  let sec = Math.floor(totalSec) % 86400;
  if (sec < 0) sec += 86400;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function secondsToDurationFormatted(sec) {
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}시간 ${String(m).padStart(2, '0')}분 ${String(s).padStart(2, '0')}초`;
  }
  return `${m}분 ${String(s).padStart(2, '0')}초`;
}

// 페이스 표기 통일: 분의 앞자리 0만 제거 (06:56 -> 6:56, 10:11 은 그대로)
function normalizePace(p) {
  return typeof p === 'string' ? p.trim().replace(/^0+(\d:)/, '$1') : p;
}

function secondsToPaceString(paceSec) {
  if (!paceSec || isNaN(paceSec)) return "-";
  const m = Math.floor(paceSec / 60);
  const s = Math.round(paceSec % 60);
  return `${m}'${String(s).padStart(2, '0')}"`;
}

// -------------------------------------------------------------------------
// Time of Day 기반 통합 타임라인 생성 및 랩 페이스 보간
// -------------------------------------------------------------------------
function buildUnifiedTimeline() {
  const startSec = parseTimeToSeconds(globalStartTimeStr);
  timelineRows = [];

  // 데이터가 아직 없으면 빈 상태로 표시
  if (officialCheckpoints.length === 0) {
    totalRaceSeconds = 0;
    totalRaceDistance = 0;
    document.getElementById('summaryDistance').textContent = '-';
    document.getElementById('summaryTime').textContent = '-';
    document.getElementById('summaryPace').textContent = '-';
    renderLapsTable();
    return;
  }

  // 워치 랩 누적 시간 계산
  let watchCumSec = 0;
  const watchLapsCum = rawWatchLaps.map((lap, i) => {
    const start = watchCumSec;
    watchCumSec += lap.seconds;
    return {
      lapNum: lap.lap,
      dist: lap.distance,
      startDist: (lap.lap - 1) * 1.0,
      endDist: (lap.lap - 1) * 1.0 + lap.distance,
      sec: lap.seconds,
      pace: lap.pace,
      cumStartSec: start,
      cumEndSec: watchCumSec
    };
  });
  const totalWatchSec = watchCumSec; // 약 8872.8초

  // 공식 체크포인트 딕셔너리 생성 (확실한 Time of Day 지점)
  // 키: distance (toFixed(2))
  const verifiedMap = new Map();
  officialCheckpoints.forEach(cp => {
    verifiedMap.set(cp.distance.toFixed(1), cp);
  });

  // 모든 주요 마일스톤 생성: 1km, 2km, 3km, 3.1km(체크), 4km, 5km(체크), ... 9.3km(체크), 10km(체크), 15km(체크), 21.14km(체크)
  let milestoneDistances = [];
  for (let d = 1; d <= Math.floor(officialCheckpoints[officialCheckpoints.length - 1].distance); d++) {
    milestoneDistances.push(d);
  }
  officialCheckpoints.forEach(cp => {
    if (cp.distance > 0 && !milestoneDistances.includes(cp.distance)) {
      milestoneDistances.push(cp.distance);
    }
  });
  milestoneDistances.sort((a, b) => a - b);

  let prevDist = 0;
  let prevElapsedSec = 0;

  milestoneDistances.forEach(dist => {
    const key = dist.toFixed(1);
    const isVerified = verifiedMap.has(key);
    let elapsedSec = 0;
    let clockStr = "";
    let label = "";
    let paceStr = "";

    if (isVerified) {
      const cp = verifiedMap.get(key);
      elapsedSec = cp.timeSec;
      clockStr = cp.clockStr;
      label = cp.name;
      paceStr = cp.pace;
    } else {
      // 랩 페이스 기반 보간(유추) 계산
      // 인근 앞뒤 체크포인트를 찾아 그 구간의 페이스 또는 워치 랩 비율로 보간
      let lowerCp = officialCheckpoints[0];
      let upperCp = officialCheckpoints[officialCheckpoints.length - 1];

      for (let i = 0; i < officialCheckpoints.length - 1; i++) {
        if (dist >= officialCheckpoints[i].distance && dist <= officialCheckpoints[i + 1].distance) {
          lowerCp = officialCheckpoints[i];
          upperCp = officialCheckpoints[i + 1];
          break;
        }
      }

      // 두 체크포인트 사이에서 워치 랩 누적 시간 비율로 배분 (랩 데이터 없으면 거리 비율)
      const watchAt = (d) => {
        for (const l of watchLapsCum) {
          if (d <= l.endDist + 1e-9) {
            const f = l.dist > 0 ? Math.max(0, (d - l.startDist) / l.dist) : 0;
            return l.cumStartSec + l.sec * Math.min(1, f);
          }
        }
        return totalWatchSec;
      };
      let fraction = (dist - lowerCp.distance) / (upperCp.distance - lowerCp.distance);
      if (watchLapsCum.length > 0) {
        const wLow = watchAt(lowerCp.distance);
        const wSpan = watchAt(upperCp.distance) - wLow;
        if (wSpan > 0) fraction = (watchAt(dist) - wLow) / wSpan;
      }
      elapsedSec = lowerCp.timeSec + ((upperCp.timeSec - lowerCp.timeSec) * fraction);
      // Time of Day는 앞쪽 공식 계측 시각 + 경과 차이로 계산 (출발 시각 반올림 오차 방지)
      const lowerClockSec = lowerCp.clockStr ? parseTimeToSeconds(lowerCp.clockStr) : startSec + lowerCp.timeSec;
      clockStr = secondsToClockString(lowerClockSec + (elapsedSec - lowerCp.timeSec));
      label = `${dist.toFixed(0)} km 지점`;

      // 인근 랩 페이스 찾기
      const lapRef = rawWatchLaps.find(l => l.lap === Math.ceil(dist)) || rawWatchLaps[rawWatchLaps.length - 1];
      paceStr = lapRef ? lapRef.pace : '-';
    }

    const segDist = dist - prevDist;
    const segSec = elapsedSec - prevElapsedSec;

    timelineRows.push({
      distance: dist,
      segDist: segDist,
      segSec: segSec,
      elapsedSec: elapsedSec,
      clockStr: clockStr,
      clockSec: parseTimeToSeconds(clockStr),
      paceStr: paceStr,
      label: label,
      isVerified: isVerified
    });

    prevDist = dist;
    prevElapsedSec = elapsedSec;
  });

  totalRaceSeconds = officialCheckpoints[officialCheckpoints.length - 1].timeSec;
  totalRaceDistance = officialCheckpoints[officialCheckpoints.length - 1].distance;

  // 헤더 요약 갱신
  document.getElementById('summaryDistance').textContent = totalRaceDistance.toFixed(2);
  const finSec = totalRaceSeconds;
  const fh = Math.floor(finSec / 3600);
  const fm = Math.floor((finSec % 3600) / 60);
  const fs = Math.round(finSec % 60);
  document.getElementById('summaryTime').textContent = `${fh}:${String(fm).padStart(2, '0')}:${String(fs).padStart(2, '0')}`;

  const avgPaceSec = totalRaceSeconds / totalRaceDistance;
  document.getElementById('summaryPace').textContent = secondsToPaceString(avgPaceSec);

  renderLapsTable();
}

// -------------------------------------------------------------------------
// 타임테이블 렌더링 (확실한 시간 초록색 강조 vs 유추 시간 파란색)
// -------------------------------------------------------------------------
function renderLapsTable() {
  const tbody = document.getElementById('lapsTableBody');
  tbody.innerHTML = '';

  const rowsToRender = tableFilterMode === 'verified' 
    ? timelineRows.filter(r => r.isVerified) 
    : timelineRows;

  rowsToRender.forEach((item) => {
    const tr = document.createElement('tr');
    if (item.isVerified) {
      tr.className = "row-verified";
    }

    const segTimeStr = secondsToDurationFormatted(item.segSec);
    const cumTimeStr = secondsToDurationFormatted(item.elapsedSec);

    const typeBadge = item.isVerified
      ? `<span class="badge-tag-verified">✓ Time of Day (확실)</span>`
      : `<span class="badge-tag-estimated">~ 페이스 유추</span>`;

    const clockClass = item.isVerified ? "time-verified" : "time-estimated";

    tr.innerHTML = `
      <td style="font-weight: 700;">
        <span style="${item.isVerified ? 'color: #34d399;' : 'color: #38bdf8;'}">${item.label}</span>
      </td>
      <td>${item.segDist.toFixed(2)} km</td>
      <td style="font-family: monospace;">${segTimeStr}</td>
      <td style="font-weight: 600;">${normalizePace(item.paceStr)}</td>
      <td class="${clockClass}" style="font-family: monospace; font-size: 1rem;">
        ${item.clockStr}
      </td>
      <td style="font-family: monospace;">${cumTimeStr}</td>
      <td style="color: #94a3b8;">${item.distance.toFixed(2)} km</td>
      <td>${typeBadge}</td>
    `;
    tbody.appendChild(tr);
  });
}

function setTableFilter(mode) {
  tableFilterMode = mode;
  document.getElementById('filterAllBtn').className = mode === 'all' ? 'btn btn-outline btn-green' : 'btn btn-outline';
  document.getElementById('filterVerifiedBtn').className = mode === 'verified' ? 'btn btn-outline btn-green' : 'btn btn-outline';
  renderLapsTable();
}

// -------------------------------------------------------------------------
// 사진 갤러리 관리 & 개별 제거/삭제 버튼 기능
// -------------------------------------------------------------------------
function renderPhotosGallery() {
  const gallery = document.getElementById('imagesGallery');
  const badge = document.getElementById('photoCountBadge');
  gallery.innerHTML = '';
  badge.textContent = uploadedPhotos.length;
  persistPhotos();

  if (uploadedPhotos.length === 0) {
    gallery.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 40px; text-align: center; background: #090e1a; border: 1px dashed #334155; border-radius: 12px; color: var(--text-muted);">
        <p style="font-size: 1rem;">등록된 러닝 스크린샷이 없습니다. 위에서 사진을 업로드해주세요.</p>
      </div>
    `;
    return;
  }

  uploadedPhotos.forEach((photo) => {
    const card = document.createElement('div');
    card.className = 'img-preview-card';
    card.id = `card-${photo.id}`;

    card.innerHTML = `
      <button class="img-card-delete-btn" onclick="removePhoto('${photo.id}')" title="이 사진 제거">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        제거
      </button>
      <img src="${photo.src}" alt="${photo.name}">
      <div class="img-card-info">
        <span style="font-weight: 600; color: #e2e8f0;">${photo.title}</span>
        <span class="tag" style="color: #38bdf8;">${photo.tag}</span>
      </div>
    `;
    gallery.appendChild(card);
  });
}

// 확인 팝업. 브라우저 기본 confirm() 은 앱 내 브라우저 등에서 막혀 바로 '취소'가 되므로 페이지 안 dialog 를 쓴다
function askConfirm(message, opts) {
  opts = opts || {};
  const dlg = document.getElementById('confirmDialog');
  const ok = document.getElementById('confirmOk');
  document.getElementById('confirmMsg').textContent = message;
  ok.textContent = opts.okLabel || '확인';
  ok.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-green');
  return new Promise(resolve => {
    const done = v => { dlg.removeEventListener('close', onClose); resolve(v); };
    const onClose = () => done(dlg.returnValue === 'ok');
    dlg.addEventListener('close', onClose);
    dlg.querySelectorAll('.confirm-actions button').forEach(b => { b.onclick = () => dlg.close(b.value); });
    dlg.returnValue = '';
    dlg.showModal();
  });
}

// 개별 사진 삭제
async function removePhoto(photoId) {
  const target = uploadedPhotos.find(p => p.id === photoId);
  const targetName = target ? target.title : "사진";
  if (await askConfirm(`'${targetName}' 스크린샷을 목록에서 제거할까요?`, { okLabel: '제거', danger: true })) {
    uploadedPhotos = uploadedPhotos.filter(p => p.id !== photoId);
    renderPhotosGallery();
  }
}

// 전체 사진 비우기: 사진과 함께 추출·수정한 기록(Step 2 타임테이블)도 초기화
async function clearAllUploadedPhotos() {
  if (uploadedPhotos.length === 0 && officialCheckpoints.length === 0) return;
  if (!await askConfirm('등록된 모든 사진과 추출·수정한 기록을 지울까요?', { okLabel: '전체 비우기', danger: true })) return;
  uploadedPhotos = [];
  renderPhotosGallery();
  officialCheckpoints.length = 0;
  rawWatchLaps.length = 0;
  startTimeManual = false;
  globalStartTimeStr = '00:00:00';
  document.getElementById('startTimeInput').value = '';
  setStartHint('사진을 올리면 출발 시각이 예측됩니다 · 직접 수정 가능');
  await kvSet('editedRecords', undefined);
  document.getElementById('btnResetEdits').hidden = true;
  toggleParsedEditor(false);
  setOcrReviewState('manual');
  document.getElementById('ocrStatus').textContent = '';
  buildUnifiedTimeline();
}

// 새 사진 업로드 (최대 MAX_PHOTOS장)
const MAX_PHOTOS = 5;

function handlePhotoUpload(event) {
  const files = event.target.files;
  if (!files || files.length === 0) return;

  const room = Math.max(0, MAX_PHOTOS - uploadedPhotos.length);
  if (files.length > room) {
    alert(`사진은 최대 ${MAX_PHOTOS}장까지 등록할 수 있습니다.` + (room > 0 ? ` 앞의 ${room}장만 추가됩니다.` : ' 기존 사진을 제거한 뒤 추가해 주세요.'));
  }

  for (let i = 0; i < Math.min(files.length, room); i++) {
    const file = files[i];
    const reader = new FileReader();
    reader.onload = function(e) {
      const newId = "photo-" + Date.now() + "-" + Math.random().toString(36).substr(2, 5);
      uploadedPhotos.unshift({
        id: newId,
        name: file.name,
        title: `업로드 사진: ${file.name}`,
        tag: "새로 등록됨",
        src: e.target.result
      });
      renderPhotosGallery();
    };
    reader.readAsDataURL(file);
  }
  event.target.value = '';
}

let startTimeManual = false; // 사용자가 출발 시각을 직접 고쳤으면 계측소 기록으로 덮어쓰지 않는다

function setStartHint(text) {
  document.getElementById('startTimeHint').textContent = text;
}

function deriveStartTimeFromCheckpoints() {
  if (startTimeManual) return;
  const cp = officialCheckpoints.find(c => c.distance > 0 && c.clockStr);
  if (!cp) return;
  globalStartTimeStr = secondsToClockString(parseTimeToSeconds(cp.clockStr) - cp.timeSec);
  document.getElementById('startTimeInput').value = globalStartTimeStr;
  setStartHint('사진 기록으로 예측됨 · 직접 수정 가능');
}

function onStartTimeEdit() {
  const v = document.getElementById('startTimeInput').value;
  if (!v) return;
  startTimeManual = true;
  globalStartTimeStr = v.length === 5 ? v + ':00' : v;
  setStartHint('직접 입력한 값');
  updateAllCalculations();
  if (document.getElementById('ocrReview').classList.contains('edited')) saveEditedRecords();
}

function updateAllCalculations() {
  // 출발 시각은 공식 계측소(실제 시각 - 경과 시간)로만 계산한다
  deriveStartTimeFromCheckpoints();
  buildUnifiedTimeline();
}

// -------------------------------------------------------------------------
// 유튜브 주로영상 분석 & 30초 클립 다운로더 모듈
// -------------------------------------------------------------------------
let currentYtData = null;

function setYtExampleUrl(url) {
  document.getElementById('ytUrlInput').value = url;
  analyzeYoutubeVideo();
}

function recalcYoutubeAnalysis() {
  const dist = document.getElementById('ytEditDistance').value.trim();
  const start = document.getElementById('ytEditStart').value.trim();
  if (start && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(start)) {
    alert('촬영 시작 시각은 HH:MM 또는 HH:MM:SS 형식으로 입력해주세요.');
    return;
  }
  analyzeYoutubeVideo({ distance: dist, start: start, reuseVideo: true });
}

async function analyzeYoutubeVideo(opts) {
  opts = opts || {};
  const urlInput = document.getElementById('ytUrlInput');
  const url = urlInput.value.trim();
  if (!url) {
    alert("유튜브 영상 링크를 입력해주세요.");
    return;
  }

  const loadingEl = document.getElementById('ytAnalysisLoading');
  const resultEl = document.getElementById('ytAnalysisResult');
  const btnAnalyze = document.getElementById('btnAnalyzeYt');

  loadingEl.style.display = 'block';
  resultEl.style.display = 'none';
  btnAnalyze.disabled = true;

  try {
    const res = await fetch(Platform.apiUrl('/api/youtube/analyze'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url,
        startTime: globalStartTimeStr,
        laps: rawWatchLaps,
        timeline: timelineRows,
        video: opts.reuseVideo && currentYtData ? currentYtData.video : undefined,
        overrideDistanceKm: opts.distance || undefined,
        overrideStartClock: opts.start || undefined
      })
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || '분석 중 오류가 발생했습니다.');
    }

    currentYtData = data;
    renderYoutubeAnalysis(data);
    // 빈 칸 표시는 매번 갱신하고, 팝업은 새로 분석했을 때만 (직접 고쳐서 다시 계산할 때는 띄우지 않음)
    notifyExtractFailure(data.analysis, !opts.reuseVideo);
  } catch (err) {
    console.error(err);
    alert(`유튜브 분석 실패: ${err.message}`);
  } finally {
    loadingEl.style.display = 'none';
    btnAnalyze.disabled = false;
  }
}

// 촬영 지점·시작 시각을 영상 설명에서 못 찾았으면 빈 칸을 표시하고, showDialog 면 팝업으로 알린다
function notifyExtractFailure(analysis, showDialog) {
  const missing = [];
  const distEl = document.getElementById('ytEditDistance'), startEl = document.getElementById('ytEditStart');
  distEl.classList.toggle('missing', analysis.detectedDistanceKm == null);
  startEl.classList.toggle('missing', !analysis.videoStartTimeStr);
  if (analysis.detectedDistanceKm == null) missing.push('촬영 지점(km)');
  if (!analysis.videoStartTimeStr) missing.push('촬영 시작 시각');
  if (!missing.length || !showDialog) return;
  document.getElementById('ytExtractFailItems').textContent = missing.join('과 ');
  document.getElementById('ytExtractFailDialog').showModal();
}

function closeExtractFailDialog() {
  document.getElementById('ytExtractFailDialog').close();
  const first = document.querySelector('.yt-edit-input.missing');
  if (first) {
    first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    first.focus({ preventScroll: true });
  }
}

function renderYoutubeAnalysis(data) {
  const { video, analysis } = data;
  const resultEl = document.getElementById('ytAnalysisResult');
  resultEl.style.display = 'block';

  // 1. 비디오 메타 정보
  document.getElementById('ytVideoThumb').src = video.thumbnailUrl;
  document.getElementById('ytVideoTitle').textContent = video.title;
  document.getElementById('ytVideoAuthor').textContent = video.author || "YouTube Channel";
  
  const totalMin = Math.floor(video.lengthSeconds / 60);
  const totalSec = video.lengthSeconds % 60;
  document.getElementById('ytVideoDuration').textContent = `영상 전체 길이: ${totalMin}분 ${totalSec}초 (${video.lengthSeconds}초)`;

  // 2. 배지 렌더링
  const badgesEl = document.getElementById('ytAnalysisBadges');
  badgesEl.innerHTML = '';

  const pointName = analysis.pointLabel || (analysis.detectedDistanceKm ? `${analysis.detectedDistanceKm}km` : '해당 지점');
  if (analysis.detectedDistanceKm) {
    badgesEl.innerHTML += `<span class="analysis-pill neon">📍 촬영 지점: ${pointName}</span>`;
  }
  if (analysis.videoStartTimeStr) {
    badgesEl.innerHTML += `<span class="analysis-pill orange">⏱️ 촬영 시작: ${analysis.videoStartTimeStr}</span>`;
  }
  if (analysis.runnerPassClockStr) {
    badgesEl.innerHTML += `<span class="analysis-pill">🏃 내 ${pointName} 통과: ${analysis.runnerPassClockStr}</span>`;
  }

  // 수정 입력칸에 현재(자동 파싱 또는 사용자 지정) 값 채우기
  document.getElementById('ytEditDistance').value = analysis.detectedDistanceKm != null ? analysis.detectedDistanceKm : '';
  document.getElementById('ytEditStart').value = analysis.videoStartTimeStr || '';

  // 3. 설명 분석 포인트
  const explListEl = document.getElementById('ytExplanationList');
  explListEl.innerHTML = analysis.explanationPoints.map(pt => {
    // 마크다운 볼드 <strong> 치환
    const formatted = pt.replace(/\*\*(.*?)\*\*/g, '<strong style="color: #38bdf8;">$1</strong>');
    return `<li>${formatted}</li>`;
  }).join('');

  // 4. 빠른 적용 버튼들
  const quickBtnsEl = document.getElementById('ytTimestampQuickBtns');
  quickBtnsEl.innerHTML = '';

  if (analysis.urlTimestamp !== null) {
    const uMin = Math.floor(analysis.urlTimestamp / 60);
    const uSec = analysis.urlTimestamp % 60;
    const btn = document.createElement('button');
    btn.className = 'btn-quick';
    btn.style.cssText = 'border-color: #ef4444; color: #f87171; font-weight: 700;';
    btn.innerHTML = `🔗 유튜브 링크 시점: ${uMin}분 ${uSec}초 (${analysis.urlTimestamp}초)`;
    btn.onclick = () => setClipStartFromTimestamp(Math.max(0, analysis.urlTimestamp - 5));
    quickBtnsEl.appendChild(btn);
  }

  if (analysis.calculatedVideoSeconds !== null) {
    const cMin = Math.floor(analysis.calculatedVideoSeconds / 60);
    const cSec = analysis.calculatedVideoSeconds % 60;
    const btn = document.createElement('button');
    btn.className = 'btn-quick';
    btn.style.cssText = 'border-color: #10b981; color: #34d399; font-weight: 700;';
    btn.innerHTML = `🎯 내 기록 계산 시점: ${cMin}분 ${cSec}초 (${analysis.calculatedVideoSeconds}초)`;
    btn.onclick = () => setClipStartFromTimestamp(Math.max(0, analysis.calculatedVideoSeconds - 5));
    quickBtnsEl.appendChild(btn);
  }
  document.getElementById('ytTimestampQuick').style.display = quickBtnsEl.children.length ? 'flex' : 'none';

  // 5. 기본 클립 파라미터 세팅
  const startInput = document.getElementById('clipStartInput');
  const durInput = document.getElementById('clipDurationInput');
  startInput.value = analysis.recommendedClipStart;
  durInput.value = analysis.recommendedDuration || 30;

  onClipParamsChange();
  playActiveClip(false);
}

function onClipParamsChange() {
  const startSec = parseInt(document.getElementById('clipStartInput').value) || 0;
  const durSec = parseInt(document.getElementById('clipDurationInput').value) || 30;
  const endSec = startSec + durSec;

  const startMin = Math.floor(startSec / 60);
  const startRemainderSec = startSec % 60;
  const endMin = Math.floor(endSec / 60);
  const endRemainderSec = endSec % 60;

  const rangeStr = `${startMin}:${String(startRemainderSec).padStart(2, '0')} ~ ${endMin}:${String(endRemainderSec).padStart(2, '0')} (${durSec}초)`;
  document.getElementById('clipRangeText').textContent = rangeStr;
  document.getElementById('clipExactSecondsText').textContent = `${startSec}초 ~ ${endSec}초 구간`;

  // 유튜브 외부 링크 및 IFrame 갱신
  if (currentYtData && currentYtData.video) {
    const videoId = currentYtData.video.videoId;
    const btnExt = document.getElementById('btnOpenYoutubeWeb');
    if (btnExt) {
      btnExt.href = `https://www.youtube.com/watch?v=${videoId}&t=${startSec}s`;
    }
  }
}

function playActiveClip(autoplay) {
  if (!currentYtData || !currentYtData.video) return;
  const videoId = currentYtData.video.videoId;
  const startSec = parseInt(document.getElementById('clipStartInput').value) || 0;
  const durSec = parseInt(document.getElementById('clipDurationInput').value) || 30;
  const endSec = startSec + durSec;

  const player = document.getElementById('ytActivePlayer');
  if (player) {
    // start & end 파라미터로 지정 구간만 재생
    player.src = `https://www.youtube.com/embed/${videoId}?start=${startSec}&end=${endSec}&autoplay=${autoplay ? 1 : 0}&enablejsapi=1`;
  }
}

function setClipDuration(dur) {
  document.getElementById('clipDurationInput').value = dur;
  onClipParamsChange();
  playActiveClip(true);
}

function adjustClipStart(delta) {
  const current = parseInt(document.getElementById('clipStartInput').value) || 0;
  document.getElementById('clipStartInput').value = Math.max(0, current + delta);
  onClipParamsChange();
  playActiveClip(true);
}

function setClipStartFromTimestamp(sec) {
  document.getElementById('clipStartInput').value = Math.max(0, sec);
  onClipParamsChange();
  playActiveClip(true);
}

// -------------------------------------------------------------------------
// 대회별 주로영상: 날짜 → 그날 대회 → 주로영상
//   대회 목록: data/calendar (전체 대회), 영상: /api/race/videos (유튜브 실시간 검색)
// -------------------------------------------------------------------------
const raceRec = { races: [], date: null, raceId: null, live: {} };  // live: 대회id → 실시간 검색 결과(또는 진행 중 Promise)

function escHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatRaceDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getMonth() + 1}.${d.getDate()} (${'일월화수목금토'[d.getDay()]})`;
}

function formatDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function racesOnDate(date) {
  return raceRec.races.filter(r => r.date === date).sort((a, b) => a.name.localeCompare(b.name));
}

async function loadRaceVideos() {
  const box = document.getElementById('raceRecBox');
  try {
    const get = async f => { const res = await fetch(Platform.dataUrl(f), { cache: 'no-cache' }); if (!res.ok) throw new Error(res.status); return res.json(); };
    const { months = [] } = await get('calendar/index.json');
    const files = await Promise.all(months.map(m => get(`calendar/${m}.json`).catch(() => ({ races: [] }))));
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    // 주로영상은 대회가 끝나야 올라오므로 오늘까지 열린 대회만
    raceRec.races = files.flatMap(f => f.races || []).filter(r => r.date <= todayKey);
  } catch (err) {
    console.warn('대회 목록을 불러오지 못했습니다', err);
    box.style.display = 'none';
    return;
  }
  if (!raceRec.races.length) { box.style.display = 'none'; return; }
  // 대회 페이지의 '레이스 기록으로 내 모습 찾기'(converter?race=<id>)로 왔으면 그 대회를 미리 골라 둔다
  const linked = raceRec.races.find(r => r.id === new URLSearchParams(location.search).get('race'));
  if (linked) { raceRec.date = linked.date; raceRec.raceId = linked.id; renderRaceRec(); return; }
  selectRaceDate(raceRec.races.reduce((a, r) => r.date > a ? r.date : a, ''));
}

// 날짜를 고르면 그 날짜의 대회만 보여준다
function selectRaceDate(date) {
  raceRec.date = date;
  const first = racesOnDate(date)[0];
  raceRec.raceId = first ? first.id : null;
  renderRaceRec();
}

function selectRace(raceId) {
  if (!raceRec.races.some(r => r.id === raceId)) return;
  raceRec.raceId = raceId;
  renderRaceRec();
}

// 유튜브 실시간 검색 (대회당 한 번만 요청하고 결과는 기억해 둔다)
function fetchLiveCourse(race) {
  if (!raceRec.live[race.id]) {
    const url = Platform.apiUrl('/api/race/videos?' + new URLSearchParams({ name: race.name, date: race.date, kind: 'course' }));
    raceRec.live[race.id] = fetch(url)
      .then(res => res.ok ? res.json() : { videos: [] })
      .then(d => (d.videos || []).filter(v => v.type === 'course' && v.publishedAt >= race.date))
      .catch(() => []);
  }
  return raceRec.live[race.id];
}

function renderRaceRec() {
  const dates = [...new Set(raceRec.races.map(r => r.date))].sort().reverse();
  const dateSel = document.getElementById('raceDateSelect');
  dateSel.innerHTML = dates.map(d =>
    `<option value="${d}">${formatRaceDate(d)} · ${raceRec.races.filter(r => r.date === d).length}개 대회</option>`).join('');
  dateSel.value = raceRec.date;

  const nameSel = document.getElementById('raceNameSelect');
  nameSel.innerHTML = racesOnDate(raceRec.date).map(r =>
    `<option value="${escHtml(r.id)}">${escHtml(r.name)}</option>`).join('');
  nameSel.value = raceRec.raceId;

  const race = raceRec.races.find(r => r.id === raceRec.raceId);
  if (!race) return;
  document.getElementById('raceMeta').textContent = `${formatRaceDate(race.date)} · ${race.location || ''}`;
  renderRaceVideos(race, [], true);
  fetchLiveCourse(race).then(live => {
    if (raceRec.raceId !== race.id) return;  // 그사이 다른 대회를 골랐으면 무시
    const seen = new Set();  // 같은 영상이 검색 결과에 두 번 올 때가 있어 videoId 로 중복 제거
    renderRaceVideos(race, live.filter(v => !seen.has(v.videoId) && seen.add(v.videoId)), false);
  });
}

function renderRaceVideos(race, list, loading) {
  const grid = document.getElementById('raceVideoGrid');
  if (!list.length) {
    grid.innerHTML = `<div class="race-empty" style="grid-column: 1 / -1;">${loading ? '유튜브에서 주로영상을 찾는 중...'
      : `아직 찾은 주로영상이 없습니다. <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(race.name + ' 주로영상')}" target="_blank" rel="noopener">유튜브에서 직접 검색</a>해 링크를 아래에 붙여넣어 주세요.`}</div>`;
    return;
  }
  grid.innerHTML = list.map(v => {
    const tags = [];
    if (v.lengthSeconds) tags.push(`<span class="tag clock">▶ ${formatDuration(v.lengthSeconds)}</span>`);
    if (v.publishedAt) tags.push(`<span class="tag">업로드 ${escHtml(v.publishedAt.slice(5).replace('-', '.'))}</span>`);
    return `<button type="button" class="race-video-card" title="${escHtml(v.title)}" onclick="pickRaceVideo('${escHtml(v.url)}')">
      <img loading="lazy" src="${escHtml(v.thumbnailUrl)}" alt="">
      <div class="body"><div class="t">${escHtml(v.title)}</div><div class="c">${escHtml(v.channel)}</div><div class="tags">${tags.join('')}</div></div></button>`;
  }).join('') + (loading ? '<div class="race-empty" style="grid-column: 1 / -1;">유튜브에서 주로영상을 더 찾는 중...</div>' : '');
}

function pickRaceVideo(url) {
  setYtExampleUrl(url);
  document.getElementById('ytUrlInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// -------------------------------------------------------------------------
// 초기화
// -------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  buildUnifiedTimeline();
  renderPhotosGallery();
  loadPersistedPhotos();
  loadRaceVideos();
});

// -------------------------------------------------------------------------
// 스텝(접기/펼치기) 제어
// -------------------------------------------------------------------------
function toggleStep(n) {
  document.getElementById('step' + n).classList.toggle('collapsed');
}

function goToStep(n) {
  for (let i = 1; i <= 3; i++) {
    document.getElementById('step' + i).classList.toggle('collapsed', i !== n);
  }
  document.getElementById('step' + n).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// -------------------------------------------------------------------------
// Step 1 -> 2 : 업로드된 사진 OCR 분석 후 계산 데이터에 반영
// -------------------------------------------------------------------------
function parseElapsedToSec(str) {
  const p = (str || '').split(':').map(Number);
  if (p.some(isNaN)) return 0;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return 0;
}

function normOcrText(t) {
  return (t || '')
    .replace(/[；;]/g, ':')
    .replace(/[·,]/g, '.')
    .replace(/(\d)\s*:\s*(\d)/g, '$1:$2');
}

function parseOcrTextToRunningData(rawText) {
  const lines = rawText.split('\n').map(l => normOcrText(l.trim())).filter(Boolean);
  const items = [];
  const CLOCK_RE = /\b([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)\b/g;
  const LAP_RE = /\b(\d{1,2}):([0-5]\d)(?:\.(\d+))?\b/g;
  const KM_RE = /(\d+(?:\.\d+)?)\s*km/i;
  const DIST_RE = /(?<![\d:.])\d{1,2}\.\d{2}(?![\d:])/;

  let lastLap = 0;
  for (const line of lines) {
    const clockMatches = [...line.matchAll(CLOCK_RE)].map(m => {
      const h = String(parseInt(m[1], 10)).padStart(2, '0');
      return `${h}:${m[2]}:${m[3]}`;
    });
    const rest = line.replace(CLOCK_RE, ' ');
    const kmMatch = KM_RE.exec(line);
    const distMatch = DIST_RE.exec(rest);
    // OCR이 소수 자리를 과인식(7:44.77)해도 소수 1자리로 정규화
    const lapMatches = [...rest.matchAll(LAP_RE)].map(m => m[3] ? `${m[1]}:${m[2]}.${m[3][0]}` : m[0]);

    if (kmMatch && clockMatches.length >= 1) {
      // 공식 체크포인트: POINT, TIME, TIME-OF-DAY, PACE
      const timeStr = clockMatches[0];
      const clockStr = clockMatches.length >= 2 ? clockMatches[1] : '';
      const pace = lapMatches.length > 0 ? lapMatches[lapMatches.length - 1] : '';
      items.push({
        point: kmMatch[0].toLowerCase(),
        time: timeStr,
        clock: clockStr,
        pace: pace,
        type: 'verified'
      });
    } else if (distMatch && lapMatches.length > 0 && lapMatches[0].includes('.')) {
      // 랩 행: [번호] 시간(M:SS.S) 거리 페이스
      const leadMatch = /^\s*(\d{1,2})\b/.exec(line);
      let lapNo = leadMatch ? parseInt(leadMatch[1], 10) : null;
      if (lapNo === null || (lastLap && lapNo !== lastLap + 1)) {
        lapNo = lastLap + 1;
      }
      lastLap = lapNo;
      const timeStr = lapMatches[0];
      const pace = lapMatches.length >= 2 ? lapMatches[lapMatches.length - 1] : '';
      items.push({
        point: `Lap ${lapNo}`,
        time: timeStr,
        clock: '',
        pace: pace,
        lapNo: lapNo,
        dist: distMatch[0],
        type: 'lap'
      });
    }
  }
  return items;
}

let _ocrWorker = null;
// Tesseract.js 는 용량이 커서 홈·캘린더에서는 받지 않고, OCR 을 처음 쓸 때 불러온다
function loadTesseract() {
  if (typeof Tesseract !== 'undefined') return Promise.resolve();
  return new Promise(resolve => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = s.onerror = resolve;
    document.head.appendChild(s);
  });
}
async function getOcrWorker() {
  await loadTesseract();
  if (typeof Tesseract === 'undefined') {
    throw new Error('Tesseract.js 라이브러리를 불러오지 못했습니다.');
  }
  if (!_ocrWorker) {
    // 숫자/시간 위주 화면이므로 영어 모델만 사용 (kor 혼용 시 숫자 오인식 증가)
    _ocrWorker = await Tesseract.createWorker('eng');
    await _ocrWorker.setParameters({
      tessedit_char_whitelist: '0123456789:.;,·kmKM ',
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1'
    });
  }
  return _ocrWorker;
}

// 이미지 전처리: 확대 + 그레이스케일 + 어두운 배경 반전 + 대비 보정
async function preprocessForOcr(imageUrl) {
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.'));
    im.src = imageUrl;
  });
  const scale = Math.min(3, Math.max(1, 2200 / Math.max(img.width, img.height)));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const px = d.data;
  let sum = 0;
  const gray = new Uint8ClampedArray(px.length / 4);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    gray[j] = g; sum += g;
  }
  const invert = (sum / gray.length) < 128;
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    let g = invert ? 255 - gray[j] : gray[j];
    g = Math.max(0, Math.min(255, (g - 128) * 1.6 + 128));
    px[i] = px[i + 1] = px[i + 2] = g;
  }
  ctx.putImageData(d, 0, 0);
  return c.toDataURL('image/png');
}

// Tesseract 단어들을 y 중심 기준으로 행으로 묶어 텍스트화
function wordsToLines(words) {
  const ws = (words || []).filter(w => w.text && w.text.trim())
    .map(w => ({ t: w.text.trim(), x0: w.bbox.x0, cy: (w.bbox.y0 + w.bbox.y1) / 2, h: w.bbox.y1 - w.bbox.y0 }))
    .sort((a, b) => a.cy - b.cy);
  const rows = [];
  for (const w of ws) {
    const row = rows[rows.length - 1];
    if (row) {
      const ref = row.reduce((s, r) => s + r.cy, 0) / row.length;
      if (Math.abs(w.cy - ref) <= Math.max(w.h, row[0].h) * 0.6) { row.push(w); continue; }
    }
    rows.push([w]);
  }
  return rows.map(r => r.sort((a, b) => a.x0 - b.x0).map(w => w.t).join(' ')).join('\n');
}

async function runBrowserOcr(imageUrl, onProgress) {
  const worker = await getOcrWorker();
  const processed = await preprocessForOcr(imageUrl);
  const ret = await worker.recognize(processed);
  const text = (ret.data.words && ret.data.words.length) ? wordsToLines(ret.data.words) : ret.data.text;
  console.debug('[OCR raw]\n' + text);
  return text;
}

async function analyzeAndGoStep2() {
  const btn = document.getElementById('btnStep2');
  const status = document.getElementById('ocrStatus');
  if (uploadedPhotos.length === 0) {
    if (!await askConfirm('등록된 사진이 없습니다. 사진 분석 없이 Step 2로 넘어가 기록을 직접 입력할까요?', { okLabel: '넘어가기' })) return;
    goToStep(2);
    return;
  }
  // 같은 사진으로 타임테이블을 고쳐 둔 적이 있으면 OCR 결과 대신 그 값을 쓴다
  if (await restoreEditedRecords()) {
    status.textContent = '저장된 수정값을 불러왔습니다.';
    goToStep(2);
    return;
  }
  btn.disabled = true;
  const verified = [];
  const laps = [];
  try {
    for (let i = 0; i < uploadedPhotos.length; i++) {
      status.textContent = `브라우저 OCR 인식 중... (${i + 1}/${uploadedPhotos.length})`;
      let ocrItems = [];
      const hash = await photoHash(uploadedPhotos[i].src);
      const cached = await ocrCacheGet(hash);
      if (cached) {
        status.textContent = `저장된 OCR 결과 사용 중... (${i + 1}/${uploadedPhotos.length})`;
        cached.forEach(it => (it.type === 'verified' ? verified : laps).push(it));
        continue;
      }

      // localhost / Vercel 모두 동일하게 브라우저 Tesseract.js OCR 사용
      status.textContent = `브라우저 OCR 진행 중... (${i + 1}/${uploadedPhotos.length})`;
      const text = await runBrowserOcr(uploadedPhotos[i].src);
      ocrItems = parseOcrTextToRunningData(text);

      if (ocrItems.length) await ocrCachePut(hash, JSON.parse(JSON.stringify(ocrItems)));
      ocrItems.forEach(it => (it.type === 'verified' ? verified : laps).push(it));
    }
    applyOcrResults(verified, laps);
    status.textContent = `분석 완료: 공식 계측 ${verified.length}개, 랩 ${laps.length}개`;
    setOcrReviewState(verified.length || laps.length ? 'extracted' : 'empty');
    goToStep(2);
  } catch (err) {
    status.textContent = '';
    alert('OCR 분석 실패: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

function applyOcrResults(verified, laps, opts) {
  opts = opts || {};
  // 공식 체크포인트: point(예 "5.0km"), time(경과), clock(Time of Day), pace
  const cps = verified
    .map(v => ({
      distance: parseFloat(v.point),
      timeSec: parseElapsedToSec(v.time),
      clockStr: v.clock || '',
      pace: normalizePace(v.pace) || '-',
      name: `${parseFloat(v.point)}km 계측소`
    }))
    .filter(c => !isNaN(c.distance) && c.distance > 0)
    .sort((a, b) => a.distance - b.distance);

  officialCheckpoints.length = 0;
  if (cps.length > 0) {
    const first = cps.find(c => c.clockStr) || cps[0];
    // 타임테이블 수정에서 다시 계산할 때, 사용자가 직접 고친 출발 시각은 그대로 둔다
    const keepStart = opts.keepStart && startTimeManual;
    const startSec = keepStart ? parseTimeToSeconds(globalStartTimeStr)
      : first.clockStr ? parseTimeToSeconds(first.clockStr) - first.timeSec : 0;
    if (!keepStart) {
      globalStartTimeStr = secondsToClockString(startSec);
      startTimeManual = false;
      document.getElementById('startTimeInput').value = globalStartTimeStr;
      setStartHint(opts.edited ? '수정한 기록으로 예측됨 · 직접 수정 가능' : '사진 기록으로 예측됨 · 직접 수정 가능');
    }
    officialCheckpoints.push({ distance: 0, timeSec: 0, clockStr: globalStartTimeStr, pace: '-', name: '출발 (Start)' });
    cps.forEach(c => {
      if (!c.clockStr) c.clockStr = secondsToClockString(startSec + c.timeSec);
      officialCheckpoints.push(c);
    });
    const last = officialCheckpoints[officialCheckpoints.length - 1];
    last.name = `완주 (Finish ${last.distance}km)`;
  }

  // 랩: OCR이 읽은 실제 랩 번호/거리를 사용한다 (사진에 누락된 랩이 있어도 번호가 밀리지 않도록)
  rawWatchLaps.length = 0;
  const lapMap = new Map();
  laps.forEach((l, i) => {
    const m = /(\d+)/.exec(l.point || '');
    const lapNo = l.lapNo || (m ? parseInt(m[1], 10) : i + 1);
    const sec = parseElapsedToSec((l.time || '').split('.')[0]) + (parseFloat('0.' + ((l.time || '').split('.')[1] || '0')) || 0);
    const dist = parseFloat(l.dist) || 1.0;
    lapMap.set(lapNo, { lap: lapNo, timeStr: l.time, seconds: sec, distance: dist, pace: normalizePace(l.pace) || '-', estimated: false });
  });
  const lapNos = [...lapMap.keys()].sort((a, b) => a - b);
  for (let n = 1; n <= (lapNos[lapNos.length - 1] || 0); n++) {
    if (lapMap.has(n)) { rawWatchLaps.push(lapMap.get(n)); continue; }
    // 누락된 랩: 앞뒤 랩의 평균 시간으로 추정 (공식 계측 구간 내에서 다시 보정됨)
    const prev = lapMap.get(n - 1) || rawWatchLaps[rawWatchLaps.length - 1];
    let next = null;
    for (let k = n + 1; k <= lapNos[lapNos.length - 1]; k++) { if (lapMap.has(k)) { next = lapMap.get(k); break; } }
    const secs = prev && next ? (prev.seconds + next.seconds) / 2 : (prev || next || { seconds: 0 }).seconds;
    rawWatchLaps.push({ lap: n, timeStr: '', seconds: secs, distance: 1.0, pace: normalizePace(secondsToPaceString(secs).replace("'", ':').replace('"', '')), estimated: true });
  }

  buildUnifiedTimeline();
}

// -------------------------------------------------------------------------
// Step 2 : 추출 결과(공식 계측·워치 랩) 확인 및 직접 수정 → 타임테이블 다시 계산
// -------------------------------------------------------------------------
const OCR_REVIEW_TEXT = {
  extracted: ['✅ AI로 기록 추출 완료', '전체 구간별 타임테이블이 올바르게 추출·계산되었는지 확인 후 수정해주세요.'],
  empty: ['⚠️ 사진에서 기록을 찾지 못했어요', '추출 결과 확인·수정을 눌러 공식 계측 기록과 워치 랩을 직접 입력해주세요.'],
  edited: ['✏️ 수정한 기록으로 계산했어요', '수정값은 이 브라우저에 저장돼요. 다시 고칠 곳이 있으면 추출 결과 확인·수정을 눌러주세요.'],
  manual: ['✍️ 기록을 직접 입력할 수 있어요', '사진 없이도 공식 계측 기록과 워치 1km 구간 기록을 입력하면 타임테이블이 계산됩니다.'],
};

function setOcrReviewState(state) {
  const [title, desc] = OCR_REVIEW_TEXT[state];
  const box = document.getElementById('ocrReview');
  box.className = 'ocr-review ' + state;
  document.getElementById('ocrReviewTitle').textContent = title;
  document.getElementById('ocrReviewDesc').textContent = desc;
}

// 초 → 'H:MM:SS' / 'M:SS.s'
function secToHms(sec) {
  const t = Math.round(sec), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function secToLapStr(sec) {
  const m = Math.floor(sec / 60), s = sec - m * 60;
  const whole = Math.floor(s), tenth = Math.round((s - whole) * 10);
  return tenth === 10 ? `${m}:${String(whole + 1).padStart(2, '0')}` : `${m}:${String(whole).padStart(2, '0')}${tenth ? '.' + tenth : ''}`;
}
function secToPace(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  const r = Math.round(sec), m = Math.floor(r / 60);
  return `${m}:${String(r % 60).padStart(2, '0')}`;
}

function parsedRowHtml(kind, v) {
  const del = '<td><button type="button" class="parsed-del" onclick="deleteParsedRow(this)" title="이 행 삭제">✕</button></td>';
  if (kind === 'cp') {
    return `<tr><td><input class="p-dist" inputmode="decimal" value="${escHtml(v.distance ?? '')}" placeholder="21.1"></td>
      <td><input class="p-time" value="${escHtml(v.time ?? '')}" placeholder="1:52:30"></td>
      <td><input class="p-clock" value="${escHtml(v.clock ?? '')}" placeholder="09:42:30"></td>${del}</tr>`;
  }
  return `<tr><td class="lap-no">${v.estimated ? '<span class="est-mark">추정</span>' : ''}</td>
    <td><input class="p-dist" inputmode="decimal" value="${escHtml(v.distance ?? '1.00')}" placeholder="1.00"></td>
    <td><input class="p-time" value="${escHtml(v.time ?? '')}" placeholder="5:38.4"></td>${del}</tr>`;
}

function fillParsedEditor() {
  document.getElementById('cpEditBody').innerHTML = officialCheckpoints.filter(c => c.distance > 0).map(c =>
    parsedRowHtml('cp', { distance: c.distance, time: secToHms(c.timeSec), clock: c.clockStr || '' })).join('');
  document.getElementById('lapEditBody').innerHTML = rawWatchLaps.map(l =>
    parsedRowHtml('lap', { distance: Number(l.distance).toFixed(2), time: secToLapStr(l.seconds), estimated: l.estimated })).join('');
  renumberLaps();
  document.getElementById('parsedError').textContent = '';
}

function renumberLaps() {
  document.querySelectorAll('#lapEditBody tr').forEach((tr, i) => {
    const td = tr.querySelector('.lap-no');
    td.innerHTML = `${i + 1}${td.querySelector('.est-mark') ? ' <span class="est-mark">추정</span>' : ''}`;
  });
}

function toggleParsedEditor(open) {
  const ed = document.getElementById('parsedEditor');
  open = open === undefined ? ed.hidden : open;
  if (open) fillParsedEditor();
  ed.hidden = !open;
  document.getElementById('btnToggleParsed').textContent = open ? '닫기' : '추출 결과 확인·수정';
}

function deleteParsedRow(btn) {
  btn.closest('tr').remove();
  renumberLaps();
}

function addParsedRow(kind) {
  document.getElementById(kind === 'cp' ? 'cpEditBody' : 'lapEditBody').insertAdjacentHTML('beforeend', parsedRowHtml(kind, {}));
  if (kind === 'lap') renumberLaps();
}

// 표의 값을 검사해 OCR 결과와 같은 형태로 바꾼 뒤 applyOcrResults 로 다시 계산한다
function applyParsedEdits() {
  const err = document.getElementById('parsedError');
  document.querySelectorAll('.parsed-table input.bad').forEach(i => i.classList.remove('bad'));
  const bad = (input, msg) => { input.classList.add('bad'); input.focus(); err.textContent = msg; return false; };
  const HMS = /^\d{1,2}:\d{2}(:\d{2})?$/, LAP = /^\d{1,2}:\d{2}(\.\d)?$/;

  const cps = [];
  for (const tr of document.querySelectorAll('#cpEditBody tr')) {
    const [d, t, c] = ['.p-dist', '.p-time', '.p-clock'].map(s => tr.querySelector(s));
    if (!d.value.trim() && !t.value.trim() && !c.value.trim()) continue;  // 빈 행은 무시
    const dist = parseFloat(d.value);
    if (!(dist > 0)) return bad(d, '계측 지점(km)을 숫자로 입력해주세요.');
    if (!HMS.test(t.value.trim())) return bad(t, '경과 시간은 H:MM:SS 형식으로 입력해주세요. (예: 1:52:30)');
    if (c.value.trim() && !HMS.test(c.value.trim())) return bad(c, '실제 시각은 HH:MM:SS 형식으로 입력해주세요. (예: 09:42:30)');
    const parts = t.value.trim().split(':').map(Number);
    const sec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 3600 + parts[1] * 60;
    const clock = c.value.trim() ? secondsToClockString(parseTimeToSeconds(c.value.trim())) : '';
    cps.push({ dist, sec, clock, input: t });
  }
  if (!cps.length) { err.textContent = '공식 계측 기록을 하나 이상 입력해주세요. (최소한 완주 기록)'; return false; }
  cps.sort((a, b) => a.dist - b.dist);
  for (let i = 1; i < cps.length; i++) {
    if (cps[i].sec <= cps[i - 1].sec) return bad(cps[i].input, `${cps[i].dist}km 경과 시간이 앞 지점보다 빠릅니다. 확인해주세요.`);
  }

  const laps = [];
  for (const tr of document.querySelectorAll('#lapEditBody tr')) {
    const [d, t] = ['.p-dist', '.p-time'].map(s => tr.querySelector(s));
    if (!d.value.trim() && !t.value.trim()) continue;
    const dist = parseFloat(d.value);
    if (!(dist > 0)) return bad(d, '랩 거리(km)를 숫자로 입력해주세요.');
    if (!LAP.test(t.value.trim())) return bad(t, '구간 시간은 M:SS 또는 M:SS.S 형식으로 입력해주세요. (예: 5:38.4)');
    laps.push({ dist, time: t.value.trim() });
  }

  const verified = cps.map((c, i) => {
    const prev = cps[i - 1] || { dist: 0, sec: 0 };
    return { point: `${c.dist}km`, time: secToHms(c.sec), clock: c.clock, pace: secToPace((c.sec - prev.sec) / (c.dist - prev.dist)), type: 'verified' };
  });
  const lapItems = laps.map((l, i) => {
    const sec = parseElapsedToSec(l.time.split('.')[0]) + (parseFloat('0.' + (l.time.split('.')[1] || '0')) || 0);
    return { point: `Lap ${i + 1}`, lapNo: i + 1, time: l.time, dist: l.dist.toFixed(2), pace: secToPace(sec / l.dist), type: 'lap' };
  });

  applyOcrResults(verified, lapItems, { keepStart: true, edited: true });
  toggleParsedEditor(false);
  setOcrReviewState('edited');
  saveEditedRecords();
  document.querySelector('#step2 .table-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  return true;
}

// -------------------------------------------------------------------------
// 수정한 기록 저장/복원 (IndexedDB 'kv' 의 editedRecords)
//   지금 등록된 사진 묶음(사진 해시 목록)과 함께 저장해, 같은 사진일 때만 복원한다.
//   사진을 바꾸면 예전 수정값은 쓰지 않고 새로 추출한다.
// -------------------------------------------------------------------------
async function photoSetKey() {
  const hashes = await Promise.all(uploadedPhotos.map(p => photoHash(p.src)));
  return hashes.join('|');
}

// 현재 타임테이블 원본(공식 계측·워치 랩)을 applyOcrResults 입력 형태로
function currentRecordItems() {
  const cps = officialCheckpoints.filter(c => c.distance > 0);
  const verified = cps.map(c => ({ point: `${c.distance}km`, time: secToHms(c.timeSec), clock: c.clockStr || '', pace: c.pace, type: 'verified' }));
  const laps = rawWatchLaps.map((l, i) => ({ point: `Lap ${i + 1}`, lapNo: i + 1, time: secToLapStr(l.seconds), dist: Number(l.distance).toFixed(2), pace: l.pace, type: 'lap' }));
  return { verified, laps };
}

async function kvGet(key) {
  try {
    const db = await openPhotoDb();
    return await new Promise(resolve => {
      const r = db.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  } catch (e) { return null; }
}
async function kvSet(key, value) {
  try {
    const db = await openPhotoDb();
    const store = db.transaction('kv', 'readwrite').objectStore('kv');
    value === undefined ? store.delete(key) : store.put(value, key);
  } catch (e) { /* 저장소를 못 쓰는 환경에서는 저장 없이 동작 */ }
}

async function saveEditedRecords() {
  if (!officialCheckpoints.length) return;
  await kvSet('editedRecords', {
    photoKey: await photoSetKey(),
    ...currentRecordItems(),
    start: startTimeManual ? globalStartTimeStr : null,
    savedAt: new Date().toISOString(),
  });
  document.getElementById('btnResetEdits').hidden = false;
}

// 같은 사진 묶음으로 저장된 수정값이 있으면 적용하고 true
async function restoreEditedRecords() {
  const saved = await kvGet('editedRecords');
  if (!saved || saved.photoKey !== await photoSetKey()) return false;
  applyOcrResults(saved.verified, saved.laps, { edited: true });
  if (saved.start) {
    startTimeManual = true;
    globalStartTimeStr = saved.start;
    document.getElementById('startTimeInput').value = saved.start;
    setStartHint('직접 입력한 값');
    buildUnifiedTimeline();
  }
  setOcrReviewState('edited');
  document.getElementById('btnResetEdits').hidden = false;
  return true;
}

// 저장한 수정값을 지우고 사진에서 다시 추출 (OCR 결과는 캐시돼 있어 금방 끝남)
async function resetEditedRecords() {
  if (!await askConfirm('직접 수정한 값을 지우고 사진에서 추출한 값으로 되돌릴까요?', { okLabel: '되돌리기', danger: true })) return;
  await kvSet('editedRecords', undefined);
  document.getElementById('btnResetEdits').hidden = true;
  toggleParsedEditor(false);
  startTimeManual = false;
  if (uploadedPhotos.length) {
    await analyzeAndGoStep2();
  } else {
    officialCheckpoints.length = 0;
    rawWatchLaps.length = 0;
    buildUnifiedTimeline();
    setOcrReviewState('manual');
  }
}
