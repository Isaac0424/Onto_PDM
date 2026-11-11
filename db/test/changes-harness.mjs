// 설계 변경 영향 분석 시험 도우미: 증분 SQL 로더와 BRK-M8 시험 픽스처.
// 픽스처는 시험 안에서 SQL 로 직접 만든다. 앱 화면에는 목 데이터가 없다(2026-11-11 사용자 지시) — 외부(ERP · MES) 행은
// 모두 source_system='fixture' 로 표시한다.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = name => fs.readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
export const CHANGES = read('changes.sql');
export const CHANGES_ROLES = read('changes-roles.sql');

export const one = async (db, sql, p) => (await db.query(sql, p)).rows[0];
export const rows = async (db, sql, p) => (await db.query(sql, p)).rows;

/** 사용자: kim(admin 1) · lee(engineer 2, 설계) · park(approver 3) · choi(engineer 4, 구매) · jung(engineer 5, 생산) */
export const USERS = { kim: 1, lee: 2, park: 3, choi: 4, jung: 5 };

export async function seedUsers(db) {
  await db.exec(`SET app.user_id = '1'`);
  await db.query(`insert into app_user(login_id,name,role) values
    ('kim','김','admin'), ('lee','이','engineer'), ('park','박','approver'), ('choi','최','engineer'), ('jung','정','engineer')`);
  await db.query(`insert into app_user_function(user_id,function) values (2,'design'), (4,'purchasing'), (5,'production')`);
}

/**
 * BRK-M8 "M8 체결 브래킷 모듈" (모두 R00 승인본)
 *   모듈 = 상판 1 + 하판 1 + 체결 세트 1
 *   체결 세트 = 육각볼트 M8x30 ×4 (P-00000000001) + 육각너트 M8 ×4 (P-00000000022) + 평와셔 M8 ×8 (P-00000000025)
 *   판은 OPMS :Part 가 없어 PDM 품목만 둔다. 후보 부품: 너트 P-…23(피치 1.0), 플랜지볼트 P-…15(M8x40).
 *   체결 구성(fastening_joint)은 볼트 · 너트 · 와셔를 BOM 으로 직접 갖는 체결 세트 개정에 붙인다
 *   (교체 때 부모 새 개정으로 BOM 과 함께 복사 · 치환되어 일관되게 유지된다).
 */
export async function seedBrk(db) {
  const S = {};
  await db.exec(`SET app.user_id = '1'`);
  S.prod = (await one(db, `insert into product(code,name) values ('BRK-M8','M8 체결 브래킷 모듈') returning id`)).id;
  const mk = async (no, name, type) =>
    (await one(db, `insert into item(item_no,name,item_type,product_id) values ($1,$2,$3,$4) returning id`, [no, name, type, S.prod])).id;
  const rev = async (item, r = 'R00', seq = 0) =>
    (await one(db, `insert into item_revision(item_id,rev,rev_seq) values ($1,$2,$3) returning id`, [item, r, seq])).id;
  const release = async id => {
    await db.query(`update item_revision set status='in_review' where id=$1`, [id]);
    await db.query(`update item_revision set status='released' where id=$1`, [id]);
  };

  S.bolt = await mk('P-00000000001', 'HexBolt M8x30', 'standard');
  S.nut = await mk('P-00000000022', 'HexNut M8 (pitch 1.25)', 'standard');
  S.nut2 = await mk('P-00000000023', 'HexNut M8 (pitch 1.0)', 'standard');
  S.washer = await mk('P-00000000025', 'FlatWasher M8', 'standard');
  S.flange = await mk('P-00000000015', 'HexFlangeBolt M8x40', 'standard');
  S.top = await mk('BRK-M8-TOP', '상판 브래킷', 'part');
  S.bot = await mk('BRK-M8-BOT', '하판 브래킷', 'part');
  S.fset = await mk('BRK-M8-FSET', '체결 세트', 'assembly');
  S.mod = await mk('BRK-M8-MOD', 'M8 체결 브래킷 모듈', 'assembly');
  await db.query(`update product set root_item_id=$1 where id=$2`, [S.mod, S.prod]);

  S.rBolt = await rev(S.bolt); S.rNut = await rev(S.nut); S.rNut2 = await rev(S.nut2);
  S.rWasher = await rev(S.washer); S.rFlange = await rev(S.flange);
  S.rTop = await rev(S.top); S.rBot = await rev(S.bot);
  await db.query(`insert into revision_spec(revision_id,key,value,unit,source) values
    ($1,'thickness',8,'mm','drawing'), ($2,'thickness',8,'mm','drawing')`, [S.rTop, S.rBot]);
  for (const r of [S.rBolt, S.rNut, S.rNut2, S.rWasher, S.rFlange, S.rTop, S.rBot]) await release(r);

  S.rFset = await rev(S.fset);
  await db.query(`insert into bom_line(parent_revision_id,child_item_id,quantity,find_no) values ($1,$2,4,1), ($1,$3,4,2), ($1,$4,8,3)`,
    [S.rFset, S.bolt, S.nut, S.washer]);
  await db.query(`insert into fastening_joint(assembly_revision_id,name,bolt_item_id,nut_item_id,washer_item_id,washers_per_bolt,bolt_count,clamped)
    values ($1,'상·하판 체결',$2,$3,$4,2,4,$5::jsonb)`,
    [S.rFset, S.bolt, S.nut, S.washer,
     JSON.stringify([{ item_id: S.top, thickness_key: 'thickness' }, { item_id: S.bot, thickness_key: 'thickness' }])]);
  await release(S.rFset);

  S.rMod = await rev(S.mod);
  await db.query(`insert into bom_line(parent_revision_id,child_item_id,quantity,find_no) values ($1,$2,1,1), ($1,$3,1,2), ($1,$4,1,3)`,
    [S.rMod, S.top, S.bot, S.fset]);
  await release(S.rMod);
  return S;
}

export const AS_OF = '2026-11-10T00:00:00Z';

/** 외부(ERP · MES) 시험 행: 작업지시 3건(완료 · 진행 중 · 미착수), 미입고 발주 1줄, 너트 재고 1로트 — 전부 source_system='fixture' */
export async function seedExternal(db) {
  const wo = (no, status, planned, done, lot, from, to) =>
    db.query(`select pub.upsert_work_order('fixture',$1,'PLANT1','BRK-M8-MOD','R00','P0',$2,$3,$4,$5,$6,$7,'2026-11-01','2026-12-01',$8) r`,
      [no, status, planned, done, lot, from, to, AS_OF]);
  await wo('WO-FX-0001', 'completed', 100, 100, 'L-100', 1, 100);
  await wo('WO-FX-0002', 'in_progress', 50, 20, 'L-101', 101, 150);
  await wo('WO-FX-0003', 'planned', 50, 0, 'L-102', 151, 200);
  for (const no of ['WO-FX-0001', 'WO-FX-0002', 'WO-FX-0003']) {
    await db.query(`select pub.upsert_work_order_bom_ref('fixture',$1,'P-00000000022','R00',4,0)`, [no]);
  }
  await db.query(`select pub.upsert_purchase_order_line('fixture','PO-FX-100',10,'P-00000000022','R00',120,0,'2026-12-15','SupplierB','PLANT1','open',$1)`, [AS_OF]);
  await db.query(`select pub.upsert_stock_lot('fixture','LT-N-01','P-00000000022','R00','PLANT1','WH1',300,0,'available',$1)`, [AS_OF]);
}

/** 수락된 요청에서 지시를 연다. 사용자는 lee(engineer). */
export async function newOrder(db, S, title) {
  await db.exec(`SET app.user_id = '2'`);
  const req = (await one(db, `insert into change_request(title,reason) values ($1,'시험') returning id`, [title])).id;
  await db.query(`update change_request set status='submitted' where id=$1`, [req]);
  await db.exec(`SET app.user_id = '3'`);
  await db.query(`update change_request set status='accepted' where id=$1`, [req]);
  await db.exec(`SET app.user_id = '2'`);
  const order = (await one(db, `insert into change_order(request_id,product_id) values ($1,$2) returning id, code`, [req, S.prod]));
  return { req, id: order.id, code: order.code };
}

/** 영향 분석 실행 한 번과 그 발견들. findings: [{kind, severity, verdict?, subject_ref?, ...}] → { run, findings: [id…] } */
export async function addRun(db, orderId, findings, opts = {}) {
  const run = (await one(db,
    `insert into impact_run(order_id,input_hash,ontology_version,temporary,external_as_of)
     values ($1,$2,'0.19.0',true,'{"work_order":"2026-11-10T00:00:00Z"}'::jsonb) returning id`,
    [orderId, opts.hash ?? `h-${Math.random()}`])).id;
  const ids = [];
  for (const f of findings) {
    const r = await one(db,
      `insert into impact_finding(run_id,kind,subject_type,subject_ref,severity,verdict,rule_id,reason_code,message,inputs,required,actual,gap,scope_class)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14) returning id`,
      [run, f.kind, f.subject_type ?? 'item', f.subject_ref ?? 'x', f.severity, f.verdict ?? null, f.rule_id ?? null,
       f.reason_code ?? null, f.message ?? null, JSON.stringify(f.inputs ?? {}), f.required ?? null, f.actual ?? null,
       f.gap ?? null, f.scope_class ?? null]);
    ids.push(r.id);
  }
  return { run, findings: ids };
}

/** 새 개정 범위 한 줄 (전체 · 즉시가 기본) */
export const GLOBAL_SCOPE = { applies: 'new' };
export async function addScope(db, targetId, s = GLOBAL_SCOPE) {
  return (await one(db,
    `insert into change_scope(target_id,effective_from,effective_to,site,lot_nos,serial_from,serial_to,applies)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [targetId, s.effective_from ?? null, s.effective_to ?? null, s.site ?? null, s.lot_nos ?? null,
     s.serial_from ?? null, s.serial_to ?? null, s.applies])).id;
}
