"""조립 규칙 · 작업표준 적재(store)와 모양 변환(build): 실제 rules/ 로 읽히고, 깨지면 503, 파일이 바뀌면 다시 읽는다."""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from typing import Any

import pytest

from onto_pdm.rulebook import DEFAULT_RULES_DIR, RulebookStore
from tests.unit.rulebook_fixtures import B, NO_OPMS, client, real_store, temp_rules

GRADES = ("manual", "standard", "cad", "unknown")


@pytest.fixture(scope="module")
def book():  # type: ignore[no-untyped-def]
    snap = real_store().snapshot()
    assert snap.state == "ok", snap.message
    assert snap.book is not None
    return snap.book


def _checker():  # type: ignore[no-untyped-def]
    path = DEFAULT_RULES_DIR.parent / "tools" / "check_rules.py"
    spec = importlib.util.spec_from_file_location("_test_check_rules", path)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    sys.modules["_test_check_rules"] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# ---------------------------------------------------------------- 실제 rules/ 적재
def test_real_rules_load_ok_and_counts_match_the_files() -> None:
    st = real_store().status()
    assert st.state == "ok" and st.message is None
    assert st.counts is not None
    assert (st.counts.rules, st.counts.work_standards, st.counts.gaps) == (23, 10, 19)
    assert (st.counts.operations, st.counts.not_covered, st.counts.tools) == (18, 4, 3)
    assert (st.counts.steps, st.counts.inspection_items) == (31, 8)


def test_loader_runs_check_rules_and_reports_its_result() -> None:
    st = real_store().status()
    assert st.validation is not None and st.validation.tool == "check_rules"
    assert st.validation.errors == []
    # OPMS 저장소가 없는 환경이라 분류 이름 대조는 경고로 건너뛴다(시험이 이 PC 의 OPMS 에 기대지 않는다)
    assert [w.where for w in st.validation.warnings] == ["opms"]


def test_status_grade_totals_are_the_validators_own_numbers() -> None:
    expected = _checker().check(DEFAULT_RULES_DIR, NO_OPMS).by_grade()
    st = real_store().status()
    assert st.by_grade == expected
    assert sum(expected.values()) > 0 and expected["standard"] == 0            # 표준 참고값은 쓰지 않았다(확인할 원문이 없다)


# ---------------------------------------------------------------- 값을 지어내지 않는다
def test_unknown_values_are_null_with_a_gap_and_never_confirmed(book) -> None:  # type: ignore[no-untyped-def]
    seen = 0
    for rule in book.rules.values():
        for p in rule.parameters:
            if p.source == "unknown":
                seen += 1
                assert p.value is None and p.gap_id and p.confirmed is False, (rule.id, p.name)
    for tool in book.tools.values():
        for p in tool.spec:
            if p.source == "unknown":
                seen += 1
                assert p.value is None and p.gap_id, (tool.id, p.name)
    for ws in book.work_standards.values():
        assert ws.standard_time.value is None and ws.standard_time.source == "unknown" and ws.standard_time.gap_id == "G-006"
        seen += 1
    assert seen >= 19


def test_confirmed_means_manual_and_not_estimated(book) -> None:  # type: ignore[no-untyped-def]
    n_true = n_false = 0
    for rule in book.rules.values():
        items: list[Any] = [rule.applies_to, *rule.parameters, *rule.cautions, *(rule.lookup.rows if rule.lookup else [])]
        for it in items:
            if it.confirmed:
                n_true += 1
                assert it.source == "manual" and not it.estimated
            else:
                n_false += 1
    assert n_true > 100 and n_false > 0


def test_manual_values_carry_the_page_and_a_readable_label(book) -> None:  # type: ignore[no-untyped-def]
    row = {r.key: r for r in book.rules["AR-FAS-001"].lookup.rows}["HCR-3A"]
    assert row.values["threadSize"] == "M6" and row.values["torque_nm"] == 30 and row.confirmed and row.source == "manual"
    ref = row.refs[0]
    assert ref.pages == [49] and ref.sec == "3.3" and ref.doc == "UG-KR" and ref.label == "사용설명서(KR) 3.3절 p.49"
    for rule in book.rules.values():
        for c in rule.cautions:
            if c.source == "manual":
                assert c.refs and all(r.pages for r in c.refs), (rule.id, c.text[:20])


def test_cad_and_unknown_values_are_flagged_unconfirmed(book) -> None:  # type: ignore[no-untyped-def]
    ar6 = book.rules["AR-FAS-006"]
    assert ar6.applies_to.source == "cad" and ar6.applies_to.estimated and not ar6.applies_to.confirmed
    torque = {p.name: p for p in ar6.parameters}["torque_nm"]
    assert torque.value is None and torque.source == "unknown" and torque.gap_id == "G-001"
    hexkey = book.tools["TL-HEXKEY"]
    assert hexkey.need.source == "cad" and hexkey.need.estimated and not hexkey.need.confirmed


def test_rule_gap_ids_include_gaps_that_block_it(book) -> None:  # type: ignore[no-untyped-def]
    assert {"G-001", "G-005", "G-008"} <= set(book.rules["AR-FAS-006"].gap_ids)
    assert "G-008" in book.rules["AR-FAS-001"].gap_ids            # 값은 비어 있지 않지만 gaps.yaml 의 blocks 가 이 규칙을 가리킨다
    assert "G-003" in book.rules["AR-FAS-002"].gap_ids


def test_rule_scopes_split_part_role_and_product(book) -> None:  # type: ignore[no-untyped-def]
    scopes = {r.id: r.scope for r in book.rules.values()}
    assert scopes["AR-FAS-001"] == "part" and scopes["AR-LOC-001"] == "role" and scopes["AR-SIT-001"] == "product"
    assert {r.id for r in book.rules.values() if r.scope == "part"} >= {"AR-FAS-001", "AR-FAS-002", "AR-FAS-004", "AR-FAS-005", "AR-FAS-006", "AR-SAF-001"}


def test_structure_only_work_standards_have_no_steps_and_a_procedure_gap(book) -> None:  # type: ignore[no-untyped-def]
    for wid in ("WS-HCR12A-ASM-01", "WS-HCR3A5A-ASM-01"):
        ws = book.work_standards[wid]
        assert ws.kind == "structure_only" and ws.steps == [] and ws.procedure_gap == "G-005" and ws.assembly_count >= 2
        assert all(p.source == "cad" and not p.confirmed for a in ws.assemblies for p in a.parts)
    assert book.work_standards["WS-HCR-MNT-01"].inspection_count == 8
    assert book.work_standards["WS-HCR-INS-02"].step_count == 5


# ---------------------------------------------------------------- 깨지면 503
def _break_operation(data: dict[str, Any]) -> None:
    data["rules"]["assembly_rules"]["AR-FAS-001"]["operation"] = "NoSuchOperation"


def test_invalid_rules_dir_keeps_the_app_alive_and_answers_503_with_the_error_list() -> None:
    with temp_rules(_break_operation) as d:
        c = client(RulebookStore(d, opms_home=NO_OPMS))
        st = c.get(f"{B}/status")
        assert st.status_code == 200
        body = st.json()
        assert body["state"] == "invalid" and "오류" in body["message"]
        assert body["counts"]["rules"] == 23                                         # 개수는 보여 준다(내용은 내보내지 않는다)
        assert any("NoSuchOperation" in e["message"] for e in body["validation"]["errors"])
        for path in ("/rules", "/rules/AR-FAS-001", "/operations", "/tools", "/work-standards", "/work-standards/WS-HCR-INS-02", "/gaps"):
            r = c.get(B + path)
            assert r.status_code == 503, path
            err = r.json()["error"]
            assert err["code"] == "RULEBOOK_INVALID" and "rules/" in err["message"]
            assert any("NoSuchOperation" in e["message"] for e in err["details"]["errors"]) and err["details"]["total"] >= 1
        sel = c.post(f"{B}/select", json={"class_code": "Bolt"})
        assert sel.status_code == 503 and sel.json()["error"]["code"] == "RULEBOOK_INVALID"
        assert c.get("/api/health").status_code == 200                                # 앱은 죽지 않는다


def test_a_value_without_source_is_an_error() -> None:
    def drop_source(data: dict[str, Any]) -> None:
        del data["rules"]["assembly_rules"]["AR-FAS-002"]["parameters"]["threadSize"]["source"]

    with temp_rules(drop_source) as d:
        st = RulebookStore(d, opms_home=NO_OPMS).status()
        assert st.state == "invalid" and any("source" in e.message for e in st.validation.errors)  # type: ignore[union-attr]


def test_invented_value_for_unknown_is_an_error() -> None:
    def invent(data: dict[str, Any]) -> None:
        data["rules"]["assembly_rules"]["AR-FAS-002"]["parameters"]["torque_nm"]["value"] = 5

    with temp_rules(invent) as d:
        st = RulebookStore(d, opms_home=NO_OPMS).status()
        assert st.state == "invalid" and any("지어내지" in e.message for e in st.validation.errors)  # type: ignore[union-attr]


def test_missing_folder_is_unavailable_not_a_crash() -> None:
    missing = Path(NO_OPMS) / "does-not-exist"
    c = client(RulebookStore(missing, opms_home=NO_OPMS))
    st = c.get(f"{B}/status").json()
    assert st["state"] == "unavailable" and "없습니다" in st["message"] and st["counts"] is None
    r = c.get(f"{B}/rules")
    assert r.status_code == 503 and r.json()["error"]["code"] == "RULEBOOK_UNAVAILABLE"


def test_broken_yaml_syntax_is_unavailable() -> None:
    with temp_rules() as d:
        (d / "gaps.yaml").write_text("gaps: [unclosed\n  - : :", encoding="utf-8")
        st = RulebookStore(d, opms_home=NO_OPMS).status()
        assert st.state == "unavailable" and "gaps.yaml" in (st.message or "")


# ---------------------------------------------------------------- 파일이 바뀌면 다음 요청에서 다시 읽는다
def test_reloads_when_a_file_changes_without_restarting() -> None:
    with temp_rules(_break_operation) as d:
        store = RulebookStore(d, opms_home=NO_OPMS)
        c = client(store)
        assert c.get(f"{B}/rules").status_code == 503
        # 고친다: 같은 파일을 실제 내용으로 되돌린다
        rules_path = d / "rules.yaml"
        text = rules_path.read_text(encoding="utf-8").replace("NoSuchOperation", "BoltFastening")
        rules_path.write_text(text, encoding="utf-8")
        st = rules_path.stat()
        os.utime(rules_path, ns=(st.st_atime_ns, st.st_mtime_ns + 2_000_000_000))      # 수정 시각이 확실히 달라지게
        assert c.get(f"{B}/status").json()["state"] == "ok"
        r = c.get(f"{B}/rules")
        assert r.status_code == 200 and len(r.json()) == 23


def test_unchanged_files_are_not_reread() -> None:
    store = real_store()
    first = store.snapshot()
    assert store.snapshot() is first


# ---------------------------------------------------------------- 검증 도구가 없을 때
def test_without_the_checker_the_loader_does_a_minimal_check_and_says_so() -> None:
    store = real_store()
    store._checker_candidates = []                                                   # check_rules.py 를 찾지 못하는 환경
    st = store.status()
    assert st.state == "ok" and st.validation is not None and st.validation.tool == "minimal"
    assert any("검증 도구 없음" in n for n in st.validation.notes)
    assert st.by_grade is not None and st.by_grade["manual"] > 100                    # 등급별 값은 로더가 직접 센다


def test_minimal_check_still_catches_a_broken_reference() -> None:
    with temp_rules(_break_operation) as d:
        store = RulebookStore(d, opms_home=NO_OPMS)
        store._checker_candidates = []
        st = store.status()
        assert st.state == "invalid" and st.validation is not None and st.validation.tool == "minimal"
        assert any("NoSuchOperation" in e.message for e in st.validation.errors)
