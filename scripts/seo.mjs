// 웹 빌드 전용 SEO 생성: 탭 화면별 HTML, 대회별 정적 HTML(race/<id>.html), sitemap.xml, robots.txt.
// 대회 상세는 JS 가 내용을 그리므로, JS 를 실행하지 않는 크롤러·링크 미리보기(네이버, 카카오톡 등)를 위해
// 빌드 시 대회마다 title·description·OG·JSON-LD 와 기본 정보 요약을 HTML 에 미리 넣어 둔다.
//
// 사이트 주소: SITE_URL 환경변수가 있으면 그것, 없으면 운영 도메인(https://www.marathonnote.co.kr).
// 미리보기 배포에서도 canonical 은 운영 도메인을 가리켜 검색엔진이 운영 주소만 색인하게 한다.
// 검색엔진 소유 확인: GOOGLE_SITE_VERIFICATION, NAVER_SITE_VERIFICATION 환경변수 값을 홈에 meta 로 넣는다.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SITE_URL = 'https://www.marathonnote.co.kr';
const SITE_NAME = 'MarathonNote';
const SITE_NAME_KO = '마라톤노트';
// og:site_name 처럼 한 번만 쓰는 곳은 두 이름을 함께 ('마라톤노트'로 검색해도 사이트가 연결되도록)
const SITE_NAME_FULL = `${SITE_NAME_KO} ${SITE_NAME}`;
const DEFAULT_IMAGE = 'assets/icon-512.png';

// 탭 화면: 같은 index.html 을 쓰되 화면마다 title·description·canonical 을 다르게 만든다
const VIEWS = {
  home: {
    file: 'index.html', path: '/',
    title: '마라톤노트 MarathonNote - 마라톤 일정·주로영상 찾기',
    description: '마라톤노트에서 접수중인 마라톤 대회 일정을 한눈에 보고, 레이스 기록으로 유튜브 주로영상 속 내 모습을 찾아보세요.',
  },
  calendar: {
    file: 'calendar.html', path: '/calendar',
    title: '마라톤 대회 일정 캘린더 - MarathonNote',
    description: '전국 마라톤 대회 일정과 접수 기간, 종목, 참가비를 월별 캘린더로 확인하세요.',
  },
  converter: {
    file: 'converter.html', path: '/converter',
    title: '레이스 기록으로 주로영상 속 내 모습 찾기 - MarathonNote',
    description: '스마트칩 기록이나 워치 랩 사진으로 지점별 통과 시각을 계산해 유튜브 주로영상 속 내 모습을 클립으로 받으세요.',
  },
  pace: {
    file: 'pace.html', path: '/pace',
    title: '마라톤 페이스 계산기 - 서브4·구간표 | MarathonNote',
    description: '목표 기록으로 1km 페이스와 구간별 통과 시각표를, 달린 기록으로 하프·풀코스 예상 기록을 계산하세요.',
  },
};

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// <script> 안에 넣는 JSON: </script> 로 끊기지 않게
const jsonLd = obj => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

export function siteUrl() {
  return (process.env.SITE_URL || SITE_URL).replace(/\/+$/, '');
}

function verificationTags() {
  const { GOOGLE_SITE_VERIFICATION: google, NAVER_SITE_VERIFICATION: naver } = process.env;
  return [
    google && `<meta name="google-site-verification" content="${esc(google)}">`,
    naver && `<meta name="naver-site-verification" content="${esc(naver)}">`,
  ].filter(Boolean).join('\n  ');
}

function headTags({ site, path, title, description, image, type = 'website' }) {
  const abs = p => site + (p.startsWith('/') ? p : '/' + p);
  const img = /^https?:\/\//.test(image) ? image : abs(image);
  return [
    `<meta name="description" content="${esc(description)}">`,
    `<link rel="canonical" href="${esc(abs(path))}">`,
    `<meta property="og:type" content="${type}">`,
    `<meta property="og:site_name" content="${SITE_NAME_FULL}">`,
    `<meta property="og:locale" content="ko_KR">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(abs(path))}">`,
    `<meta property="og:image" content="${esc(img)}">`,
    `<meta name="application-name" content="${SITE_NAME_KO}">`,
    `<meta name="apple-mobile-web-app-title" content="${SITE_NAME_KO}">`,
    `<meta name="twitter:card" content="${image !== DEFAULT_IMAGE ? 'summary_large_image' : 'summary'}">`,
  ].filter(Boolean).join('\n  ');
}

const setTitle = (html, title) => html.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
const addHead = (html, tags) => html.replace('</head>', `  ${tags}\n</head>`);

function dateLabel(d) {
  const [y, m, day] = d.split('-').map(Number);
  return `${y}년 ${m}월 ${day}일(${WEEKDAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()]})`;
}

function raceDescription(r) {
  // 네이버 권장(설명 80자 이내)에 맞추려 장소는 지역명만 쓴다(상세 장소는 본문에 있음)
  const parts = [`${dateLabel(r.date)} ${r.region || ''} ${r.name}.`];
  if (r.distances?.length) parts.push(`종목 ${r.distances.join('·')}.`);
  parts.push('참가비·접수 일정·날씨·주로영상 확인.');
  return parts.join(' ').replace(/\s+/g, ' ');
}

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// 접수 상태 → Offer.availability (빌드 시점 기준, 날짜는 KST)
function offerAvailability(reg) {
  const today = kstToday();
  if (reg.closed || (reg.closesAt && reg.closesAt < today)) return 'https://schema.org/SoldOut';
  if (reg.opensAt && reg.opensAt > today) return 'https://schema.org/PreOrder';
  return 'https://schema.org/InStock';
}

function raceJsonLd(r, site) {
  const url = `${site}/race/${encodeURIComponent(r.id)}`;
  const reg = r.registration || {};
  const availability = offerAvailability(reg);
  const fees = (r.fees || []).filter(f => Number.isFinite(f.fee));
  const geo = r.coords && r.coords.precision !== 'region'
    ? { '@type': 'GeoCoordinates', latitude: r.coords.lat, longitude: r.coords.lon } : undefined;
  return {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: r.name,
    ...(r.nameEn && { alternateName: r.nameEn }),
    startDate: r.date,
    endDate: r.date, // 대회는 하루 행사
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    eventStatus: 'https://schema.org/EventScheduled',
    sport: 'Marathon',
    description: raceDescription(r),
    url,
    ...((r.poster || r.image) && { image: [r.poster || `${site}/${r.image}`] }),
    location: {
      '@type': 'Place',
      name: r.venue || r.location || r.region,
      address: { '@type': 'PostalAddress', streetAddress: r.location, addressRegion: r.region, addressCountry: 'KR' },
      ...(geo && { geo }),
    },
    // 주최 단체 데이터가 없어 대회 공식(접수) 사이트를 주최 측으로 둔다 (없으면 이름만)
    organizer: { '@type': 'Organization', name: r.name, ...(reg.url && { url: reg.url }) },
    // 참가비 미정(null)은 빼고, 무료(0)는 가격 0 으로 둔다
    ...(fees.length && {
      offers: fees.map(f => ({
        '@type': 'Offer', name: f.category, price: f.fee, priceCurrency: 'KRW', availability,
        url: reg.url || url,
        // 접수 시작일을 모르면 추정값 대신 비워 둔다 (구글 'validFrom 누락'은 심각하지 않은 경고)
        ...(reg.opensAt && { validFrom: reg.opensAt }),
      })),
    }),
  };
}

// JS 가 #page 를 그리기 전까지(그리고 JS 를 실행하지 않는 크롤러에게) 보이는 기본 정보
function raceSummaryHtml(r) {
  const fees = (r.fees || []).filter(f => f.fee).map(f => `${esc(f.category)} ${f.fee.toLocaleString('ko-KR')}원`).join(', ');
  const reg = r.registration || {};
  return `<div class="card"><h1>${esc(r.name)}</h1>
    <p>📅 ${esc(dateLabel(r.date))} · 📍 ${esc(r.location || r.region || '')}</p>
    ${r.distances?.length ? `<p>종목: ${esc(r.distances.join(', '))}</p>` : ''}
    ${fees ? `<p>참가비: ${fees}</p>` : ''}
    ${reg.opensAt || reg.closesAt ? `<p>접수: ${esc(reg.opensAt || '')} ~ ${esc(reg.closesAt || '')}</p>` : ''}
    <div class="empty">대회 정보를 불러오는 중...</div></div>`;
}

// 페이스 계산기의 자주 묻는 질문(<details><summary>질문</summary><p>답</p>)을 FAQPage 로
function faqLd(html) {
  const text = s => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const faq = html.slice(html.indexOf('id="view-pace"'));
  const items = [...faq.matchAll(/<details><summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p><\/details>/g)];
  return {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: items.map(([, q, a]) => ({ '@type': 'Question', name: text(q), acceptedAnswer: { '@type': 'Answer', text: text(a) } })),
  };
}


// ── 크롤링용 정적 링크 ──
// 캘린더는 JS 로 '이번 달'만 그려서, 지난 달·다음 달 대회는 페이지 어디에서도 링크되지 않는다
// (구글이 '발견됨 - 현재 색인이 생성되지 않음'으로 미뤄 둠). 빌드 시 <a href> 를 HTML 에 직접 넣는다.
const raceHref = r => `/race/${encodeURIComponent(r.id)}`;
const raceLi = r => `<li><a href="${raceHref(r)}">${esc(r.name)}</a> <span>${r.date.slice(5).replace('-', '.')}${r.region ? ` · ${esc(r.region)}` : ''}</span></li>`;

// 캘린더 아래 '월별 전체 대회' (최근 달이 위, 모두 접어 둠 — 링크는 접혀 있어도 크롤러가 읽는다)
function raceArchiveHtml(races) {
  const byMonth = new Map();
  for (const r of [...races].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name))) {
    const m = r.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }
  const months = [...byMonth.keys()].sort().reverse();
  const sections = months.map(m => {
    const [y, mo] = m.split('-').map(Number);
    return `<details><summary>${y}년 ${mo}월 마라톤 대회 (${byMonth.get(m).length})</summary><ul>${byMonth.get(m).map(raceLi).join('')}</ul></details>`;
  }).join('\n      ');
  return `<section class="cal-archive" aria-label="월별 전체 대회">
      <h2>월별 전체 마라톤 대회</h2>
      ${sections}
    </section>`;
}

// 대회 상세 아래 '같은 지역 대회'·'비슷한 시기 대회' (각 6개, 날짜가 가까운 순)
function relatedRacesHtml(r, races) {
  const dist = x => Math.abs(Date.parse(x.date) - Date.parse(r.date));
  const others = races.filter(x => x.id !== r.id).sort((a, b) => dist(a) - dist(b) || a.date.localeCompare(b.date));
  const region = r.region ? others.filter(x => x.region === r.region).slice(0, 6) : [];
  const shown = new Set(region.map(x => x.id));
  const nearby = others.filter(x => !shown.has(x.id)).slice(0, 6);
  const block = (title, list) => list.length
    ? `<h2>${title}</h2><ul>${[...list].sort((a, b) => a.date.localeCompare(b.date)).map(raceLi).join('')}</ul>` : '';
  return `<nav class="card related" aria-label="다른 마라톤 대회">
    ${block(`${esc(r.region)} 지역 다른 대회`, region)}
    ${block('비슷한 시기 대회', nearby)}
    <p><a href="/calendar">전체 마라톤 일정 캘린더 보기 ›</a></p>
  </nav>`;
}

export function generateSeo(out) {
  const site = siteUrl();

  const racesDir = join(out, 'data', 'calendar', 'races');
  const races = readdirSync(racesDir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(racesDir, f), 'utf8')))
    .filter(r => r.id && /^\d{4}-\d{2}-\d{2}$/.test(r.date || ''));

  // 1) 탭 화면별 HTML (캘린더 화면 아래에 월별 전체 대회 링크를 넣어 둔다)
  const calListTag = '<div class="cal-list" id="calList"></div>';
  const indexSrc = readFileSync(join(out, 'index.html'), 'utf8');
  if (!indexSrc.includes(calListTag)) throw new Error('SEO: index.html 에 #calList 가 없어 대회 링크를 넣지 못했습니다');
  const indexHtml = indexSrc.replace(calListTag, `${calListTag}\n    ${raceArchiveHtml(races)}`);
  // 구글은 검색 결과의 사이트 이름을 정할 때 WebSite 의 name·alternateName 을 참고한다
  const homeLd = jsonLd({
    '@context': 'https://schema.org', '@type': 'WebSite',
    name: SITE_NAME_KO, alternateName: [SITE_NAME, 'marathonnote', 'Marathon Note', '마라톤 노트'],
    inLanguage: 'ko', url: site + '/',
  });
  const verify = verificationTags();
  for (const v of Object.values(VIEWS)) {
    let html = addHead(setTitle(indexHtml, v.title), headTags({ site, path: v.path, title: v.title, description: v.description, image: DEFAULT_IMAGE }));
    if (v.file === 'index.html') html = addHead(html, [homeLd, verify].filter(Boolean).join('\n  '));
    if (v.file === 'pace.html') html = addHead(html, jsonLd(faqLd(html)));
    writeFileSync(join(out, v.file), html);
  }

  // 2) 대회별 정적 HTML
  const raceTpl = readFileSync(join(out, 'race.html'), 'utf8');
  mkdirSync(join(out, 'race'), { recursive: true });
  for (const r of races) {
    // 네이버 권장(제목 40자 이내): 넘치면 브랜드명 접미사를 뺀다
    const base = `${r.name} (${r.date})`;
    const title = `${base} - ${SITE_NAME}`.length <= 40 ? `${base} - ${SITE_NAME}` : base;
    const tags = headTags({
      site, path: `/race/${encodeURIComponent(r.id)}`, title, description: raceDescription(r),
      image: r.image || r.poster || DEFAULT_IMAGE, type: 'article',
    });
    const html = addHead(setTitle(raceTpl, title), `${tags}\n  ${jsonLd(raceJsonLd(r, site))}`)
      .replace('<div id="page"><div class="empty">대회 정보를 불러오는 중...</div></div>',
        `<div id="page">${raceSummaryHtml(r)}</div>\n  ${relatedRacesHtml(r, races)}`);
    writeFileSync(join(out, 'race', `${r.id}.html`), html);
  }

  // 3) robots.txt, sitemap.xml
  writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${site}/sitemap.xml\n`);
  const urls = [
    ...Object.values(VIEWS).map(v => ({ loc: site + v.path })),
    ...races.map(r => ({ loc: `${site}/race/${encodeURIComponent(r.id)}`, lastmod: (r.generatedAt || '').slice(0, 10) })),
  ];
  const body = urls.map(u => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n');
  writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
  console.log(`SEO: views ${Object.keys(VIEWS).length}, races ${races.length} (site="${site}")`);
}
