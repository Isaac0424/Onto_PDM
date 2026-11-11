// PDM 개발용 실행기: OPMS 가 먼저 켜져 있어야 하고(Neo4j 가 응답해야 한다), 그 다음 PDM 의 세 프로세스를 한 번에 띄운다.
//   1) 파일 서버(CAD DB)  2) PDM 백엔드(OPMS Neo4j 읽기 전용)  3) 웹 개발 서버
// 실행: node tools/dev-pdm.mjs          (Ctrl+C 로 셋 다 종료)
// Neo4j 접속 정보: 환경 변수 PDM_NEO4J_URI·USER·PASSWORD 가 있으면 그것을, 없으면 OPMS 저장소의 .env(NEO4J_*)를 읽기만 해서 쓴다.
// 비밀번호는 화면·파일에 출력하거나 저장하지 않는다.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const local = readEnvFile(join(root, '.env'));
const opmsHome = process.env.OPMS_HOME ?? local.OPMS_HOME ?? 'D:/ernest_hemingway_OPMS';
const opms = readEnvFile(join(opmsHome, '.env'));
const pick = (pdm, opmsKey, fallback) => process.env[pdm] ?? opms[opmsKey] ?? fallback;

const neo4j = {
  PDM_NEO4J_URI: pick('PDM_NEO4J_URI', 'NEO4J_URI', 'bolt://127.0.0.1:7687'),
  PDM_NEO4J_USER: pick('PDM_NEO4J_USER', 'NEO4J_USER', 'neo4j'),
  PDM_NEO4J_PASSWORD: pick('PDM_NEO4J_PASSWORD', 'NEO4J_PASSWORD'),
};
const apiPort = process.env.PDM_API_PORT ?? '8100';
const filesPort = process.env.FILES_PORT ?? local.FILES_PORT ?? '8788';

function say(tag, text) { for (const l of String(text).split(/\r?\n/)) if (l.trim()) console.log(`[${tag}] ${l}`); }

/** OPMS 의 Neo4j 포트가 열려 있는가 (OPMS 가 먼저 켜져 있어야 한다) */
function reachable(uri, ms = 2500) {
  const m = /^[a-z+]+:\/\/([^:/]+):?(\d+)?/.exec(uri);
  const host = m?.[1] ?? '127.0.0.1', port = Number(m?.[2] ?? 7687);
  return new Promise(res => {
    const s = net.connect({ host, port });
    const done = ok => { s.destroy(); res(ok); };
    s.setTimeout(ms, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

if (!(await reachable(neo4j.PDM_NEO4J_URI))) {
  console.error(`OPMS 의 Neo4j(${neo4j.PDM_NEO4J_URI})에 연결되지 않습니다. OPMS 를 먼저 켠 다음 다시 실행해 주세요.`);
  console.error(`  예) cd ${opmsHome} && docker compose up -d`);
  process.exit(1);
}
if (!neo4j.PDM_NEO4J_PASSWORD) {
  console.error(`Neo4j 비밀번호를 찾지 못했습니다. PDM_NEO4J_PASSWORD 를 설정하거나 ${join(opmsHome, '.env')} 의 NEO4J_PASSWORD 를 확인해 주세요.`);
  process.exit(1);
}
say('opms', `Neo4j 응답 확인 (${neo4j.PDM_NEO4J_URI})`);

const backendBin = join(root, 'backend', '.venv', isWin ? 'Scripts/onto-pdm.exe' : 'bin/onto-pdm');
if (!existsSync(backendBin)) {
  console.error(`PDM 백엔드가 설치돼 있지 않습니다: ${backendBin}\n  backend/README.md 의 설치 절차(uv sync)를 먼저 실행해 주세요.`);
  process.exit(1);
}

const jobs = [
  { tag: 'files', cmd: process.execPath, args: ['--disable-warning=ExperimentalWarning', join(root, 'server', 'files-server.mjs')], env: { FILES_PORT: filesPort } },
  { tag: 'api', cmd: backendBin, args: ['serve', '--port', apiPort], env: neo4j },
  { tag: 'web', cmd: isWin ? 'cmd.exe' : 'pnpm', args: [...(isWin ? ['/c', 'pnpm'] : []), '--dir', join(root, 'web'), 'dev'], env: { FILES_PORT: filesPort, PDM_API_PORT: apiPort } },
];

const children = [];
let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null || !c.pid) continue;
    if (isWin) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  process.exit(code);
}

for (const j of jobs) {
  const c = spawn(j.cmd, j.args, { cwd: root, env: { ...process.env, ...j.env }, windowsHide: true });
  children.push(c);
  c.stdout.on('data', d => say(j.tag, d));
  c.stderr.on('data', d => say(j.tag, d));
  c.on('error', e => { say(j.tag, `시작하지 못했습니다: ${e.message}`); stopAll(1); });
  c.on('exit', code => { if (!stopping) { say(j.tag, `종료됨 (code ${code}). 나머지도 종료합니다.`); stopAll(code ?? 1); } });
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
console.log(`\nPDM 개발 환경을 시작합니다. 웹 주소는 아래 [web] 줄의 Local 에 나옵니다(5173 이 쓰이고 있으면 다음 번호).\n백엔드 http://127.0.0.1:${apiPort}/docs · 파일 서버 http://127.0.0.1:${filesPort}\n종료: Ctrl+C\n`);
