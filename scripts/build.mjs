// 사용법: node scripts/build.mjs <web|toss|app>
// src/ 를 dist/<target>/ 으로 복사하고 플랫폼 어댑터(js/platform.js)를 조립한다.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
const TARGETS = {
  // web은 같은 도메인의 /api 를 쓰고, toss/app은 배포된 API 서버를 가리킨다
  web: { apiBase: process.env.API_BASE ?? '', head: '<script defer src="/_vercel/insights/script.js"></script>' },
  toss: { apiBase: process.env.API_BASE ?? 'https://running-api.example.com', head: '' },
  app: { apiBase: process.env.API_BASE ?? 'https://running-api.example.com', head: '' },
};
if (!TARGETS[target]) {
  console.error('usage: node scripts/build.mjs <web|toss|app>');
  process.exit(1);
}
const { apiBase, head } = TARGETS[target];
const out = join(root, 'dist', target);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'src'), out, { recursive: true });
cpSync(join(root, 'data'), join(out, 'data'), { recursive: true });
rmSync(join(out, 'js', 'platform'), { recursive: true });

const read = (f) => readFileSync(join(root, 'src/js/platform', f), 'utf8');
const platformJs = (read('base.js') + '\n' + read(`${target}.js`))
  .replaceAll('__PLATFORM__', target)
  .replaceAll('__API_BASE__', apiBase);
writeFileSync(join(out, 'js', 'platform.js'), platformJs);

const htmlPath = join(out, 'index.html');
writeFileSync(htmlPath, readFileSync(htmlPath, 'utf8').replace('<!-- @@PLATFORM_HEAD@@ -->', head));
console.log(`built ${target} -> dist/${target} (apiBase="${apiBase}")`);
