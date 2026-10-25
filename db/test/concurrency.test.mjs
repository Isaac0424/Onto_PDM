// 동시 작업 경쟁 테스트 — 연결 두 개가 필요해서 실제 PostgreSQL 서버(PGTEST_URL)에서만 돈다.
// 격리 수준은 READ COMMITTED(기본값) 전제. docs/pdm-design.md 8장 참고.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SCHEMA, SERVER_URL, openServer } from './harness.mjs';

const settle = p => p.then(() => 'ok', e => `error: ${e.message}`);
const pause = ms => new Promise(r => setTimeout(r, ms));

describe('동시성 — PostgreSQL server', { skip: SERVER_URL ? false : 'PGTEST_URL 이 없어 건너뜀 (연결 두 개가 필요)' }, () => {
  let db, A, B;
  const item = async no => (await db.query(`insert into item(item_no,name) values ($1,$1) returning id`, [no])).rows[0].id;
  const rev = async (it, status = 'wip') =>
    (await db.query(`insert into item_revision(item_id,rev,rev_seq,status) values ($1,'R00',0,$2) returning id`, [it, status])).rows[0].id;

  /** A가 먼저 잡고 있는 동안 B를 실행하고, A를 커밋한 뒤 B의 결과를 돌려준다 */
  async function race(aSql, aParams, bSql, bParams) {
    await A.query('BEGIN');
    await A.query(aSql, aParams);
    await B.query('BEGIN');
    const b = settle(B.query(bSql, bParams));
    await pause(300);
    await A.query('COMMIT');
    const result = await b;
    await B.query(result === 'ok' ? 'COMMIT' : 'ROLLBACK');
    return result;
  }

  before(async () => {
    db = await openServer();
    await db.exec(SCHEMA);
    A = await db.connect();
    B = await db.connect();
  });
  after(() => db?.close());

  it('두 사람이 동시에 P→Q, Q→P 를 넣어도 순환 BOM 이 생기지 않는다', async () => {
    const P = await item('P'), Q = await item('Q');
    const rP = await rev(P), rQ = await rev(Q);
    const b = await race(`insert into bom_line(parent_revision_id,child_item_id) values ($1,$2)`, [rP, Q],
                         `insert into bom_line(parent_revision_id,child_item_id) values ($1,$2)`, [rQ, P]);
    assert.match(b, /BOM 순환/);
  });

  it('승인하는 순간 그 리비전에 BOM 줄이 끼어들지 못한다', async () => {
    const R = await item('R'), C = await item('C');
    const rR = await rev(R, 'in_review');
    const b = await race(`update item_revision set status='released' where id=$1`, [rR],
                         `insert into bom_line(parent_revision_id,child_item_id) values ($1,$2)`, [rR, C]);
    assert.match(b, /승인된 리비전/);
    assert.equal((await db.query(`select count(*)::int n from bom_line where parent_revision_id=$1`, [rR])).rows[0].n, 0);
  });

  it('BOM 에 넣는 중인 품목은 삭제되지 않는다', async () => {
    const X = await item('X'), D = await item('D');
    const rX = await rev(X);
    const b = await race(`insert into bom_line(parent_revision_id,child_item_id) values ($1,$2)`, [rX, D],
                         `update item set deleted_at=now() where id=$1`, [D]);
    assert.match(b, /BOM에서 쓰이는 품목은 삭제할 수 없습니다/);
  });

  it('삭제 중인 품목은 BOM 에 넣을 수 없다', async () => {
    const X = await item('X2'), E = await item('E');
    const rX = await rev(X);
    const b = await race(`update item set deleted_at=now() where id=$1`, [E],
                         `insert into bom_line(parent_revision_id,child_item_id) values ($1,$2)`, [rX, E]);
    assert.match(b, /삭제된 품목/);
  });

  it('덮어쓰기: xmin 버전 검사로 다른 사람의 변경을 알아챈다 (API 409)', async () => {
    const T = await item('T');
    const v = (await A.query(`select xmin::text v from item where id=$1`, [T])).rows[0].v;
    await B.query(`update item set name='B edit' where id=$1`, [T]);
    const n = (await A.query(`update item set name='A edit' where id=$1 and xmin=$2::xid`, [T, v])).rowCount;
    assert.equal(n, 0);
  });
});
