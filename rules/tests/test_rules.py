"""rules/ 시험: 검증 스크립트(tools/check_rules.py)가 실제 파일을 통과시키고, 일부러 깨뜨린 사본은 잡아내는지 본다.

실행(저장소 루트):  backend/.venv/Scripts/python.exe -m pytest rules/tests -q -p no:cacheprovider
OPMS PDM 브랜치 경로가 없으면 OPMS 분류 이름 대조 시험만 건너뛴다. OPMS 저장소는 읽기만 한다.
"""

from __future__ import annotations

import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import check_rules as cr  # noqa: E402


@pytest.fixture(scope="module")
def data():
    return cr.load_all(REPO / "rules")


@pytest.fixture(scope="module")
def opms_classes():
    classes, _ = cr.load_opms_classes()
    return classes


def run(data, opms=None) -> cr.Report:
    return cr.Checker(copy.deepcopy(data), opms).run()


def messages(report: cr.Report) -> str:
    return "\n".join(f"{f.where}: {f.message}" for f in report.errors)


# ------------------------------------------------------------------ 실제 파일
def test_real_rules_have_no_errors(data, opms_classes):
    report = run(data, opms_classes)
    assert report.errors == [], messages(report)


def test_every_value_has_a_grade_and_standard_is_unused(data):
    report = run(data)
    grades = report.by_grade()
    assert grades["manual"] > 100                                  # 사용설명서에서 확정한 값이 대부분이다
    assert grades["cad"] > 0 and grades["unknown"] > 0
    assert grades["standard"] == 0                                 # 확인할 표준 원문이 없어 표준값을 만들지 않았다(G-016)


def test_counts_match_the_documented_scope(data):
    c = run(data).counts
    assert c["rules"] == 23 and c["work_standards"] == 10 and c["tools"] == 3
    assert c["inspection_items"] == 8                              # 사용설명서 15.1 표는 8행이다
    assert c["gaps"] == 19


def test_no_invented_welding_or_press_fit(data):
    # 근거가 없는 공정은 operations 에 없고 not_covered 에만 이유와 함께 있다
    assert "Welding" not in data["operations"]["operations"] and "PressFit" not in data["operations"]["operations"]
    assert {"Welding", "PressFit"} <= set(data["operations"]["not_covered"])
    for rule in data["rules"]["assembly_rules"].values():
        assert rule["operation"] not in ("Welding", "PressFit")


def test_all_rules_are_unreviewed_drafts(data):
    assert {r["status"] for r in data["rules"]["assembly_rules"].values()} == {"unreviewed"}
    assert {w["status"] for w in data["work-standards"]["work_standards"].values()} == {"unreviewed"}


def test_standard_time_is_empty_everywhere(data):
    for wid, ws in data["work-standards"]["work_standards"].items():
        assert ws["standard_time"]["value"] is None and ws["standard_time"]["source"] == "unknown", wid


# ------------------------------------------------------------------ 매뉴얼에서 확정한 수치
MANUAL_TORQUE = {
    "HCR-3A": ("M6", 15, 30, 5),
    "HCR-5A": ("M8", 15, 45, 8),
    "HCR-12A": ("M12", 25, 140, 5),
}


def test_robot_base_bolt_table_matches_the_manual(data):
    """사용설명서 3.3 (KR/EN V2.2 쪽 49) 표: 로봇 종류별 볼트 · 토크 · 위치 결정 핀."""
    rule = data["rules"]["assembly_rules"]["AR-FAS-001"]
    table = rule["lookup"]["table"]
    for model, (thread, length, torque, pin) in MANUAL_TORQUE.items():
        row = table[model]
        assert (row["threadSize"], row["length_mm"], row["torque_nm"], row["pin_diameter_mm"]) == (thread, length, torque, pin), model
        assert row["source"] == "manual" and row["ref"]["doc"] == "UG-KR" and row["ref"]["page"] == 49
    assert rule["parameters"]["quantity"]["value"] == 4
    pins = data["rules"]["assembly_rules"]["AR-LOC-001"]["lookup"]["table"]
    assert {m: pins[m]["pin_diameter_mm"] for m in pins} == {m: v[3] for m, v in MANUAL_TORQUE.items()}


def test_work_standard_text_repeats_the_same_numbers_as_the_rule(data):
    rule = data["rules"]["assembly_rules"]["AR-FAS-001"]["lookup"]["table"]
    step = data["work-standards"]["work_standards"]["WS-HCR-INS-02"]["steps"][2]
    for model, row in rule.items():
        frag = f"{model} {row['threadSize']}×{row['length_mm']} mm {row['torque_nm']} N·m"
        assert frag in step["text"], f"단계 문장이 규칙과 다르다: {frag}"
    assert step["rules"] == ["AR-FAS-001"]


def test_same_thread_size_does_not_share_a_torque_across_roles(data):
    """M6 는 로봇 고정(30 N·m, 3A)에도 툴 고정에도 쓰이지만 토크 근거는 로봇 고정에만 있다. 역할(role)로 나뉘어 있어야 한다."""
    rules = data["rules"]["assembly_rules"]
    tool = rules["AR-FAS-004"]
    assert tool["applies_to"]["context"]["role"] == "tool_mount"
    assert tool["parameters"]["torque_nm"]["value"] is None and tool["parameters"]["torque_nm"]["source"] == "unknown"
    assert rules["AR-FAS-001"]["applies_to"]["context"]["role"] == "robot_base_mount"


def test_inspection_table_has_the_eight_manual_rows(data):
    items = data["work-standards"]["work_standards"]["WS-HCR-MNT-01"]["inspection_items"]
    assert [i["target"] for i in items] == ["전체", "전체", "전체", "주요 볼트", "모터", "케이블", "내부", "필터"]
    cycles = [(i["cycle"]["value"], i["cycle"]["unit"]) for i in items]
    assert cycles == [(1, "일"), (3, "개월"), (1, "일"), (3, "개월"), (1, "일"), (6, "개월"), (6, "개월"), (6, "개월")]
    assert all(i["ref"]["page"] == 229 for i in items)


def test_cad_quantities_match_the_cad_bom_totals(data):
    """12A 의 CAD 구조 수량 합계가 STEP 에서 센 총 수량(21 · 12 · 23 · 18 · 20)과 같다."""
    asm = data["work-standards"]["work_standards"]["WS-HCR12A-ASM-01"]["assemblies"]
    total: dict[str, int] = {}
    for a in asm:
        for p in a["parts"]:
            if p["cad_name"].startswith("BOLT-"):
                total[p["cad_name"]] = total.get(p["cad_name"], 0) + p["quantity"]
    assert total == {"BOLT-M4X25": 20, "BOLT-M4X15": 18, "BOLT-M3X8": 12, "BOLT-M4": 23, "BOLT-M3X15": 21}
    five = data["work-standards"]["work_standards"]["WS-HCR3A5A-ASM-01"]["assemblies"]
    qty = {(a["model"], p["cad_name"]): p["quantity"] for a in five for p in a["parts"]}
    assert qty[("HCR-3A", "HCR_COVER_BOLT_1")] == 9 and qty[("HCR-5A", "HCR_COVER_BOLT_1")] == 16
    assert qty[("HCR-3A", "HCR3A_BASE_COVER_BOLT_1")] == 4


def test_structure_only_documents_have_no_procedure(data):
    for wid in ("WS-HCR12A-ASM-01", "WS-HCR3A5A-ASM-01"):
        ws = data["work-standards"]["work_standards"][wid]
        assert ws["steps"] == [] and ws["procedure_gap"] == "G-005"


# ------------------------------------------------------------------ OPMS 분류 이름
@pytest.mark.skipif(cr.load_opms_classes()[0] is None, reason="OPMS PDM 브랜치 경로가 없다")
def test_classes_exist_in_opms(data, opms_classes):
    used: set[str] = set()
    for rule in data["rules"]["assembly_rules"].values():
        used |= set(rule["applies_to"].get("classes") or [])
    assert used and used <= opms_classes                           # Bolt · FlatWasher · SocketHeadBolt …
    # 이번 파일에는 OPMS 에 없는 분류(제안)를 쓰지 않았다
    assert not any(rule["applies_to"].get("proposed_classes") for rule in data["rules"]["assembly_rules"].values())


def test_unknown_opms_class_is_an_error(data):
    bad = copy.deepcopy(data)
    bad["rules"]["assembly_rules"]["AR-FAS-001"]["applies_to"]["classes"] = ["NoSuchBolt"]
    report = run(bad, {"Bolt", "SocketHeadBolt", "FlatWasher"})
    assert "NoSuchBolt" in messages(report) and "proposed_classes" in messages(report)


def test_proposed_class_already_in_opms_is_a_warning(data):
    bad = copy.deepcopy(data)
    bad["rules"]["assembly_rules"]["AR-FAS-006"]["applies_to"]["proposed_classes"] = ["Bolt"]
    report = run(bad, {"Bolt", "SocketHeadBolt", "FlatWasher"})
    assert any("proposed_classes" in w.message for w in report.warnings)


# ------------------------------------------------------------------ 일부러 깨뜨린 사본은 잡아낸다
def broken(data, edit):
    bad = copy.deepcopy(data)
    edit(bad)
    return run(bad)


def test_manual_item_without_page_is_an_error(data):
    def edit(d):
        del d["rules"]["assembly_rules"]["AR-FAS-001"]["lookup"]["table"]["HCR-3A"]["ref"]["page"]
    assert "ref.page" in messages(broken(data, edit))


def test_manual_item_without_ref_is_an_error(data):
    def edit(d):
        del d["rules"]["assembly_rules"]["AR-SIT-001"]["cautions"][0]["ref"]
    assert "ref" in messages(broken(data, edit))


def test_page_beyond_the_document_is_an_error(data):
    def edit(d):
        d["rules"]["assembly_rules"]["AR-SIT-001"]["cautions"][0]["ref"]["page"] = 999
    assert "쪽수" in messages(broken(data, edit))


def test_unknown_item_with_a_value_is_an_error(data):
    def edit(d):
        d["rules"]["assembly_rules"]["AR-FAS-004"]["parameters"]["torque_nm"]["value"] = 9.5      # 지어낸 값
    assert "지어낸" in messages(broken(data, edit)) or "비어 있지 않다" in messages(broken(data, edit))


def test_unknown_item_without_gap_is_an_error(data):
    def edit(d):
        del d["rules"]["assembly_rules"]["AR-FAS-004"]["parameters"]["torque_nm"]["gap"]
    assert "gap" in messages(broken(data, edit))


def test_undefined_gap_is_an_error(data):
    def edit(d):
        d["rules"]["assembly_rules"]["AR-FAS-004"]["parameters"]["torque_nm"]["gap"] = "G-999"
    assert "G-999" in messages(broken(data, edit))


def test_missing_source_grade_is_an_error(data):
    def edit(d):
        del d["rules"]["assembly_rules"]["AR-SIT-001"]["cautions"][0]["source"]
    assert "source" in messages(broken(data, edit))


def test_standard_grade_needs_a_standard_number_and_approval_flag(data):
    def edit(d):
        d["rules"]["assembly_rules"]["AR-FAS-006"]["parameters"]["torque_nm"] = {"value": 1.2, "unit": "N·m", "source": "standard"}
    msg = messages(broken(data, edit))
    assert "ref.standard" in msg and "approval_required" in msg


def test_undefined_operation_tool_or_rule_references_are_errors(data):
    def edit(d):
        d["rules"]["assembly_rules"]["AR-FAS-001"]["operation"] = "Welding"
        d["rules"]["assembly_rules"]["AR-FAS-001"]["tools"] = ["TL-NOPE"]
        d["work-standards"]["work_standards"]["WS-HCR-INS-02"]["rules"].append("AR-NOPE-999")
    msg = messages(broken(data, edit))
    assert "Welding" in msg and "TL-NOPE" in msg and "AR-NOPE-999" in msg


def test_step_numbers_must_be_consecutive(data):
    def edit(d):
        d["work-standards"]["work_standards"]["WS-HCR-INS-02"]["steps"][1]["seq"] = 7
    assert "이어지지 않는다" in messages(broken(data, edit))


def test_standard_time_must_stay_empty(data):
    def edit(d):
        d["work-standards"]["work_standards"]["WS-HCR-INS-02"]["standard_time"] = {"value": 12, "unit": "min", "source": "manual"}
    assert "standard_time" in messages(broken(data, edit))


def test_unknown_role_and_model_are_errors(data):
    def edit(d):
        d["rules"]["assembly_rules"]["AR-FAS-001"]["applies_to"]["context"] = {"role": "nope", "model": ["HCR-99"]}
    msg = messages(broken(data, edit))
    assert "nope" in msg and "HCR-99" in msg


def test_structure_only_document_cannot_carry_invented_steps(data):
    def edit(d):
        d["work-standards"]["work_standards"]["WS-HCR12A-ASM-01"]["steps"] = [
            {"seq": 1, "operation": "BoltFastening", "text": "대각선 순서로 조인다", "source": "unknown", "gap": "G-005"}]
    assert "절차" in messages(broken(data, edit))


def test_bad_caution_level_is_an_error(data):
    def edit(d):
        d["rules"]["assembly_rules"]["AR-SIT-001"]["cautions"][0]["level"] = "아무말"
    assert "level" in messages(broken(data, edit))


def test_unused_gap_warns(data):
    bad = copy.deepcopy(data)
    bad["gaps"]["gaps"]["G-900"] = {"title": "t", "needs": "n", "why": "w", "who": "x", "blocks": []}
    report = run(bad)
    assert any("G-900" in w.where for w in report.warnings)


# ------------------------------------------------------------------ 명령줄
def test_cli_exit_code_and_json():
    proc = subprocess.run(
        [sys.executable, str(REPO / "tools" / "check_rules.py"), "--json"], capture_output=True, text=True, encoding="utf-8", check=False,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    out = json.loads(proc.stdout)
    assert out["errors"] == [] and out["counts"]["rules"] == 23 and out["by_grade"]["standard"] == 0


def test_cli_fails_on_a_broken_copy():
    import shutil
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:                      # pytest 의 tmp_path 는 이 PC(한글 사용자 폴더)에서 권한 오류가 난다
        copy_dir = Path(tmp) / "rules"
        shutil.copytree(REPO / "rules", copy_dir, ignore=shutil.ignore_patterns("tests", "__pycache__"))
        gaps = copy_dir / "gaps.yaml"
        gaps.write_text(gaps.read_text(encoding="utf-8").replace("  G-003:", "  G-903:"), encoding="utf-8")   # 참조되는 공백 번호를 바꿔 깨뜨린다
        proc = subprocess.run(
            [sys.executable, str(REPO / "tools" / "check_rules.py"), "--rules-dir", str(copy_dir)],
            capture_output=True, text=True, encoding="utf-8", check=False,
        )
    assert proc.returncode == 1 and "G-003" in proc.stdout
