// 웹의 목 API(web/src/api/mock)를 돌려 시드 JSON 과 패리티 고정 데이터를 만든다.
//   node backend/scripts/export_fixtures.mjs
// web/ 의 번들러(rolldown, vite 8 이 이미 쓰는 것)로 TS 를 묶어 Node 로 실행한다. 새 의존성은 없다.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, '..');
const web = path.resolve(backend, '..', 'web');

const requireFromWeb = createRequire(path.join(web, 'package.json'));
const vitePkg = requireFromWeb.resolve('vite/package.json');
const rolldown = createRequire(vitePkg)('rolldown');

const out = mkdtempSync(path.join(tmpdir(), 'onto-pdm-fixtures-'));
const file = path.join(out, 'fixtures.mjs');
await rolldown.build({
  input: path.join(here, 'fixtures.entry.ts'),
  platform: 'node',
  output: { file, format: 'esm' },
  logLevel: 'silent',
});

const run = spawnSync(process.execPath, [file], { stdio: 'inherit', env: { ...process.env, BACKEND_ROOT: backend } });
if (run.status !== 0) process.exit(run.status ?? 1);
console.log(pathToFileURL(file).href);
