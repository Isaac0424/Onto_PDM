// 테스트용 DB 연결. 기본은 PGlite(메모리 안 PostgreSQL, 설치 불필요),
// PGTEST_URL 이 있으면 실제 PostgreSQL 서버에서도 같은 테스트를 돌린다 (임시 DB를 만들고 끝나면 지운다).
//   예: PGTEST_URL=postgres://postgres@localhost:5432/postgres pnpm test   (슈퍼유저 계정)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import pg from 'pg';

pg.types.setTypeParser(20, v => Number(v));   // bigint id 를 숫자로 (PGlite 와 같게)

const read = name => fs.readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
export const SCHEMA = read('schema.sql');
export const ROLES = read('roles.sql');
export const SERVER_URL = process.env.PGTEST_URL;

/** { name, open() → { query(sql, params), exec(sql), close() } } */
export function backends() {
  const list = [{ name: 'PGlite', open: openPglite }];
  if (SERVER_URL) list.push({ name: 'PostgreSQL server', open: openServer });
  return list;
}

async function openPglite() {
  const db = new PGlite({ extensions: { pg_trgm } });
  return {
    query: (sql, params) => db.query(sql, params),
    exec: sql => db.exec(sql),
    close: () => db.close(),
  };
}

/** 서버에 임시 DB를 만들고 그 DB에 붙는다. clients() 로 연결을 더 열 수 있다 (동시성 테스트). */
export async function openServer() {
  const name = `onto_pdm_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: SERVER_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(SERVER_URL);
  url.pathname = `/${name}`;
  const opened = [];
  const connect = async () => {
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    opened.push(c);
    return c;
  };
  const main = await connect();
  return {
    query: (sql, params) => main.query(sql, params),
    exec: sql => main.query(sql),
    connect,
    async close() {
      for (const c of opened) await c.end().catch(() => {});
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}

/**
 * sql 이 실패해야 하고, 오류가 pattern 에 맞아야 한다.
 * pattern 은 "SQLSTATE 제약이름 메시지" 에 대고 본다. 서버 기본 메시지는 서버 언어(로캘)에 따라 번역되므로
 * 내장 오류는 제약 이름이나 SQLSTATE(예: 42501 권한 없음)로, 우리 트리거 오류는 한국어 메시지로 확인한다.
 */
export async function expectError(db, sql, params, pattern) {
  let text;
  try {
    await db.query(sql, params);
  } catch (e) {
    text = `${e.code ?? ''} ${e.constraint ?? ''} ${e.message}`;
  }
  if (text === undefined) throw new Error(`실패해야 하는데 성공했다: ${sql}`);
  if (!pattern.test(text)) throw new Error(`다른 오류가 났다: "${text}" (기대: ${pattern})`);
}
