// db/changes.sql · db/changes-roles.sql 시험: 설계 변경 영향 분석의 DB 층.
//   BRK-M8(M8 체결 브래킷 모듈)을 SQL 로 직접 만들고(changes-harness.mjs, source_system='fixture'),
//   SC-1(너트 교체) · SC-2(상판 두께, 부분 적용 범위) · SC-3(개정 vs 교체)를 DB 수준에서 확인한다.
//   영향 분석 계산(짝 · 그립 길이)은 앱(백엔드 changes/ 엔진)의 일이다. 여기서는 그 결과 행(impact_run · impact_finding)을
//   시험이 직접 넣고, DB 가 승인 · 불변 · 가드 · 권한을 지키는지만 본다.
// 하나의 시나리오를 순서대로 진행한다 (앞 단계의 데이터를 뒤 단계가 쓴다).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ROLES, SCHEMA, SERVER_URL, backends, expectError, openServer } from './harness.mjs';
import {
  AS_OF, CHANGES, CHANGES_ROLES, USERS, addRun, addScope, newOrder, one, rows, seedBrk, seedExternal, seedUsers,
} from './changes-harness.mjs';

/** 실패한 문장의 메시지를 돌려준다 (성공하면 던진다) */
async function errorText(db, sql, params) {
  try {
    await db.query(sql, params);
  } catch (e) {
    return e.message;
  }
  throw new Error(`실패해야 하는데 성공했다: ${sql}`);
}

const asUser = async (db, id) => db.exec(`SET app.user_id = '${id}'`);

for (const backend of backends()) {
  describe(`changes.sql — ${backend.name}`, () => {
    let db;
    let S;
    const q = (sql, p) => one(db, sql, p);

    const approve = (order, user = USERS.park) => db.query(`select approve_change_order($1,$2)`, [order, user]);
    const review = async (order, fn, run, user, verdict = 'approve') => {
      await asUser(db, user);
      return q(`insert into change_review(order_id,function,run_id,verdict) values ($1,$2,$3,$4) returning id`, [order, fn, run, verdict]);
    };
    const toReview = async order => {
      await asUser(db, USERS.lee);
      await db.query(`update change_order set status='in_review' where id=$1`, [order]);
    };
    const fsetRevs = () => rows(db, `select id, rev, status from item_revision where item_id=$1 order by rev_seq`, [S.fset]);
    const outboxCount = (order) =>
      q(`select count(*)::int n from outbox where aggregate='change_order' and aggregate_id=$1 and event='approved'`, [order]).then(r => r.n);

    before(async () => {
      db = await backend.open();
      await db.exec(SCHEMA);
      await db.exec(CHANGES);
      await seedUsers(db);
      S = await seedBrk(db);
      await seedExternal(db);
    });
    after(() => db?.close());

    it('증분 파일은 여러 번 적용해도 멱등이고 outbox 제약은 하나다', async () => {
      const snap = () => q(`select
        (select count(*) from pg_trigger where not tgisinternal)::int triggers,
        (select count(*) from pg_constraint where connamespace = 'public'::regnamespace)::int constraints,
        (select count(*) from pg_proc where pronamespace in ('public'::regnamespace, 'pub'::regnamespace))::int functions,
        (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','S','i'))::int rels`);
      const before = await snap();
      await db.exec(CHANGES);
      await db.exec(CHANGES);
      assert.deepEqual(await snap(), before);
      const ob = await rows(db, `select pg_get_constraintdef(oid) d from pg_constraint where conrelid='outbox'::regclass and contype='c'`);
      assert.equal(ob.length, 1);
      assert.match(ob[0].d, /change_order/);
      // 기존 동작은 그대로: 승인된 BOM 과 where_used
      assert.ok((await rows(db, `select * from where_used($1)`, [S.nut])).some(r => r.parent_item_id === S.fset));
      assert.equal((await q(`select effective_revision($1,'released') r`, [S.fset])).r, S.rFset);
    });

    it('외부 입구: 낡은 값은 무시하고, 등록 안 된 품번은 거부하며, 전부 fixture 로 표시된다', async () => {
      const old = await q(`select pub.upsert_stock_lot('fixture','LT-N-01','P-00000000022','R00','PLANT1','WH1',999,0,'available','2026-11-01T00:00:00Z') r`);
      assert.equal(old.r, false, 'as_of 가 더 이른 값은 반영하지 않는다');
      assert.equal(Number((await q(`select qty_on_hand q from stock_lot where lot_no='LT-N-01'`)).q), 300);
      await expectError(db, `select pub.upsert_stock_lot('fixture','LT-X','P-NOPE','R00','PLANT1','WH1',1,0,'available',$1)`, [AS_OF], /등록되지 않은 품번/);
      await expectError(db, `select pub.upsert_work_order('fixture','WO-X','PLANT1','BRK-M8-MOD','R99','P0','planned',1,0,null,null,null,null,null,$1)`, [AS_OF], /등록되지 않은 개정/);
      await expectError(db, `insert into stock_lot(source_system,lot_no,item_id,site,qty_on_hand,as_of) values ('SAP','L',$1,'P',1,now())`, [S.nut], /^23514 /);
      await expectError(db, `insert into inventory_balance(item_id,source_system,site,qty_on_hand,unit,as_of) values ($1,'fixture','P',1,'EA',now())`, [S.nut], /^23514 /);   // inventory_balance 는 그대로
      for (const t of ['work_order', 'purchase_order_line', 'stock_lot']) {
        const src = (await rows(db, `select distinct source_system s from ${t}`)).map(r => r.s);
        assert.deepEqual(src, ['fixture'], t);
      }
      assert.equal((await q(`select count(*)::int n from work_order`)).n, 3);
      assert.equal((await q(`select count(*)::int n from work_order_bom_ref`)).n, 3);
    });

    it('요청 · 지시 상태: 수락된 요청에서만 지시를 열고, 반려 · 되돌림에는 사유가 필요하다', async () => {
      await asUser(db, USERS.lee);
      const req = (await q(`insert into change_request(title,reason) values ('상태 시험','시험') returning id`)).id;
      await expectError(db, `update change_request set status='accepted' where id=$1`, [req], /CHANGE_STATE_INVALID/);
      await expectError(db, `insert into change_order(request_id,product_id) values ($1,$2)`, [req, S.prod], /CHANGE_STATE_INVALID/);
      await expectError(db, `insert into change_request(title,reason,origin) values ('x','x','ontology_impact')`, [], /change_request_origin_ck/);
      await db.query(`update change_request set status='withdrawn' where id=$1`, [req]);
      await expectError(db, `update change_request set title='바꿈' where id=$1`, [req], /CHANGE_STATE_INVALID/);

      const O = await newOrder(db, S, '사유 시험');
      await expectError(db, `update change_order set status='in_review' where id=$1`, [O.id], /TARGET_REQUIRED/);
      const t = (await q(`insert into change_target(order_id,kind,item_id,parent_revision_id,new_quantity) values ($1,'bom_line',$2,$3,10) returning id`, [O.id, S.washer, S.rFset])).id;
      await expectError(db, `update change_order set status='in_review' where id=$1`, [O.id], /SCOPE_REQUIRED/);
      await addScope(db, t);
      await expectError(db, `update change_order set status='in_review' where id=$1`, [O.id], /IMPACT_NOT_COMPUTED/);
      await addRun(db, O.id, [{ kind: 'bom_usage', severity: 'none' }]);
      await toReview(O.id);
      await expectError(db, `update change_order set status='draft' where id=$1`, [O.id], /REASON_REQUIRED/);
      await expectError(db, `update change_order set status='approved' where id=$1`, [O.id], /approve_change_order\(\) 로만/);
      await db.query(`update change_order set status='cancelled' where id=$1`, [O.id]);
      await expectError(db, `update change_order set status_note='x' where id=$1`, [O.id], /CHANGE_LOCKED/);
    });

    it('SC-1 너트 교체: blocked(짝 불일치)는 승인할 수 없고, 분석을 고쳐 처분 · 검토를 마치면 새 개정으로 승인된다', async () => {
      const O = await newOrder(db, S, 'SC-1 너트 P-…22 → P-…23');
      S.o1 = O.id;
      S.t1 = (await q(`insert into change_target(order_id,kind,item_id,replacement_item_id,parent_revision_id)
                       values ($1,'replacement',$2,$3,$4) returning id`, [O.id, S.nut, S.nut2, S.rFset])).id;
      await addScope(db, S.t1);   // 전체 · 즉시

      const run1 = await addRun(db, O.id, [
        { kind: 'fit_pair', severity: 'blocked', verdict: 'no', rule_id: 'bolt_nut', reason_code: 'mismatch', message: '피치가 다릅니다(1.25 ↔ 1.0)', subject_ref: `${S.bolt}:${S.nut2}` },
        { kind: 'work_order', severity: 'affected', subject_type: 'work_order', subject_ref: 'fixture:WO-FX-0002', scope_class: 'inside' },
      ]);
      await toReview(O.id);
      assert.match(await errorText(db, `select approve_change_order($1,$2)`, [O.id, USERS.park]), /BLOCKED_FINDINGS/);
      // blocked 는 위험 수용으로 닫을 수 없다
      await expectError(db, `insert into change_disposition(order_id,finding_id,action,reason) values ($1,$2,'accept_risk','x')`, [O.id, run1.findings[0]], /DISPOSITION_INVALID/);

      // 분석을 고쳐 다시 돌린다 (피치가 맞는 구성으로 바꿨다고 가정. 계산은 앱의 일). 이전 분석은 이력으로 남는다
      const run2 = await addRun(db, O.id, [
        { kind: 'fit_pair', severity: 'none', verdict: 'ok', rule_id: 'bolt_nut', subject_ref: `${S.bolt}:${S.nut2}` },
        { kind: 'fit_grip', severity: 'none', verdict: 'ok', rule_id: 'grip_length', required: 28.5, actual: 30, gap: -1.5 },
        { kind: 'bom_usage', severity: 'none', subject_ref: `${S.mod}` },
        { kind: 'work_order', severity: 'affected', subject_type: 'work_order', subject_ref: 'fixture:WO-FX-0002', scope_class: 'inside' },
        { kind: 'work_order', severity: 'affected', subject_type: 'work_order', subject_ref: 'fixture:WO-FX-0003', scope_class: 'inside' },
        { kind: 'purchase_order_line', severity: 'affected', subject_type: 'purchase_order_line', subject_ref: 'fixture:PO-FX-100/10' },
        { kind: 'stock_lot', severity: 'affected', subject_type: 'stock_lot', subject_ref: 'fixture:LT-N-01' },
      ]);
      const [, , , wo2, wo3, po, stock] = run2.findings;
      assert.equal((await q(`select count(*)::int n from impact_run where order_id=$1`, [O.id])).n, 2);

      // 처분: 최신 분석의 발견에만, 종류에 맞는 선택지로
      await expectError(db, `insert into change_disposition(order_id,finding_id,action,reason) values ($1,$2,'change_in_progress','옛 분석')`, [O.id, run1.findings[1]], /IMPACT_STALE/);
      const msg = await errorText(db, `select approve_change_order($1,$2)`, [O.id, USERS.park]);
      assert.match(msg, /DISPOSITION_REQUIRED/);
      for (const id of [wo2, wo3, po, stock]) assert.ok(msg.includes(String(id)), `처분 없는 발견 ${id} 가 메시지에 있다`);
      await expectError(db, `insert into change_disposition(order_id,finding_id,action,reason) values ($1,$2,'amend','x')`, [O.id, wo2], /DISPOSITION_INVALID/);
      await expectError(db, `insert into change_disposition(order_id,finding_id,action,reason) values ($1,$2,'no_action_needed','x')`, [O.id, wo2], /DISPOSITION_INVALID/);
      await asUser(db, USERS.lee);
      await db.query(`insert into change_disposition(order_id,finding_id,action,reason) values
        ($1,$2,'change_in_progress','진행 중 작업은 별도 검토 후 변경'), ($1,$3,'apply_new','미착수는 새 개정 적용'),
        ($1,$4,'amend','발주 사양 정정 요청'), ($1,$5,'quarantine','재고 격리 후 결정')`, [O.id, wo2, wo3, po, stock]);

      // 검토: 필요한 기능(design + 작업지시 → production + 발주 · 재고 → purchasing)이 최신 분석을 보고 approve
      assert.match(await errorText(db, `select approve_change_order($1,$2)`, [O.id, USERS.park]), /REVIEW_REQUIRED.*design.*purchasing.*production/);
      await asUser(db, USERS.park);
      await expectError(db, `insert into change_review(order_id,function,run_id,verdict) values ($1,'design',$2,'approve')`, [O.id, run2.run], /FORBIDDEN/);   // 자격 없음
      await asUser(db, USERS.lee);
      await expectError(db, `insert into change_review(order_id,function,run_id,verdict) values ($1,'design',$2,'approve')`, [O.id, run1.run], /IMPACT_STALE/);   // 옛 분석
      await review(O.id, 'design', run2.run, USERS.lee);
      await review(O.id, 'purchasing', run2.run, USERS.choi);
      assert.match(await errorText(db, `select approve_change_order($1,$2)`, [O.id, USERS.park]), /REVIEW_REQUIRED.*production/);
      await review(O.id, 'production', run2.run, USERS.jung, 'comment');   // comment 는 승인이 아니다
      assert.match(await errorText(db, `select approve_change_order($1,$2)`, [O.id, USERS.park]), /REVIEW_REQUIRED.*production/);
      await review(O.id, 'production', run2.run, USERS.jung);

      // 승인 권한: 엔지니어는 못 한다
      await expectError(db, `select approve_change_order($1,$2)`, [O.id, USERS.lee], /권한이 없습니다/);
      assert.equal((await fsetRevs()).length, 1, '아직 새 개정은 없다');

      await approve(O.id);

      const o = await q(`select status, approved_by, approved_run_id from change_order where id=$1`, [O.id]);
      assert.equal(o.status, 'implemented');
      assert.equal(o.approved_by, USERS.park);
      assert.equal(o.approved_run_id, run2.run, '승인 때 본 분석이 남는다');
      const revs = await fsetRevs();
      assert.deepEqual(revs.map(r => [r.rev, r.status]), [['R00', 'obsolete'], ['R01', 'released']], '범위가 전체라 이전 개정은 폐기');
      S.rFset1 = revs[1].id;
      const bom = await rows(db, `select child_item_id, quantity from bom_line where parent_revision_id=$1 order by find_no`, [S.rFset1]);
      assert.deepEqual(bom.map(b => [b.child_item_id, Number(b.quantity)]), [[S.bolt, 4], [S.nut2, 4], [S.washer, 8]], '너트만 바뀌고 수량은 그대로');
      const joint = await q(`select nut_item_id, bolt_item_id, washers_per_bolt from fastening_joint where assembly_revision_id=$1`, [S.rFset1]);
      assert.deepEqual(joint, { nut_item_id: S.nut2, bolt_item_id: S.bolt, washers_per_bolt: 2 }, '체결 구성도 새 개정으로 복사 · 치환');
      assert.equal((await q(`select to_revision_id r from change_target where id=$1`, [S.t1])).r, S.rFset1);
      assert.equal(await outboxCount(O.id), 1, 'outbox 에 change_order 승인이 한 건');
      assert.ok((await q(`select count(*)::int n from outbox where aggregate='item_revision' and aggregate_id=$1 and event='released'`, [S.rFset1])).n >= 1);
      assert.ok((await q(`select count(*)::int n from audit_log where table_name='change_order' and row_id=$1 and changed_by=$2`, [O.id, USERS.park])).n >= 1, '승인자가 감사 로그에 남는다');
      assert.ok((await q(`select count(*)::int n from audit_log where table_name='change_target' and row_id=$1`, [S.t1])).n >= 2, '대상 등록 · 새 개정 기록');
      assert.equal((await q(`select effective_revision($1,'released') r`, [S.fset])).r, S.rFset1);
      assert.equal((await q(`select effective_revision_at($1) r`, [S.fset])).r, S.rFset1);
      assert.equal((await rows(db, `select * from where_used($1)`, [S.nut])).length, 0, '옛 너트를 쓰는 승인 BOM 은 없다');
      const wu = await rows(db, `select depth, parent_item_id from where_used($1) order by depth`, [S.nut2]);
      assert.deepEqual(wu.map(r => [r.depth, r.parent_item_id]), [[1, S.fset], [2, S.mod]]);

      // 승인 뒤: 하위 행 · 지시는 잠긴다. 승인본은 계속 불변이다
      await asUser(db, USERS.lee);
      await expectError(db, `insert into change_scope(target_id,applies) values ($1,'old')`, [S.t1], /CHANGE_LOCKED/);
      await expectError(db, `update change_target set note='바꿈' where id=$1`, [S.t1], /CHANGE_LOCKED/);
      await expectError(db, `update change_disposition set reason='바꿈' where order_id=$1`, [O.id], /CHANGE_LOCKED/);
      await expectError(db, `delete from change_review where order_id=$1`, [O.id], /CHANGE_LOCKED/);
      await expectError(db, `insert into impact_run(order_id,input_hash) values ($1,'x')`, [O.id], /CHANGE_LOCKED/);
      await expectError(db, `insert into change_disposition(order_id,finding_id,action,reason) values ($1,$2,'acknowledge','x')`, [O.id, run2.findings[2]], /CHANGE_STATE_INVALID|CHANGE_LOCKED/);
      await expectError(db, `update change_order set status='approved' where id=$1`, [O.id], /CHANGE_STATE_INVALID/);
      await expectError(db, `update change_order set status_note='x' where id=$1`, [O.id], /CHANGE_LOCKED/);
      await expectError(db, `delete from change_order where id=$1`, [O.id], /CHANGE_STATE_INVALID/);
      assert.match(await errorText(db, `select approve_change_order($1,$2)`, [O.id, USERS.park]), /CHANGE_STATE_INVALID/);
      await expectError(db, `update item_revision set description='바꿈' where id=$1`, [S.rFset1], /승인된 리비전은 수정할 수 없습니다/);
      await expectError(db, `insert into revision_spec(revision_id,key,value,source) values ($1,'x',1,'manual')`, [S.rFset1], /승인된 리비전/);
      await expectError(db, `update bom_line set quantity=9 where parent_revision_id=$1`, [S.rFset1], /승인된 리비전/);
    });

    it('승인은 원자적이다: 중간에 실패하면 새 개정 · BOM · outbox · 지시 상태가 모두 되돌아간다', async () => {
      // 새 개정을 올릴 때 하위 품목(P-UNREL)이 승인된 적이 없어 guard_release_children 이 막는다 — 새 개정과 BOM 줄을 만든 뒤에 실패한다
      await asUser(db, USERS.kim);
      S.unrel = (await q(`insert into item(item_no,name,item_type,product_id) values ('P-UNREL','미승인 와셔','standard',$1) returning id`, [S.prod])).id;
      await db.query(`insert into item_revision(item_id,rev,rev_seq) values ($1,'R00',0)`, [S.unrel]);

      const O = await newOrder(db, S, '원자성 시험');
      const t = (await q(`insert into change_target(order_id,kind,item_id,replacement_item_id,parent_revision_id) values ($1,'replacement',$2,$3,$4) returning id`,
        [O.id, S.washer, S.unrel, S.rFset1])).id;
      await addScope(db, t);
      const run = await addRun(db, O.id, [{ kind: 'bom_usage', severity: 'none' }]);
      await toReview(O.id);
      await review(O.id, 'design', run.run, USERS.lee);

      const count = () => q(`select
        (select count(*)::int from item_revision) revs, (select count(*)::int from bom_line) bom,
        (select count(*)::int from fastening_joint) joints, (select count(*)::int from outbox) outbox,
        (select count(*)::int from audit_log) audit`);
      const before = await count();
      assert.match(await errorText(db, `select approve_change_order($1,$2)`, [O.id, USERS.park]), /하위 품목이 아직 승인되지 않아.*P-UNREL/);
      assert.deepEqual(await count(), before, '한 건도 남지 않는다 (감사 로그 포함)');
      assert.equal((await q(`select status from change_order where id=$1`, [O.id])).status, 'in_review');
      assert.equal((await q(`select to_revision_id r from change_target where id=$1`, [t])).r, null);
      assert.equal((await fsetRevs()).length, 2);
      assert.equal(await outboxCount(O.id), 0);
      await db.query(`update change_order set status='cancelled' where id=$1`, [O.id]);
    });

    it('SC-2 상판 두께 8 → 12: 필요 길이 32.5 > 30 이면 막히고, 부분 범위(일련번호 ≥ 120)로 승인하면 두 개정이 함께 유효하다', async () => {
      const O = await newOrder(db, S, 'SC-2 상판 두께 8 → 12');
      await asUser(db, USERS.lee);
      S.rTop1 = (await q(`insert into item_revision(item_id,rev,rev_seq) values ($1,'R01',1) returning id`, [S.top])).id;
      await db.query(`insert into revision_spec(revision_id,key,value,unit,source) values ($1,'thickness',12,'mm','drawing')`, [S.rTop1]);
      const t = (await q(`insert into change_target(order_id,kind,item_id,from_revision_id,to_revision_id) values ($1,'revision',$2,$3,$4) returning id`,
        [O.id, S.top, S.rTop, S.rTop1])).id;
      await expectError(db, `update change_order set status='in_review' where id=$1`, [O.id], /SCOPE_REQUIRED/);

      // 적용 범위: 일련번호 120 이상은 새 개정, 119 이하는 기존 개정을 계속 쓴다. 새 범위끼리 겹치면 거부
      await addScope(db, t, { applies: 'new', serial_from: 120 });
      await addScope(db, t, { applies: 'old', serial_to: 119 });
      await expectError(db, `insert into change_scope(target_id,serial_from,serial_to,applies) values ($1,150,200,'new')`, [t], /SCOPE_OVERLAP/);
      await expectError(db, `insert into change_scope(target_id,serial_from,serial_to,applies) values ($1,10,5,'new')`, [t], /change_scope_serials_ck/);
      await expectError(db, `insert into change_scope(target_id,effective_from,effective_to,applies) values ($1,'2026-12-31','2026-01-01','new')`, [t], /change_scope_dates_ck/);
      // 사업장이 다르고 로트가 겹치지 않으면 겹침이 아니다
      await db.query(`insert into change_scope(target_id,serial_from,serial_to,site,lot_nos,applies) values ($1,0,10,'PLANT2',array['L-1'],'new')`, [t]);
      await db.query(`delete from change_scope where target_id=$1 and site='PLANT2'`, [t]);

      await expectError(db, `update change_order set status='in_review' where id=$1`, [O.id], /IMPACT_NOT_COMPUTED/);
      const run1 = await addRun(db, O.id, [
        { kind: 'fit_grip', severity: 'blocked', verdict: 'no', rule_id: 'grip_length', reason_code: 'shortfall', required: 32.5, actual: 30, gap: 2.5,
          inputs: { plates: [12, 8], washers: '2×1.6', nutHeight: 6.8, pitch: 1.25, boltLength: 30 } },
      ]);
      await toReview(O.id);
      assert.match(await errorText(db, `select approve_change_order($1,$2)`, [O.id, USERS.park]), /BLOCKED_FINDINGS/);

      // 볼트를 바꾸는 후속 지시로 풀기로 하고 분석을 다시 돌린다 (review 수준으로 내려옴)
      const run2 = await addRun(db, O.id, [
        { kind: 'fit_grip', severity: 'review', verdict: 'conditional', rule_id: 'grip_length', subject_ref: 'candidate:P-00000000015' },
        { kind: 'work_order', severity: 'affected', subject_type: 'work_order', subject_ref: 'fixture:WO-FX-0002', scope_class: 'partial' },
        { kind: 'work_order', severity: 'affected', subject_type: 'work_order', subject_ref: 'fixture:WO-FX-0003', scope_class: 'inside' },
        { kind: 'work_order', severity: 'none', subject_type: 'work_order', subject_ref: 'fixture:WO-FX-0001', scope_class: 'outside' },
      ]);
      const [grip, wo2, wo3] = run2.findings;
      await asUser(db, USERS.lee);
      await db.query(`insert into change_disposition(order_id,finding_id,action,reason) values
        ($1,$2,'accept_risk','후보 볼트 교체를 별도 지시로 처리'), ($1,$3,'change_in_progress','일련번호 구간이 120 경계를 걸침'), ($1,$4,'apply_new','미착수')`,
        [O.id, grip, wo2, wo3]);
      await review(O.id, 'design', run2.run, USERS.lee);
      await review(O.id, 'production', run2.run, USERS.jung);   // 구매 검토는 발주 · 재고 영향이 없어 필요 없다
      await approve(O.id);

      const revs = await rows(db, `select id, rev, status from item_revision where item_id=$1 order by rev_seq`, [S.top]);
      assert.deepEqual(revs.map(r => [r.rev, r.status]), [['R00', 'released'], ['R01', 'released']], '부분 범위라 이전 개정은 폐기되지 않는다');
      const at = async serial => (await q(`select effective_revision_at($1, null, null, $2) r`, [S.top, serial])).r;
      assert.equal(await at(150), S.rTop1, '일련번호 150 → 새 개정');
      assert.equal(await at(120), S.rTop1);
      assert.equal(await at(100), S.rTop, '일련번호 100 → 기존 개정');
      assert.equal(await at(null), S.rTop, '일련번호를 모르면 보수적으로 기존 개정');
      assert.equal((await q(`select effective_revision($1,'released') r`, [S.top])).r, S.rTop1, '기존 effective_revision 은 범위를 무시한 최신(동작 유지)');
      assert.equal(await outboxCount(O.id), 1);
      assert.equal(Number((await q(`select value v from revision_spec where revision_id=$1 and key='thickness'`, [S.rTop1])).v), 12);
      S.o2 = O.id;
    });

    it('SC-3 개정 vs 교체: 규격이 바뀌는 개정은 거부하고 교체로 등록하게 한다. 같은 품번의 공차 개정은 된다', async () => {
      const O = await newOrder(db, S, 'SC-3 볼트 길이 30 → 40');
      await asUser(db, USERS.lee);
      S.rBolt1 = (await q(`insert into item_revision(item_id,rev,rev_seq) values ($1,'R01',1) returning id`, [S.bolt])).id;

      // (a) 길이 40 으로 '개정' → 거부 (사양이 먼저 있는 경로 · 대상이 먼저 있는 경로 둘 다)
      await db.query(`insert into revision_spec(revision_id,key,value,unit,source) values ($1,'length',40,'mm','drawing')`, [S.rBolt1]);
      await expectError(db, `insert into change_target(order_id,kind,item_id,from_revision_id,to_revision_id) values ($1,'revision',$2,$3,$4)`,
        [O.id, S.bolt, S.rBolt, S.rBolt1], /REVISION_CHANGES_IDENTITY.*length/);
      await db.query(`delete from revision_spec where revision_id=$1`, [S.rBolt1]);
      await q(`insert into change_target(order_id,kind,item_id,from_revision_id,to_revision_id) values ($1,'revision',$2,$3,$4) returning id`,
        [O.id, S.bolt, S.rBolt, S.rBolt1]);
      await expectError(db, `insert into revision_spec(revision_id,key,value,unit,source) values ($1,'length',40,'mm','drawing')`, [S.rBolt1], /REVISION_CHANGES_IDENTITY/);
      await expectError(db, `insert into revision_spec(revision_id,key,value,unit,source) values ($1,'pitch',1.5,'mm','drawing')`, [S.rBolt1], /REVISION_CHANGES_IDENTITY/);
      // (c) 같은 품번 안의 값(공차)은 개정으로 된다
      await db.query(`insert into revision_spec(revision_id,key,value,unit,source) values ($1,'tolerance',0.05,'mm','drawing')`, [S.rBolt1]);

      // (b) 같은 변경을 P-…15(M8x40 플랜지)로 '교체' 등록하면 된다
      await q(`insert into change_target(order_id,kind,item_id,replacement_item_id,parent_revision_id) values ($1,'replacement',$2,$3,$4) returning id`,
        [O.id, S.bolt, S.flange, S.rFset1]);

      // 대상 검증
      await expectError(db, `insert into change_target(order_id,kind,item_id,replacement_item_id,parent_revision_id) values ($1,'replacement',$2,$3,$4)`,
        [O.id, S.top, S.flange, S.rFset1], /TARGET_NOT_IN_BOM/);
      await expectError(db, `insert into change_target(order_id,kind,item_id,replacement_item_id,parent_revision_id) values ($1,'replacement',$2,$3,$4)`,
        [O.id, S.washer, S.flange, S.rFset], /TARGET_NOT_RELEASED/);   // R00 은 폐기됨
      await expectError(db, `insert into change_target(order_id,kind,item_id,replacement_item_id,parent_revision_id) values ($1,'replacement',$2,$2,$3)`,
        [O.id, S.washer, S.rFset1], /change_target_kind_ck/);
      await expectError(db, `insert into change_target(order_id,kind,item_id,parent_revision_id) values ($1,'ontology',$2,$3)`, [O.id, S.washer, S.rFset1], /^23514 /);   // 온톨로지 종류는 없다
      await db.query(`update change_order set status='cancelled' where id=$1`, [O.id]);

      // F-CHG-10: 온톨로지 변경 보고는 보고일 뿐 개정 · 지시를 만들지 않는다
      const n = () => q(`select (select count(*)::int from item_revision) revs, (select count(*)::int from change_order) orders, (select count(*)::int from change_target) targets`);
      const before = await n();
      const imp = (await q(`insert into ontology_impact(from_version,to_version,summary) values ('0.18.0','0.19.0','{"rules_changed":["bolt_length_vs_hole_depth"],"parts_flagged":[]}'::jsonb) returning id`)).id;
      assert.deepEqual(await n(), before);
      const req = (await q(`insert into change_request(title,reason,origin,ontology_impact_id) values ('온톨로지 0.19.0 영향','보고에서 열림','ontology_impact',$1) returning id`, [imp])).id;
      assert.ok(req > 0);
      assert.deepEqual((await n()).revs, before.revs, '요청을 열어도 부품 개정은 생기지 않는다');
    });

    it('낡음(stale): 외부 feed · 입력 변경이 최신 분석을 낡게 하고, 낡은 분석으로는 승인할 수 없다 (줄 수량 변경 대상)', async () => {
      const O = await newOrder(db, S, '와셔 수량 8 → 10');
      const t = (await q(`insert into change_target(order_id,kind,item_id,parent_revision_id,new_quantity) values ($1,'bom_line',$2,$3,10) returning id`, [O.id, S.washer, S.rFset1])).id;
      await addScope(db, t);
      const run1 = await addRun(db, O.id, [{ kind: 'bom_usage', severity: 'none' }]);
      await toReview(O.id);
      await review(O.id, 'design', run1.run, USERS.lee);
      assert.equal((await q(`select stale from impact_run where id=$1`, [run1.run])).stale, false);

      // 더 새로운 as_of 재고가 들어오면 낡은 분석이 된다
      assert.equal((await q(`select pub.upsert_stock_lot('fixture','LT-N-01','P-00000000022','R00','PLANT1','WH1',250,0,'available','2026-11-11T00:00:00Z') r`)).r, true);
      const st = await q(`select stale, stale_reasons from impact_run where id=$1`, [run1.run]);
      assert.equal(st.stale, true);
      assert.deepEqual(st.stale_reasons, ['external_feed:stock_lot']);
      assert.match(await errorText(db, `select approve_change_order($1,$2)`, [O.id, USERS.park]), /IMPACT_STALE/);
      await expectError(db, `insert into change_review(order_id,function,run_id,verdict) values ($1,'design',$2,'approve')`, [O.id, run1.run], /IMPACT_STALE/);

      // 다시 분석하면 풀린다. 검토도 새 분석을 보고 다시 한다
      const run2 = await addRun(db, O.id, [{ kind: 'bom_usage', severity: 'none' }]);
      assert.match(await errorText(db, `select approve_change_order($1,$2)`, [O.id, USERS.park]), /REVIEW_REQUIRED.*design/);
      await review(O.id, 'design', run2.run, USERS.lee);
      // 대상을 고치면 다시 낡아진다
      await asUser(db, USERS.lee);
      await db.query(`update change_target set note='메모' where id=$1`, [t]);
      assert.deepEqual((await q(`select stale_reasons from impact_run where id=$1`, [run2.run])).stale_reasons, ['target_changed']);
      const run3 = await addRun(db, O.id, [{ kind: 'bom_usage', severity: 'none' }]);
      await review(O.id, 'design', run3.run, USERS.lee);
      await approve(O.id);

      const revs = await fsetRevs();
      assert.deepEqual(revs.map(r => [r.rev, r.status]), [['R00', 'obsolete'], ['R01', 'obsolete'], ['R02', 'released']]);
      const bom = await rows(db, `select child_item_id, quantity from bom_line where parent_revision_id=$1 order by find_no`, [revs[2].id]);
      assert.deepEqual(bom.map(b => [b.child_item_id, Number(b.quantity)]), [[S.bolt, 4], [S.nut2, 4], [S.washer, 10]]);
      // 승인된 지시의 승인 당시 분석은 그 뒤 입력이 바뀌어도 낡음으로 바뀌지 않는다
      await db.query(`select pub.upsert_stock_lot('fixture','LT-N-01','P-00000000022','R00','PLANT1','WH1',200,0,'available','2026-11-12T00:00:00Z')`);
      assert.equal((await q(`select stale from impact_run where id=$1`, [run3.run])).stale, false);
      assert.equal(await outboxCount(O.id), 1);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// 권한: 역할마다 따로 접속하는 대신 슈퍼유저 연결에서 SET ROLE 로 바꿔 확인한다 (roles.test.mjs 와 같은 방식).
// roles.sql 이 서버 전체에 역할을 만들므로 PGlite 에서만 돌린다.
// ---------------------------------------------------------------------------------------------
describe('changes-roles.sql — PGlite', () => {
  const DENIED = /^(42501|42P01|42883) /;   // 권한 없음 · (스키마 사용 권한이 없어) 테이블 · 함수가 안 보임
  let db;
  let S;
  const as = role => ({
    async query(sql, params) {
      await db.exec(`SET ROLE ${role}`);
      try {
        return await db.query(sql, params);
      } finally {
        await db.exec('RESET ROLE');
      }
    },
  });
  const feed = as('change_feed');
  const app = as('pdm_app');
  const erp = as('erp_reader');
  const publisher = as('graph_publisher');

  before(async () => {
    [db] = await Promise.all([backends()[0].open()]);
    await db.exec(SCHEMA);
    await db.exec(CHANGES);
    await db.exec(ROLES);
    await db.exec(CHANGES_ROLES);
    await db.exec(CHANGES_ROLES);   // 여러 번 실행해도 된다
    await seedUsers(db);
    S = await seedBrk(db);
    await seedExternal(db);
  });
  after(() => db?.close());

  it('change_feed: 입구 함수만 실행하고, 어떤 표도 읽거나 쓰지 못한다', async () => {
    const r = await feed.query(`select pub.upsert_stock_lot('fixture','LT-N-02','P-00000000022','R00','PLANT1','WH2',10,0,'available',$1) r`, [AS_OF]);
    assert.equal(r.rows[0].r, true);
    const w = await feed.query(`select pub.upsert_work_order('fixture','WO-FX-0009','PLANT1','BRK-M8-MOD','R00','P0','planned',5,0,'L-9',201,205,null,null,$1) r`, [AS_OF]);
    assert.equal(w.rows[0].r, true);
    assert.equal((await feed.query(`select pub.upsert_work_order_bom_ref('fixture','WO-FX-0009','P-00000000022','R00',4,0) r`)).rows[0].r, true);
    assert.equal((await feed.query(`select pub.upsert_purchase_order_line('fixture','PO-FX-200',10,'P-00000000022','R00',10,0,null,'S','PLANT1','open',$1) r`, [AS_OF])).rows[0].r, true);
    await expectError(feed, `select * from stock_lot`, [], DENIED);
    await expectError(feed, `insert into stock_lot(source_system,lot_no,item_id,site,qty_on_hand,as_of) values ('fixture','L',$1,'P',1,now())`, [S.nut], DENIED);
    await expectError(feed, `select * from change_order`, [], DENIED);
    await expectError(feed, `select approve_change_order(1,3)`, [], DENIED);
    await expectError(feed, `select pub.upsert_inventory('P-00000000022','ERP','P1','',1,0,'EA',now())`, [], DENIED);
  });

  it('erp_reader · graph_publisher: 승인을 실행하지 못하고, 발행기는 지시를 읽기만 한다', async () => {
    await expectError(erp, `select approve_change_order(1,3)`, [], DENIED);
    await expectError(erp, `select * from change_order`, [], DENIED);
    await expectError(erp, `select pub.upsert_stock_lot('fixture','L','P-00000000022','R00','P','',1,0,'available',now())`, [], DENIED);
    assert.equal((await publisher.query(`select count(*)::int n from change_order`)).rows[0].n, 0);
    await expectError(publisher, `insert into change_request(title,reason) values ('x','x')`, [], DENIED);
    await expectError(publisher, `select * from work_order`, [], DENIED);
  });

  it('pdm_app: 변경 표는 쓰고, 외부 사본은 읽기만 하며, 한 번의 흐름(요청 → 낡음 → 재분석 → 승인)이 권한만으로 돈다', async () => {
    assert.ok((await app.query(`select count(*)::int n from work_order`)).rows[0].n >= 3);
    await expectError(app, `insert into work_order(source_system,wo_no,status,as_of) values ('fixture','X','planned',now())`, [], DENIED);
    await expectError(app, `update stock_lot set qty_on_hand=0`, [], DENIED);
    await expectError(app, `select pub.upsert_stock_lot('fixture','L','P-00000000022','R00','P','',1,0,'available',now())`, [], DENIED);
    await expectError(app, `delete from audit_log`, [], DENIED);
    assert.match((await app.query(`select approve_change_order(999999, 3)`).catch(e => ({ message: e.message }))).message ?? '', /CHANGE_NOT_FOUND/);

    await asUser(db, USERS.lee);
    const req = (await app.query(`insert into change_request(title,reason) values ('권한 흐름','시험') returning id, code`)).rows[0];
    assert.match(req.code, /^CR-\d{4}-\d{4}$/);
    await app.query(`update change_request set status='submitted' where id=$1`, [req.id]);
    await asUser(db, USERS.park);
    await app.query(`update change_request set status='accepted' where id=$1`, [req.id]);
    await asUser(db, USERS.lee);
    const order = (await app.query(`insert into change_order(request_id,product_id) values ($1,$2) returning id, code`, [req.id, S.prod])).rows[0];
    assert.match(order.code, /^CO-\d{4}-\d{4}$/);
    const t = (await app.query(`insert into change_target(order_id,kind,item_id,parent_revision_id,new_quantity) values ($1,'bom_line',$2,$3,12) returning id`, [order.id, S.washer, S.rFset])).rows[0].id;
    await app.query(`insert into change_scope(target_id,applies) values ($1,'new')`, [t]);
    const run1 = (await app.query(`insert into impact_run(order_id,input_hash) values ($1,'h1') returning id`, [order.id])).rows[0].id;
    await app.query(`insert into impact_finding(run_id,kind,subject_type,subject_ref,severity) values ($1,'bom_usage','item','x','none')`, [run1]);
    await app.query(`update change_order set status='in_review' where id=$1`, [order.id]);

    // 외부 입구가 더 새로운 값을 넣으면 (definer 함수 → 트리거) 최신 분석이 낡아진다
    await feed.query(`select pub.upsert_stock_lot('fixture','LT-N-02','P-00000000022','R00','PLANT1','WH2',5,0,'available','2026-11-12T00:00:00Z')`);
    assert.equal((await app.query(`select stale from impact_run where id=$1`, [run1])).rows[0].stale, true);
    await expectError(app, `select approve_change_order($1,$2)`, [order.id, USERS.park], /IMPACT_STALE/);

    const run2 = (await app.query(`insert into impact_run(order_id,input_hash) values ($1,'h2') returning id`, [order.id])).rows[0].id;
    await app.query(`insert into change_review(order_id,function,run_id,verdict) values ($1,'design',$2,'approve')`, [order.id, run2]);
    await app.query(`select approve_change_order($1,$2)`, [order.id, USERS.park]);
    assert.equal((await app.query(`select status from change_order where id=$1`, [order.id])).rows[0].status, 'implemented');
    assert.equal((await publisher.query(`select count(*)::int n from change_order where status='implemented'`)).rows[0].n, 1);
    const jobs = (await publisher.query(`select id from outbox where aggregate='change_order' and published_at is null for update skip locked`)).rows;
    assert.equal(jobs.length, 1, '발행기가 가져갈 change_order 승인이 한 건');
    await publisher.query(`update outbox set published_at=now() where id=$1`, [jobs[0].id]);
    await expectError(app, `delete from audit_log`, [], DENIED);
    assert.ok((await db.query(`select count(*)::int n from audit_log where table_name='change_order' and changed_by=$1`, [USERS.park])).rows[0].n >= 1);
  });
});

// ---------------------------------------------------------------------------------------------
// 동시성: 연결 두 개가 필요해서 실제 PostgreSQL 서버(PGTEST_URL)에서만 돈다. 격리 수준은 READ COMMITTED 전제.
// ---------------------------------------------------------------------------------------------
const settle = p => p.then(() => 'ok', e => `error: ${e.message}`);
const pause = ms => new Promise(r => setTimeout(r, ms));

describe('변경 승인 동시성 — PostgreSQL server', { skip: SERVER_URL ? false : 'PGTEST_URL 이 없어 건너뜀 (연결 두 개가 필요)' }, () => {
  let db, A, B, S;

  /** A 가 먼저 잡고 있는 동안 B 를 실행하고, A 를 커밋한 뒤 B 의 결과를 돌려준다 */
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
  const ready = async (title, qty) => {
    const O = await newOrder(db, S, title);
    const cur = (await one(db, `select id from item_revision where item_id=$1 and status='released' order by rev_seq desc limit 1`, [S.fset])).id;
    const t = (await one(db, `insert into change_target(order_id,kind,item_id,parent_revision_id,new_quantity) values ($1,'bom_line',$2,$3,$4) returning id`, [O.id, S.washer, cur, qty])).id;
    await addScope(db, t);
    const run = await addRun(db, O.id, [{ kind: 'bom_usage', severity: 'none' }]);
    await asUser(db, USERS.lee);
    await db.query(`update change_order set status='in_review' where id=$1`, [O.id]);
    await db.query(`insert into change_review(order_id,function,run_id,verdict) values ($1,'design',$2,'approve')`, [O.id, run.run]);
    return { order: O.id, target: t };
  };

  before(async () => {
    db = await openServer();
    await db.exec(SCHEMA);
    await db.exec(CHANGES);
    await seedUsers(db);
    S = await seedBrk(db);
    A = await db.connect();
    B = await db.connect();
  });
  after(() => db?.close());

  it('두 승인자가 같은 지시를 동시에 승인해도 한 건만 성공하고 새 개정은 하나뿐이다', async () => {
    const { order } = await ready('동시 승인', 10);
    const b = await race(`select approve_change_order($1,$2)`, [order, USERS.park], `select approve_change_order($1,$2)`, [order, USERS.kim]);
    assert.match(b, /CHANGE_STATE_INVALID/);
    const revs = await rows(db, `select rev, status from item_revision where item_id=$1 order by rev_seq`, [S.fset]);
    assert.deepEqual(revs.map(r => [r.rev, r.status]), [['R00', 'obsolete'], ['R01', 'released']]);
    assert.equal((await one(db, `select count(*)::int n from outbox where aggregate='change_order' and aggregate_id=$1`, [order])).n, 1);
  });

  it('승인하는 순간 그 지시에 범위 · 처분이 끼어들지 못한다', async () => {
    const { order, target } = await ready('승인 중 끼어들기', 12);
    const b = await race(`select approve_change_order($1,$2)`, [order, USERS.park],
                         `insert into change_scope(target_id,applies) values ($1,'old')`, [target]);
    assert.match(b, /CHANGE_LOCKED/);
    assert.equal((await one(db, `select count(*)::int n from change_scope where target_id=$1`, [target])).n, 1);
  });
});
