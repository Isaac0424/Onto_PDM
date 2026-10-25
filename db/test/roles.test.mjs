// db/roles.sql 공개 범위 · 권한 테스트.
// 역할마다 따로 접속하는 대신 슈퍼유저 연결에서 SET ROLE 로 역할을 바꿔 확인한다
// (권한 · 행 단위 제한은 현재 역할 기준으로 적용되므로 결과가 같고, 역할 비밀번호가 필요 없다).
// 서버에서 돌리면 roles.sql 의 역할이 서버 전체에 만들어진다. 테스트용 서버에서만 돌린다.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ROLES, SCHEMA, backends, expectError } from './harness.mjs';

const DENIED = /^(42501|42P01) /;   // 권한 없음 · (스키마 사용 권한이 없어) 테이블이 안 보임

for (const backend of backends()) {
  describe(`roles.sql — ${backend.name}`, () => {
    let db;
    let shaftNo;
    /** 이 역할로 한 문장 실행 */
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
    const erp = as('erp_reader');
    const feed = as('inventory_feed');
    const agent = as('class_agent');
    const app = as('pdm_app');
    const publisher = as('graph_publisher');

    before(async () => {
      db = await backend.open();
      await db.exec(SCHEMA);
      await db.exec(ROLES);
      await db.exec(`SET app.user_id = '1'`);
      await db.query(`insert into app_user(login_id,name,role) values ('kim','김','admin'), ('lee','이','engineer')`);
      // 승인된 품목 하나, 작업중 품목 하나, PDM · AGENT 임시저장 하나씩
      const req = (await db.query(`insert into part_request(source_system,status,payload) values ('PDM','submitted','{"name":"Shaft","class_iri":"cls:Shaft"}') returning id`)).rows[0].id;
      const shaft = (await db.query(`select approve_part_request($1) id`, [req])).rows[0].id;
      await db.query(`update item_revision set status='in_review' where item_id=$1`, [shaft]);
      await db.query(`update item_revision set status='released' where item_id=$1`, [shaft]);
      const req2 = (await db.query(`insert into part_request(source_system,status,payload) values ('PDM','submitted','{"name":"Cover","class_iri":"cls:Cover"}') returning id`)).rows[0].id;
      await db.query(`select approve_part_request($1)`, [req2]);
      await db.query(`insert into part_request(source_system,payload) values ('PDM','{"name":"내 임시저장"}')`);
      await db.query(`insert into part_request(source_system,payload) values ('AGENT','{"name":"에이전트 임시저장"}')`);
      shaftNo = (await db.query(`select item_no from item where id=$1`, [shaft])).rows[0].item_no;
    });
    after(() => db?.close());

    it('ERP · MES: pub 의 승인본만 보고, 내부 테이블과 임시저장은 못 본다', async () => {
      await expectError(erp, `select * from item`, [], DENIED);
      await expectError(erp, `select * from part_request`, [], DENIED);
      const parts = (await erp.query(`select item_no from pub.part`)).rows.map(r => r.item_no);
      assert.deepEqual(parts, [shaftNo], '작업중 품목(Cover)은 보이지 않는다');
      await expectError(erp, `select pub.upsert_inventory($1,'ERP','P1','',1,0,'EA',now())`, [shaftNo], DENIED);
    });

    it('재고 연동: 입구 함수만 실행할 수 있다', async () => {
      await feed.query(`select pub.upsert_inventory($1,'ERP','P1','WH',5,0,'EA',now())`, [shaftNo]);
      await expectError(feed, `select * from pub.part`, [], DENIED);
      assert.equal((await erp.query(`select qty_on_hand from pub.inventory where item_no=$1`, [shaftNo])).rows.length, 1);
    });

    it('분류 에이전트: 자기 임시저장과 제안만 만들고, 제출 · 승인 · 품번 발급은 못 한다', async () => {
      await agent.query(`insert into part_request(source_system,payload) values ('AGENT','{"name":"Self tapping screw"}')`);
      await expectError(agent, `insert into part_request(source_system,status,payload) values ('AGENT','submitted','{"name":"x"}')`, [], DENIED);
      await expectError(agent, `insert into part_request(source_system,payload) values ('PDM','{}')`, [], DENIED);
      const seen = (await agent.query(`select source_system from part_request`)).rows.map(r => r.source_system);
      assert.deepEqual(seen, ['AGENT', 'AGENT'], '다른 시스템의 임시저장은 보이지 않는다');

      await agent.query(`insert into class_proposal(parent_class_iri,label_ko,definition,evidence) values ('cls:Fastener','셀프태핑 나사','정의','[{"doc_chunk_id":1}]')`);
      await expectError(agent, `insert into class_proposal(status,approved_iri,parent_class_iri,label_ko,definition,evidence) values ('approved','cls:X','cls:Fastener','x','x','[{"a":1}]')`, [], DENIED);
      await expectError(agent, `update class_proposal set status='approved', approved_iri='cls:Y'`, [], DENIED);
      await expectError(agent, `select approve_part_request(1)`, [], DENIED);
      assert.equal((await agent.query(`select item_no, class_iri from item`)).rows.length, 2);
      await expectError(agent, `select created_by from item`, [], DENIED);
    });

    it('PDM · PLM API 서버: 관리자 모드 사용자만 품번을 발급하고, 감사 로그는 못 고친다', async () => {
      await app.query(`set app.user_id = '1'`);
      const r3 = (await app.query(`insert into part_request(source_system,status,payload) values ('PLM','submitted','{"name":"Pin","class_iri":"cls:Pin"}') returning id`)).rows[0].id;
      assert.ok((await app.query(`select approve_part_request($1) id`, [r3])).rows[0].id > 0);
      assert.equal((await app.query(`select count(*)::int n from part_request where status='draft'`)).rows[0].n, 3, '임시저장 전부 (PDM + AGENT)');

      await app.query(`set app.user_id = '2'`);
      const r4 = (await app.query(`insert into part_request(source_system,status,payload) values ('PLM','submitted','{"name":"Key","class_iri":"cls:Key"}') returning id`)).rows[0].id;
      await expectError(app, `select approve_part_request($1)`, [r4], /권한이 없습니다/);
      await app.query(`set app.user_id = '1'`);

      await expectError(app, `delete from audit_log`, [], DENIED);
      assert.ok((await app.query(`select count(*)::int n from audit_log where table_name='part_request'`)).rows[0].n > 0);
    });

    it('그래프 발행기: outbox 를 가져가 발행 표시만 하고, 공개 안 된 BOM 은 못 읽는다', async () => {
      const jobs = (await publisher.query(`select id from outbox where published_at is null order by id limit 5 for update skip locked`)).rows;
      assert.ok(jobs.length > 0);
      await publisher.query(`update outbox set published_at=now() where id=$1`, [jobs[0].id]);
      await expectError(publisher, `select * from bom_line`, [], DENIED);
    });
  });
}
