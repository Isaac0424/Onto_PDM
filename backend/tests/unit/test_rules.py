"""조립 규칙: 웹 시험(web/src/api/mock/mockApi.test.ts · assemblyRules.test.ts)과 같은 값을 직접 확인한다.

패리티 시험(test_parity.py)이 웹 구현과의 일치를 지키고, 이 시험은 규칙의 핵심 의미를 사람이 읽을 수 있게 고정한다.
"""

from __future__ import annotations

from onto_pdm import rules
from onto_pdm.contracts import AssemblyPartInput, GuideParam


def guide(name: str, **kw: object):  # type: ignore[no-untyped-def]
    return rules.guide_for(AssemblyPartInput(name=name, **kw))  # type: ignore[arg-type]


def test_screw_has_torque_and_sequence_and_cover_computes_screw_length_from_thickness() -> None:
    screw = guide("기판 나사 M3", size=(3, 3, 8))
    assert screw is not None and (screw.rule_id, screw.operation_label) == ("SP-FAS-01", "볼트 체결")
    assert GuideParam(label="체결 토크", value="0.6 N·m ±10%") in screw.params

    cover = guide("상부 커버", size=(126, 80, 3))
    assert cover is not None and cover.rule_id == "SP-CVR-01"
    assert GuideParam(label="필요 나사 길이", value="≥ 7.5 mm (두께 + 1.5 × 지름)") in cover.params
    assert GuideParam(label="사용 나사", value="M3 × 12", ok=True) in cover.params           # 12 ≥ 3 + 4.5


def test_weld_conditions_follow_base_metal_thickness() -> None:
    def row(size: tuple[float, float, float]) -> dict[str, str]:
        g = guide("러그", size=size)
        assert g is not None
        return {p.label: p.value for p in g.params}

    assert row((3, 2.6, 7))["개선 형상"] == "I형 (개선 없음)" and row((3, 2.6, 7))["필러(용접봉) 지름"] == "Φ1.6"
    assert row((20, 5, 30))["개선 형상"] == "V형 60°" and row((20, 5, 30))["필러(용접봉) 지름"] == "Φ2.4"
    assert row((20, 8, 30))["개선 형상"] == "V형 60° · 다층 용접" and row((20, 8, 30))["필러(용접봉) 지름"] == "Φ3.2"
    assert row((20, 1.2, 30))["필러(용접봉) 지름"] == "Φ1.0"
    thin = guide("러그", size=(3, 2.6, 7))
    assert thin is not None and thin.cautions[0].startswith("가상 값입니다")               # 가상 값임을 숨기지 않는다


def test_rules_attach_to_class_and_attributes_before_name() -> None:
    # 분류 + 속성: 이름이 달라도 걸린다
    g = guide("육각 렌치 볼트", class_name="체결류 › 볼트", attributes={"threadSize": "m3"})
    assert g is not None and g.rule_id == "SP-FAS-01"
    # 분류가 볼트여도 나사 규격이 M4 면 M3 규칙이 아니다
    assert guide("육각 렌치 볼트", class_name="볼트", attributes={"threadSize": "M4"}) is None
    # 분류가 다르면 이름이 비슷해도 걸리지 않는다
    assert guide("모터 커버", class_name="서보 모터").rule_id == "SP-MOT-01"            # type: ignore[union-attr]
    # 분류를 모르면 이름으로 (CAD 부품)
    assert guide("모터 커버").rule_id == "SP-CVR-01"                                     # type: ignore[union-attr]  # 이름이 커버로 끝나고 커버 규칙이 모터 규칙보다 앞


def test_thickness_attribute_wins_over_cad_size_and_zero_is_ignored() -> None:
    def need(attrs: dict[str, str | float | int] | None) -> str:
        g = guide("덮개", class_name="커버", size=(100, 60, 2), attributes=attrs)
        assert g is not None
        return next(p.value for p in g.params if p.label == "필요 나사 길이")

    assert need(None) == "≥ 6.5 mm (두께 + 1.5 × 지름)"                                     # CAD 크기 2 mm
    assert need({"thickness": 4}) == "≥ 8.5 mm (두께 + 1.5 × 지름)"
    assert need({"thickness": "5.5"}) == "≥ 10 mm (두께 + 1.5 × 지름)"
    assert need({"thickness": 0}) == "≥ 6.5 mm (두께 + 1.5 × 지름)"                        # 0 은 확정값이 아니다


def test_list_and_detail() -> None:
    summaries = rules.summarize_rules()
    assert len(summaries) == 11
    assert sum(1 for s in summaries if s.status == "approved") == 9 and sum(1 for s in summaries if s.status == "draft") == 2
    assert all(len(s.key_values) == 2 for s in summaries)
    weld = rules.describe_rule("SP-WLD-01", [])
    assert weld is not None and weld.table is not None and len(weld.table.rows) == 4
    assert weld.table.rows[0][0] == "< 1.5 mm" and weld.table.rows[-1][0] == "≥ 6 mm"
    assert rules.describe_rule("SP-NOPE", []) is None


def test_validation_finds_broken_definitions_and_overlaps() -> None:
    issues = rules.validate_rules()
    assert {i.code for i in issues} >= {"no_source"}                                    # 검토 전 규칙 경고
    assert all(i.rule_id for i in issues)

    import dataclasses

    broken = dataclasses.replace(rules.RULES[0], applies_to=[], conditions=[" "], source=" ")
    codes = {i.code for i in rules.validate_rule_defs([broken])}
    assert {"no_scope", "missing_value", "no_source"} <= codes
    bad_table = dataclasses.replace(rules.RULES[-2], table=rules.RuleTable(title="t", columns=["a", "b"], rows=[["1"]]))
    assert any(i.code == "empty_table" for i in rules.validate_rule_defs([bad_table]))
