"""neo4j/ 변경 영향 분석 검사: 스키마 · 예시 데이터(BRK-M8) · 검사 규칙 · 질의 · 멱등성 · OPMS 라벨 불변을 일회용 Neo4j 컨테이너에서 확인한다.

    python neo4j/test/verify_changes.py

Docker 가 필요하다. 기존 verify.py 와 같은 이미지(neo4j:5.26.x-community)를 포트 없이 임시로 띄우고 끝나면 지운다.
OPMS 의 실제 DB 에는 닿지 않는다. 기존 verify.py(49개)는 따로 돈다 — 이 스크립트는 그 도구(shell · run_file · blocks …)를 재사용한다.
실패가 하나라도 있으면 종료 코드 1.
"""
from __future__ import annotations

import importlib.util
import re
import sys
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
NEO = HERE.parent

_spec = importlib.util.spec_from_file_location("pdm_verify_base", HERE / "verify.py")
v = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(v)                      # 기존 verify.py 의 도구를 재사용한다(main 은 부르지 않는다)
v.NAME = f"onto-pdm-changes-verify-{uuid.uuid4().hex[:8]}"

check = v.check
OPMS_LABELS = ["Class", "Property", "Scheme", "Concept", "Term", "Rule", "OntologyVersion", "Part",
               "Supplier", "SupplierPart", "SourceDoc", "Sequence", "PartReservation", "DedupeLock"]

OLD_CHECKS_COUNT = 27

# 새 검사 → 망가뜨린 데이터에서 그 검사가 잡아야 하는 subject · message 의 표지. 모든 새 검사가 여기 있어야 한다.
NEW_CHECKS: dict[str, str] = {
    "change_order_published_status": "CO-ZZ-DRAFT",
    "change_order_approval_recorded": "CO-ZZ-NOAPPR",
    "change_order_one_request": "CO-ZZ-NOAPPR",
    "change_request_accepted": "CR-ZZ-REQ",
    "change_has_target": "CO-ZZ-NOAPPR",
    "change_target_valid": "CO-ZZ-REQ#1",
    "target_changes_released_revision": "CO-ZZ-REQ#1",
    "released_revision_immutable": "CO-ZZ-IMM#1",
    "replace_target_one_new_item": "CO-ZZ-REPL#1",
    "replace_target_has_part": "CO-ZZ-REPL#3",
    "change_target_replacement_distinct": "CO-ZZ-REPL#4",
    "no_opms_value_shadow": "ZZ|length",
    "revision_attribute_valid": "ZZ|thickness",
    "finding_has_basis": "ZZ#1#1",
    "finding_verdict_valid": "ZZ#1#2",
    "disposition_one_finding": "ZZ-D1",
    "disposition_action_allowed": "ZZ-D2",
    "finding_immutable_after_decision": "ZZ-D3",
    "disposition_required_for_affected": "CO-ZZ-AFF",
    "blocked_not_approvable": "CO-ZZ-AFF",
    "blocked_no_accept_risk": "CO-ZZ-AFF#1",
    "approved_run_has_findings": "CO-ZZ-NOAPPR",
    "scope_required_before_approval": "CO-ZZ-REQ#1",
    "scope_valid": "ZZ-S1",
    "review_signoff_before_approval": "CO-ZZ-NOAPPR",
    "review_signoff_valid": "ZZ-R1",
    "no_ontology_version_as_revision": "9101",
    "ontology_impact_no_revision": "CR-ZZ-OI",
    "external_copy_has_source": "WO-ZZ-1",
    "external_copy_valid": "ZZ/1",
    "external_copy_links": "WO-ZZ-1",
    "new_labels_disjoint_from_opms": "WorkOrder",
    "unregistered_item_consistent": "9201",
    "joint_complete": "ZZ-J1",
    "joint_clamp_order": "ZZ-J2",
    "released_coexist_needs_partial_scope": "0.19.0",
}


def wipe() -> None:
    r = v.shell("MATCH (n) DETACH DELETE n;")
    if r.returncode:
        raise SystemExit(f"DB 를 비우지 못했다: {r.stderr}")


def run_cypher(path: Path) -> None:
    v.run_file(path)


def qp(name: str, defs: dict[str, tuple[list[str], str]], **raw: str) -> list[list[str]]:
    """raw 는 Cypher 리터럴 문자열 그대로('null' · '71' · "'P-…'")."""
    args, text = defs[name]
    assert set(args) == set(raw), f"{name}: 인자 {args}"
    r = v.shell(text, raw)
    if r.returncode:
        raise SystemExit(f"{name} 실패:\n{r.stderr}\n{r.stdout}")
    return v.rows(r.stdout)


def lit(s: str) -> str:
    return "'" + s + "'"


def totals() -> tuple[str, str]:
    return v.count("(n)"), v.count("()-[r]->()")


def opms_snapshot() -> str:
    """OPMS 가 소유하는 라벨별 노드 수와, :Part 의 속성 수 · 라벨 수. PDM 이 OPMS 라벨에 쓰면 달라진다."""
    parts = []
    for lab in OPMS_LABELS:
        parts.append(f"{lab}={v.count(f'(n:{lab})')}")
    parts.append("Part:" + v.part_snapshot())
    return " ".join(parts)


def scan_opms_writes() -> list[str]:
    """새 파일(시험 대역 제외)에서 OPMS 라벨을 CREATE · MERGE 하거나 :Part 변수에 SET 하는 문장을 찾는다."""
    bad: list[str] = []
    label_re = "|".join(OPMS_LABELS)
    for f in ["changes-schema.cypher", "changes-checks.cypher", "changes-queries.cypher", "changes-sample.cypher"]:
        text = (NEO / f).read_text(encoding="utf-8")
        code = "\n".join(ln for ln in text.splitlines() if not ln.lstrip().startswith("//"))
        for m in re.finditer(rf"\b(CREATE|MERGE)\s*\(\s*\w*\s*:\s*({label_re})\b", code):
            bad.append(f"{f}: {m.group(0)}")
        for m in re.finditer(rf"\bCONSTRAINT\s+\w+\s+IF NOT EXISTS\s+FOR\s*\(\s*\w*\s*:\s*({label_re})\b", code):
            bad.append(f"{f}: 제약 {m.group(0)}")
    # 문장마다: OPMS 라벨로 바인딩된 변수에 속성 · 라벨을 쓰거나 지우는 문장
    for f in ["changes-sample.cypher", "changes-checks.cypher", "changes-queries.cypher"]:
        code = "\n".join(ln for ln in (NEO / f).read_text(encoding="utf-8").splitlines() if not ln.lstrip().startswith("//"))
        for stmt in code.split(";"):
            for var in set(re.findall(rf"\(\s*(\w+)\s*:\s*(?:{label_re})\b", stmt)):
                if (re.search(rf"\b{var}\.\w+\s*\+?=", stmt) or re.search(rf"\b{var}\s*\+=", stmt)
                        or re.search(rf"\bSET\s+{var}\s*:", stmt) or re.search(rf"\b(REMOVE|DELETE|DETACH DELETE)\s+{var}\b", stmt)):
                    bad.append(f"{f}: OPMS 라벨 변수 {var} 를 고친다")
    return bad


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    started = v.docker("run", "-d", "--rm", "--name", v.NAME, "-e", "NEO4J_AUTH=none", v.IMAGE)
    if started.returncode:
        raise SystemExit(f"컨테이너를 띄우지 못했다: {started.stderr}")
    try:
        v.wait_ready()
        old_checks = v.blocks(NEO / "checks.cypher")
        new_checks = v.blocks(NEO / "changes-checks.cypher")
        qs = v.blocks(NEO / "changes-queries.cypher")

        # ------------------------------------------------------------------
        print("\n== 1) 기존 데이터 · 기존 검사 27개는 그대로 통과하고, item_one_part 예외는 좁다")
        run_cypher(HERE / "opms-standin.cypher")
        run_cypher(NEO / "schema.cypher")
        run_cypher(NEO / "sample.cypher")
        check(len(old_checks) == OLD_CHECKS_COUNT, f"기존 검사 {OLD_CHECKS_COUNT}개를 읽었다", str(len(old_checks)))
        found = v.violations(old_checks)
        check(not found, "기존 예시 데이터가 기존 검사 27개를 모두 통과한다", str(found))
        run_cypher(HERE / "break.cypher")
        subjects = [r[1].strip('"') for r in v.q("item_one_part", old_checks)]
        check("#999" in subjects, "  :Part 없는 일반 품목은 여전히 item_one_part 위반이다 (#999)", str(subjects))
        check("#996" in subjects, "  opms_registered=false 여도 규격품(standard)은 예외가 아니다 (#996)", str(subjects))
        check("#997" not in subjects, "  opms_registered=false 인 가공품(part)은 :Part 없이 통과한다 (#997)", str(subjects))
        wipe()

        # ------------------------------------------------------------------
        print("\n== 2) 변경 영향 스키마와 예시 데이터 (BRK-M8)")
        run_cypher(HERE / "opms-standin.cypher")
        run_cypher(HERE / "changes-opms-standin.cypher")
        run_cypher(NEO / "schema.cypher")
        run_cypher(NEO / "changes-schema.cypher")
        opms_before = opms_snapshot()
        run_cypher(NEO / "changes-sample.cypher")
        opms_after = opms_snapshot()
        check(opms_after == opms_before, "PDM 은 OPMS 소유 라벨에 노드도 라벨도 속성도 쓰지 않는다", f"{opms_before}\n→ {opms_after}")
        writes = scan_opms_writes()
        check(not writes, "새 cypher 파일이 OPMS 라벨을 만들거나 :Part 를 고치는 문장이 없다", str(writes))
        for label, n in [("PdmItem", 9), ("ItemRevision", 13), ("ChangeRequest", 2), ("ChangeOrder", 2), ("ChangeTarget", 4),
                         ("ImpactFinding", 11), ("Disposition", 5), ("ReviewSignoff", 4), ("ApplicabilityScope", 5),
                         ("RevisionAttribute", 3), ("FastenedJoint", 2), ("WorkOrder", 3), ("PurchaseOrderLine", 2),
                         ("StockLot", 3), ("OntologyImpact", 1)]:
            got = v.count(f"(n:{label})")
            check(got == str(n), f"{label} {n}개", got)
        check(v.count("(:PdmItem)-[:OF_PART]->(:Part)") == "5", "규격품 5개만 OPMS :Part 에 이어진다 (판 · 모듈 · 체결 세트는 :Part 가 없다)")
        check(v.count("(:PdmItem {opms_registered: false})") == "4", "OPMS 미등록 품목 4개(모듈 · 상판 · 하판 · 체결 세트)에 표시가 있다")
        before = totals()
        run_cypher(NEO / "schema.cypher")
        run_cypher(NEO / "changes-schema.cypher")
        run_cypher(NEO / "changes-sample.cypher")
        check(totals() == before, "같은 승인본을 다시 발행해도 노드 · 관계 수가 같다 (멱등)", str(before))

        # ------------------------------------------------------------------
        print("\n== 3) 데이터 검사: 기존 27개 + 변경 영향 검사")
        found_old = v.violations(old_checks)
        check(not found_old, "BRK-M8 데이터가 기존 검사 27개를 통과한다 (가공품 · 조립품은 :Part 없이)", str(found_old))
        check(len(new_checks) == len(NEW_CHECKS) and set(new_checks) == set(NEW_CHECKS),
              f"새 검사 {len(new_checks)}개를 읽었고 모두 망가뜨린 데이터 시험이 있다", str(sorted(set(new_checks) ^ set(NEW_CHECKS))))
        found_new = v.violations(new_checks)
        check(not found_new, "BRK-M8 예시 데이터가 새 검사를 모두 통과한다", str(found_new))

        # ------------------------------------------------------------------
        print("\n== 4) 질의: changes-queries.cypher")
        flat = lambda rs, i=0: [r[i].strip('"') for r in rs]                              # noqa: E731
        s1 = qp("cr_where_used_revisions", qs, item_ref=lit("P-00000000022"))
        got = [(r[0].strip('"'), r[1].strip('"'), r[2].strip('"')) for r in s1]
        check(got == [("BRK-M8", "R00", "released"), ("BRK-M8", "R01", "released"),
                      ("BRK-M8-SET", "R00", "released"), ("BRK-M8-SET", "R01", "released")],
              "SC-1 영향 BOM 개정: 너트 P-…22 → 체결 세트 R00 · R01 → 모듈 R00 · R01 (승인된 개정 전부)", str(got))
        wo = qp("cr_impacted_work_orders", qs, item_ref=lit("P-00000000022"))
        check(flat(wo) == ["WO-FX-0001", "WO-FX-0002", "WO-FX-0003"], "SC-1 영향 작업지시 3건 (모듈 R00 을 쓰는 작업)", str(wo))
        check(all(r[-1].strip('"') == "fixture" for r in wo), "  외부 사본은 모두 source_system = fixture")
        ps = v.shell(qs["cr_open_po_and_stock"][1], {"item_ref": lit("P-00000000022")}).stdout
        check("PO-FX-100/10 open=120 S1" in ps, "SC-1 미입고 발주: PO-FX-100/10 미입고 120", ps.strip())
        check("LT-N-01 qty=300 S1 available" in ps and "LT-N-02 qty=50 S2 available" in ps, "SC-1 재고 로트: LT-N-01 300 · LT-N-02 50", ps.strip())
        s2 = qp("cr_where_used_revisions", qs, item_ref=lit("BRK-M8-P01"))
        got2 = [(r[0].strip('"'), r[1].strip('"')) for r in s2]
        check(got2 == [("BRK-M8", "R00"), ("BRK-M8", "R01")], "SC-2 영향 BOM 개정: 상판(item_no 로 질의) → 모듈 R00 · R01", str(got2))
        check(flat(qp("cr_impacted_work_orders", qs, item_ref=lit("BRK-M8-P01"))) == ["WO-FX-0001", "WO-FX-0002", "WO-FX-0003"],
              "SC-2 영향 작업지시 3건")
        scope = qp("cr_scope_work_orders", qs, item_ref=lit("BRK-M8-P01"), site="null", serial_from="71")
        got3 = [(r[0].strip('"'), r[3].strip('"')) for r in scope]
        check(got3 == [("WO-FX-0002", "partial"), ("WO-FX-0003", "full")],
              "SC-2 일련번호 71 이후: 1~50 은 범위 밖, 51~80 은 부분(partial), 81~120 은 전부(full)", str(got3))
        scope_s2 = qp("cr_scope_work_orders", qs, item_ref=lit("BRK-M8-P01"), site=lit("S2"), serial_from="71")
        check(flat(scope_s2) == ["WO-FX-0003"], "  사업장 S2 로 좁히면 WO-FX-0003 만", str(scope_s2))
        check(len(qp("cr_scope_work_orders", qs, item_ref=lit("BRK-M8-P01"), site="null", serial_from="null")) == 3,
              "  범위를 지정하지 않으면(null) 작업지시 3건 모두 통과")
        diff = qp("cr_bom_diff", qs, item_ref=lit("BRK-M8-SET"), rev_a=lit("R00"), rev_b=lit("R01"))
        got4 = [(r[0].strip('"'), r[1], r[2], r[3].strip('"')) for r in diff]
        check(got4 == [("P-00000000001", "4.0", "NULL", "removed"), ("P-00000000015", "NULL", "4.0", "added"),
                       ("P-00000000022", "4.0", "4.0", "same"), ("P-00000000025", "8.0", "4.0", "qty_changed")],
              "개정 비교 체결 세트 R00 vs R01: 볼트 제거 · 플랜지볼트 추가 · 너트 같음 · 와셔 8 → 4", str(got4))
        impact = qp("cr_change_impact", qs, order_code=lit("CO-2026-0002"))
        sev = [r[1].strip('"') for r in impact]
        check(sev == ["affected"] * 4 + ["review"] + ["none"] * 4,
              "CO-2026-0002 의 영향: affected 4(작업지시 2 · 발주 · 재고) → review 1(대체) → none 4, 심각한 것부터", str(sev))
        actions = {r[2].strip('"'): r[4].strip('"') for r in impact if r[1].strip('"') in ("affected", "review")}
        check(actions == {"WO-FX-0002": "change_in_progress", "WO-FX-0003": "apply_new", "PO-FX-100/20": "amend",
                          "LT-B-01|P-00000000001": "use_up", "3203|상·하판 체결": "review_with_design"},
              "  affected · review 영향마다 사람이 정한 처분이 달려 있다 (영향 ≠ 변경)", str(actions))
        blocked_hist = v.shell("MATCH (f:ImpactFinding {severity: 'blocked'}) RETURN f.finding_key AS k;").stdout.strip().splitlines()
        check(blocked_hist[-1].strip('"') == "CO-2026-0002#1#1", "  blocked 는 이전 분석(이력)에만 있고 승인된 분석에는 없다", str(blocked_hist))
        check(v.count("(:ImpactFinding)-[:SUPERSEDES]->(:ImpactFinding)") == "1", "  재분석이 이전 판단을 대체한 이력(SUPERSEDES)이 있다")
        chg = qp("cr_changes_of_item", qs, item_ref=lit("P-00000000001"))
        got5 = [(r[0].strip('"'), r[1].strip('"')) for r in chg]
        check(got5 == [("CO-2026-0002", "replace"), ("CO-2026-0003", "revise")], "볼트 P-…01 의 변경 이력: 교체(SC-2)와 개정(SC-3)", str(got5))
        revs = v.shell("MATCH (i:PdmItem {pdm_item_id: 2101})-[:HAS_REVISION]->(r) RETURN r.rev + ':' + r.status AS x ORDER BY r.rev;").stdout
        check("R00:obsolete" in revs and "R01:released" in revs, "SC-3 같은 품번의 새 개정: 전체 범위라 R00 은 obsolete, R01 이 현재", revs.strip())
        coexist = v.shell("MATCH (i:PdmItem {pdm_item_id: 2001})-[:HAS_REVISION]->(r {status: 'released'}) RETURN count(r) AS n;").stdout.strip().splitlines()[-1]
        check(coexist == "2", "SC-2 일부 범위 적용: 상판에 승인 개정 R00 · R01 이 함께 있다 (이미 만든 제품은 기존 사양)", coexist)

        # ------------------------------------------------------------------
        print("\n== 5) 망가뜨린 데이터는 거부된다")
        run_cypher(HERE / "changes-break.cypher")
        bad_new = {n: found for n in new_checks if (found := v.q(n, new_checks))}
        for rule, token in NEW_CHECKS.items():
            hits = ["  ".join(r) for r in bad_new.get(rule, [])]
            check(any(token in h for h in hits), f"  위반으로 잡힘: {rule}  (표지 {token})", str(hits)[:300])
        check(set(bad_new) == set(NEW_CHECKS), "  모든 새 검사가 위반을 낸다", str(sorted(set(NEW_CHECKS) - set(bad_new))))
        #   '(key 없음)' · 'NULL' 은 망가뜨린 :Part(P-…03)에 WorkOrder 라벨을 붙인 노드가 만드는 부수 위반(키가 없다)이라 의도된 것이다
        intended = ("ZZ", "9101", "9201", "WorkOrder", "0.19.0", "RESULTED_IN", "(key 없음)", "NULL")
        stray = {n: [h for h in ("  ".join(r) for r in rows) if not any(tok in h for tok in intended)]
                 for n, rows in bad_new.items()}
        stray = {n: hs for n, hs in stray.items() if hs}
        check(not stray, "  예시 데이터(ZZ 가 아닌 것)가 위반으로 잡히지 않는다 — 예상 밖 위반이 없다", str(stray))
        bad_old = v.violations(old_checks)
        allowed_old = {"revision_status_valid", "item_one_part"}      # 시험 전용 :Part 에 PDM 라벨을 붙인 것 등이 건드릴 수 있는 기존 검사
        check(set(bad_old) <= allowed_old, "  기존 검사 27개는 변경 영향 망가뜨린 데이터에서 예상 밖으로 울리지 않는다", str(sorted(set(bad_old) - allowed_old)))
    finally:
        v.docker("rm", "-f", v.NAME)

    print(f"\n{v.passed} passed, {v.failed} failed")
    return 1 if v.failed else 0


if __name__ == "__main__":
    sys.exit(main())
