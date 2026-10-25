// db/schema.sql 기능 테스트: BOM · 리비전 잠금 · 매칭 · 문서 · 등록 요청 · 공개 뷰 · 재고 · outbox · 품번 변경.
// 하나의 시나리오를 순서대로 진행한다 (앞 단계의 데이터를 뒤 단계가 쓴다).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SCHEMA, backends, expectError } from './harness.mjs';

for (const backend of backends()) {
  describe(`schema.sql — ${backend.name}`, () => {
    let db;
    const one = async (sql, p) => (await db.query(sql, p)).rows[0];
    const rows = async (sql, p) => (await db.query(sql, p)).rows;
    const S = {};   // 단계 사이에 넘기는 id

    before(async () => {
      db = await backend.open();
      await db.exec(SCHEMA);
      await db.exec(`SET app.user_id = '1'`);
      await db.query(`insert into app_user(login_id,name,role) values ('kim','김','admin'), ('lee','이','engineer')`);
      S.prod = (await one(`insert into product(code,name) values ('HCR3A','협동로봇') returning id`)).id;
      S.mk = async (no, name, type) =>
        (await one(`insert into item(item_no,name,item_type,product_id) values ($1,$2,$3,$4) returning id`, [no, name, type, S.prod])).id;
      S.rev = async (item, r, seq) =>
        (await one(`insert into item_revision(item_id,rev,rev_seq) values ($1,$2,$3) returning id`, [item, r, seq])).id;
    });
    after(() => db?.close());

    it('BOM: 순환 · 자기 참조 · 열린 리비전 둘을 막고, 정전개 총수량을 곱한다', async () => {
      S.robot = await S.mk('HCR3A-ASM', 'HCR3A', 'assembly');
      S.body = await S.mk('Body_HCR3A', 'Body', 'assembly');
      S.bolt = await S.mk('M3x8', 'Bolt M3x8', 'standard');
      S.rRobot = await S.rev(S.robot, 'R00', 0);
      S.rBody = await S.rev(S.body, 'R00', 0);
      S.rBolt = await S.rev(S.bolt, 'R00', 0);
      await db.query(`insert into bom_line(parent_revision_id,child_item_id,quantity,find_no) values ($1,$2,1,1),($1,$3,4,2)`, [S.rRobot, S.body, S.bolt]);
      await db.query(`insert into bom_line(parent_revision_id,child_item_id,quantity,find_no) values ($1,$2,2,1)`, [S.rBody, S.bolt]);

      await expectError(db, `insert into bom_line(parent_revision_id,child_item_id) values ($1,$2)`, [S.rBody, S.robot], /BOM 순환/);
      await expectError(db, `insert into bom_line(parent_revision_id,child_item_id) values ($1,$2)`, [S.rRobot, S.robot], /BOM 순환/);
      await expectError(db, `insert into item_revision(item_id,rev,rev_seq) values ($1,'R01',1)`, [S.body], /item_revision_one_open/);

      const ex = await rows(`select depth, child_item_id, total_quantity from bom_explode($1,'latest')`, [S.rRobot]);
      assert.equal(ex.length, 3);
      assert.equal(Number(ex.find(r => r.depth === 2 && r.child_item_id === S.bolt).total_quantity), 2);
    });

    it('리비전: 상태 순서, 하위 먼저 승인, 승인 뒤 잠금', async () => {
      await expectError(db, `update item_revision set status='released' where id=$1`, [S.rBody], /허용되지 않는 상태 변경/);
      await db.query(`update item_revision set status='in_review' where id=$1`, [S.rBody]);
      await expectError(db, `update item_revision set status='released' where id=$1`, [S.rBody], /하위 품목이 아직 승인되지 않아/);
      await db.query(`update item_revision set status='in_review' where id=$1`, [S.rBolt]);
      await db.query(`update item_revision set status='released' where id=$1`, [S.rBolt]);
      await db.query(`update item_revision set status='released' where id=$1`, [S.rBody]);

      const rel = await one(`select released_at, released_by from item_revision where id=$1`, [S.rBody]);
      assert.ok(rel.released_at, 'released_at 자동 기록');
      assert.equal(rel.released_by, 1, 'released_by = app.user_id');

      const nut = await S.mk('NUT', 'Nut M3', 'standard');
      await expectError(db, `update item_revision set description='x' where id=$1`, [S.rBody], /승인된 리비전은 수정할 수 없습니다/);
      await expectError(db, `insert into bom_line(parent_revision_id,child_item_id) values ($1,$2)`, [S.rBody, nut], /승인된 리비전\(item_revision/);
      await expectError(db, `update bom_line set quantity=3 where parent_revision_id=$1`, [S.rBody], /승인된 리비전\(item_revision/);
      await expectError(db, `delete from item_revision where id=$1`, [S.rBody], /작업중\(wip\) 리비전만 삭제/);
      await expectError(db, `delete from item where id=$1`, [S.body], /작업중\(wip\) 리비전만 삭제/);
    });

    it('조회 규칙: effective_revision · where_used (폐기 제외)', async () => {
      S.rBody1 = await S.rev(S.body, 'R01', 1);
      assert.equal((await one(`select effective_revision($1,'released') r`, [S.body])).r, S.rBody);
      assert.equal((await one(`select effective_revision($1,'latest') r`, [S.body])).r, S.rBody1);
      await db.query(`update item_revision set status='obsolete' where id=$1`, [S.rBody]);
      const wu = await rows(`select * from where_used($1)`, [S.bolt]);
      assert.ok(wu.some(r => r.parent_item_id === S.robot));
      assert.ok(!wu.some(r => r.parent_revision_id === S.rBody), '폐기된 Body R00 은 사용처에서 빠진다');
    });

    it('매칭: 정규화 일치 · 유사도', async () => {
      const cand = await rows(`select * from match_item_candidates('body-hcr3a')`);
      assert.equal(cand[0].item_id, S.body);
      assert.equal(cand[0].method, 'normalized');
      const fz = await rows(`select * from match_item_candidates('Bolt M3x10')`);
      assert.equal(fz[0].item_id, S.bolt);
      assert.equal(fz[0].method, 'fuzzy');
    });

    it('문서: 다른 문서의 리비전 연결 금지, 승인 문서의 주 파일 잠금, 파생 파일 · 해석 결과는 허용', async () => {
      S.doc = (await one(`insert into document(doc_no,title,doc_type) values ('SPEC-HCR3A','HCR3A 사양서','spec') returning id`)).id;
      const doc2 = (await one(`insert into document(doc_no,title,doc_type) values ('CAD-BODY','Body 3D','cad_3d') returning id`)).id;
      const dr = (await one(`insert into document_revision(document_id,rev,rev_seq) values ($1,'R00',0) returning id`, [S.doc])).id;
      const dr2 = (await one(`insert into document_revision(document_id,rev,rev_seq) values ($1,'R00',0) returning id`, [doc2])).id;
      const fo = (await one(`insert into file_object(sha256,size_bytes,storage_key) values (repeat('a',64),10,'aa/aa/x') returning id`)).id;
      S.df = (await one(`insert into document_file(document_revision_id,file_object_id,file_name,file_format) values ($1,$2,'spec.pdf','pdf') returning id`, [dr, fo])).id;

      await expectError(db, `insert into item_document_link(item_revision_id,document_id,document_revision_id,link_type) values ($1,$2,$3,'cad_model')`,
        [S.rBody1, S.doc, dr2], /item_document_link_document_revision_id_document_id_fkey/);
      await db.query(`insert into item_document_link(item_revision_id,document_id,link_type,is_primary) values ($1,$2,'spec',true)`, [S.rBody1, S.doc]);

      await db.query(`update document_revision set status='in_review' where id=$1`, [dr]);
      await db.query(`update document_revision set status='released' where id=$1`, [dr]);
      await expectError(db, `update document_file set file_object_id=$1 where id=$2`, [fo, S.df], /승인된 리비전\(document_revision/);
      await db.query(`update document_file set parse_status='done', analysis='{"chunks":1}' where id=$1`, [S.df]);
      await db.query(`insert into document_file(document_revision_id,file_object_id,file_name,file_format,role) values ($1,$2,'thumb.png','png','derived')`, [dr, fo]);
    });

    it('구절: 본문 검색, 근거 링크 중복 금지', async () => {
      const ch = (await one(`insert into doc_chunk(document_file_id,chunk_index,body) values ($1,0,'Body 는 J1 모터를 감싸는 하우징이다. M3 볼트 4개로 Base 에 고정한다.') returning id`, [S.df])).id;
      assert.equal((await one(`select count(*)::int n from doc_chunk where tsv @@ plainto_tsquery('simple','j1')`)).n, 1);
      await db.query(`insert into item_passage_link(item_revision_id,doc_chunk_id,purpose) values ($1,$2,'definition')`, [S.rBody1, ch]);
      await expectError(db, `insert into item_passage_link(item_revision_id,doc_chunk_id,purpose) values ($1,$2,'definition')`, [S.rBody1, ch],
        /item_passage_link_item_revision_id_doc_chunk_id_purpose/);
    });

    it('목록 뷰와 감사 로그', async () => {
      const cur = await rows(`select item_no, latest_rev from item_current order by id`);
      assert.equal(cur.find(r => r.item_no === 'Body_HCR3A').latest_rev, 'R01');
      const au = await one(`select count(*)::int n, count(*) filter (where changed_by = 1)::int by_user from audit_log`);
      assert.ok(au.n > 0);
      assert.equal(au.n, au.by_user, '모든 감사 행에 작업자가 남는다');
    });

    it('공용 설명서: 여러 제품 연결, 제품 전용 구절', async () => {
      const prod5 = (await one(`insert into product(code,name) values ('HCR5A','협동로봇 5kg') returning id`)).id;
      const man = (await one(`insert into document(doc_no,title,doc_type) values ('MAN-HCR','HCR 시리즈 설명서','manual') returning id`)).id;
      const manR = (await one(`insert into document_revision(document_id,rev,rev_seq) values ($1,'R00',0) returning id`, [man])).id;
      await db.query(`insert into product_document(product_id,document_id,is_primary) values ($1,$3,true),($2,$3,true)`, [S.prod, prod5, man]);
      assert.equal((await one(`select count(*)::int n from product_document where document_id=$1`, [man])).n, 2);
      await expectError(db, `insert into product_document(product_id,document_id) values ($1,$2)`, [S.prod, man], /product_document_product_id_document_id_key/);
      await expectError(db, `insert into product_document(product_id,document_id,document_revision_id) values ($1,$2,$3)`, [prod5, S.doc, manR],
        /product_document_document_revision_id_document_id_fkey/);

      const mfo = (await one(`insert into file_object(sha256,size_bytes,storage_key) values (repeat('b',64),10,'bb/bb/y') returning id`)).id;
      const mdf = (await one(`insert into document_file(document_revision_id,file_object_id,file_name,file_format) values ($1,$2,'man.pdf','pdf') returning id`, [manR, mfo])).id;
      await db.query(`insert into doc_chunk(document_file_id,chunk_index,body) values ($1,0,'공통: 전원 연결 방법')`, [mdf]);
      const c1 = (await one(`insert into doc_chunk(document_file_id,chunk_index,body) values ($1,1,'HCR3A 전용: J1 토크 설정') returning id`, [mdf])).id;
      const c2 = (await one(`insert into doc_chunk(document_file_id,chunk_index,body) values ($1,2,'HCR5A 전용: J1 토크 설정') returning id`, [mdf])).id;
      await db.query(`insert into doc_chunk_product(doc_chunk_id,product_id) values ($1,$3),($2,$4)`, [c1, c2, S.prod, prod5]);
      const ids = async p => (await rows(`select chunk_index from chunks_for_product($1,$2)`, [p, mdf])).map(r => r.chunk_index).join();
      assert.equal(await ids(S.prod), '0,1');
      assert.equal(await ids(prod5), '0,2');
    });

    it('작업중 리비전 삭제는 BOM 줄 · 연결과 함께 지워진다', async () => {
      await db.query(`insert into bom_line(parent_revision_id,child_item_id) values ($1,$2)`, [S.rBody1, S.bolt]);
      await db.query(`delete from item_revision where id=$1`, [S.rBody1]);
      assert.equal((await one(`select count(*)::int n from bom_line where parent_revision_id=$1`, [S.rBody1])).n, 0);
    });

    it('등록 요청: 임시저장 → 제출 → 관리자 모드 승인으로 품번 발급', async () => {
      const draft = (await one(`insert into part_request(source_system, payload) values ('PDM', '{}') returning id`)).id;
      await expectError(db, `update part_request set status='submitted' where id=$1`, [draft], /part_request_check/);
      await db.query(`update part_request set status='submitted', payload=$2 where id=$1`, [draft, JSON.stringify({
        name: 'Bracket L', name_ko: '브래킷 L', item_type: 'part', material_iri: 'mat:SUS304',
        aliases: [{ scheme: 'legacy', value: 'BRK-0007' }, { scheme: 'cad_name', value: 'Bracket' }],
      })]);
      await expectError(db, `select approve_part_request($1)`, [draft], /분류가 정해지지 않았습니다/);
      await db.exec(`SET app.user_id = '2'`);
      await expectError(db, `select approve_part_request($1)`, [draft], /권한이 없습니다/);
      await db.exec(`SET app.user_id = '1'`);
      await db.query(`update part_request set payload = payload || '{"class_iri":"cls:Bracket"}' where id=$1`, [draft]);

      S.newItem = (await one(`select approve_part_request($1) as id`, [draft])).id;
      S.issued = await one(`select item_no, class_iri from item where id=$1`, [S.newItem]);
      assert.match(S.issued.item_no, /^P\d{7}$/);
      assert.equal(S.issued.class_iri, 'cls:Bracket');
      assert.equal((await one(`select count(*)::int n from item_revision where item_id=$1 and rev='R00' and status='wip'`, [S.newItem])).n, 1);
      await expectError(db, `select approve_part_request($1)`, [draft], /제출된 요청만 승인할 수 있습니다/);
    });

    it('등록 요청: 별칭이 겹치면 승인 전체가 롤백된다', async () => {
      const dup = (await one(`insert into part_request(source_system, status, payload) values ('PLM','submitted',$1) returning id`,
        [JSON.stringify({ name: 'Bracket copy', class_iri: 'cls:Bracket', aliases: [{ scheme: 'legacy', value: 'BRK-0007' }] })])).id;
      const before = (await one(`select count(*)::int n from item`)).n;
      await expectError(db, `select approve_part_request($1)`, [dup], /item_identifier_uq/);
      assert.equal((await one(`select count(*)::int n from item`)).n, before);
      assert.equal((await one(`select status from part_request where id=$1`, [dup])).status, 'submitted');
    });

    it('별칭 매칭: 레거시 품번은 정확 일치(1.0), CAD 이름은 제안(0.97)', async () => {
      const al = await rows(`select item_no, method, score from match_item_candidates('BRK-0007')`);
      assert.deepEqual([al[0].item_no, al[0].method, al[0].score], [S.issued.item_no, 'alias', 1]);
      const cn = await rows(`select item_no, method, score from match_item_candidates('Bracket')`);
      assert.deepEqual([cn[0].item_no, cn[0].method], [S.issued.item_no, 'cad_name']);
    });

    it('공개(pub): 작업중은 숨기고, 승인하면 공개 + outbox 기록', async () => {
      assert.equal((await rows(`select 1 from pub.part where item_no=$1`, [S.issued.item_no])).length, 0);
      const rNew = (await one(`select id from item_revision where item_id=$1`, [S.newItem])).id;
      await db.query(`update item_revision set status='in_review' where id=$1`, [rNew]);
      await db.query(`update item_revision set status='released' where id=$1`, [rNew]);
      assert.equal((await rows(`select 1 from pub.part where item_no=$1`, [S.issued.item_no])).length, 1);
      assert.equal((await one(`select count(*)::int n from outbox where aggregate='item_revision' and aggregate_id=$1 and event='released'`, [rNew])).n, 1);
      await db.query(`update item set name_ko='브래킷 L형' where id=$1`, [S.newItem]);
      assert.equal((await one(`select count(*)::int n from outbox where aggregate='item' and aggregate_id=$1`, [S.newItem])).n, 1);
      assert.deepEqual((await rows(`select scheme from pub.part_identifier where item_no=$1`, [S.issued.item_no])).map(r => r.scheme), ['legacy']);
    });

    it('공개 BOM: 새 리비전이 승인될 때까지 이전 승인본을 보여 준다', async () => {
      assert.equal((await rows(`select 1 from pub.bom`)).length, 0, 'Body R00 폐기 · Robot R00 작업중');
      const asm = await S.mk('ASM-1', 'Frame', 'assembly');
      const rA0 = await S.rev(asm, 'R00', 0);
      await db.query(`insert into bom_line(parent_revision_id,child_item_id,quantity) values ($1,$2,2)`, [rA0, S.newItem]);
      await db.query(`update item_revision set status='in_review' where id=$1`, [rA0]);
      await db.query(`update item_revision set status='released' where id=$1`, [rA0]);
      const rA1 = await S.rev(asm, 'R01', 1);
      await db.query(`insert into bom_line(parent_revision_id,child_item_id,quantity) values ($1,$2,3)`, [rA1, S.newItem]);
      const pb1 = await rows(`select parent_rev, quantity from pub.bom where parent_item_no='ASM-1'`);
      assert.deepEqual(pb1.map(r => [r.parent_rev, Number(r.quantity)]), [['R00', 2]]);
      await db.query(`update item_revision set status='in_review' where id=$1`, [rA1]);
      await db.query(`update item_revision set status='released' where id=$1`, [rA1]);
      const pb2 = await rows(`select parent_rev, quantity from pub.bom where parent_item_no='ASM-1'`);
      assert.deepEqual(pb2.map(r => [r.parent_rev, Number(r.quantity)]), [['R01', 3]]);
    });

    it('재고: 늦게 도착한 옛 값은 무시, 없는 품번은 거부', async () => {
      await db.query(`select pub.upsert_inventory($1,'ERP','P1','WH-A',100,20,'EA','2026-10-21T10:00:00Z')`, [S.issued.item_no]);
      await db.query(`select pub.upsert_inventory($1,'ERP','P1','WH-A',80,20,'EA','2026-10-21T09:00:00Z')`, [S.issued.item_no]);
      const inv = await one(`select qty_on_hand, qty_available from pub.inventory where item_no=$1`, [S.issued.item_no]);
      assert.deepEqual([Number(inv.qty_on_hand), Number(inv.qty_available)], [100, 80]);
      await expectError(db, `select pub.upsert_inventory('NOPE','ERP','P1','',1,0,'EA',now())`, [], /등록되지 않은 품번/);
    });

    it('분류 제안: 근거 필수, 승인하면 outbox 기록', async () => {
      await expectError(db, `insert into class_proposal(parent_class_iri,label_ko,definition,evidence) values ('cls:Fastener','셀프태핑 나사','...','[]')`, [],
        /class_proposal_evidence_check/);
      const cp = (await one(`insert into class_proposal(parent_class_iri,label_ko,definition,evidence)
        values ('cls:Fastener','셀프태핑 나사','자체 나사산을 내며 체결되는 나사','[{"doc_chunk_id":1,"quote":"..."}]') returning id`)).id;
      await db.query(`update class_proposal set status='approved', approved_iri='cls:SelfTappingScrew' where id=$1`, [cp]);
      assert.equal((await one(`select count(*)::int n from outbox where aggregate='class' and aggregate_id=$1`, [cp])).n, 1);
    });

    it('품번 변경: 옛 번호는 별칭으로 남고 그래프 키는 그대로', async () => {
      const key = (await one(`select iri_key from item where id=$1`, [S.newItem])).iri_key;
      assert.equal(key, S.issued.item_no);
      await expectError(db, `update item set iri_key='changed' where id=$1`, [S.newItem], /그래프 키\(iri_key\)는 바꿀 수 없습니다/);
      await db.exec(`SET app.user_id = '2'`);
      await expectError(db, `select renumber_item($1,'MRG-000001')`, [S.newItem], /권한이 없습니다/);
      await db.exec(`SET app.user_id = '1'`);

      const obBefore = (await one(`select count(*)::int n from outbox where aggregate='item' and aggregate_id=$1`, [S.newItem])).n;
      await db.query(`select renumber_item($1,'MRG-000001')`, [S.newItem]);
      const item = await one(`select item_no, iri_key from item where id=$1`, [S.newItem]);
      assert.deepEqual([item.item_no, item.iri_key], ['MRG-000001', key]);
      const old = await rows(`select item_no, method, score from match_item_candidates($1)`, [S.issued.item_no]);
      assert.deepEqual([old[0].item_no, old[0].method, old[0].score], ['MRG-000001', 'alias', 1]);
      assert.equal((await rows(`select 1 from pub.part_identifier where item_no='MRG-000001' and scheme='legacy' and value=$1`, [S.issued.item_no])).length, 1);
      assert.ok((await one(`select count(*)::int n from outbox where aggregate='item' and aggregate_id=$1`, [S.newItem])).n > obBefore);

      const other = (await one(`insert into item(item_no,name) values ('MRG-000002','Other') returning id`)).id;
      await expectError(db, `select renumber_item($1,'MRG-000001')`, [other], /item_no_uq/);
      assert.equal((await rows(`select 1 from item_identifier where item_id=$1`, [other])).length, 0, '실패한 변경은 별칭을 남기지 않는다');
      await expectError(db, `insert into item(item_no,name) values ($1,'reuse')`, [S.issued.item_no], /item_iri_key_key/);
    });
  });
}
