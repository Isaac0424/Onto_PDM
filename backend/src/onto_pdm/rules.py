"""가상 회사 "온토전자"의 조립 규칙 (목업). web/src/api/mock/assemblyRules.ts 와 **같은 결과**를 내도록 옮긴 것이다.

실제 회사의 규칙이 아니고 숫자는 시연용이다. 실제로는 OPMS 방식(YAML → 컴파일 → Neo4j)으로 컴파일된 규칙을 읽는다.
같은 결과인지는 tests/unit/test_parity.py 가 웹 목 API 의 결과(tests/fixtures/parity.json)와 비교해 지킨다.
규칙이 걸리는 순서는 두 단계다: ① 분류(class_name)가 있으면 분류와 속성으로, ② 분류를 모르면 이름 패턴으로.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass

from onto_pdm.contracts import (
    AssemblyGuide,
    AssemblyPartInput,
    AssemblyRuleDetail,
    AssemblyRuleSummary,
    GuideParam,
    LabeledValue,
    RuleIssue,
    RuleTable,
    RuleUsedBy,
)

COMPANY = "온토전자 (가상 회사)"

OPERATION_LABEL: dict[str, str] = {
    "fasten": "볼트 체결",
    "weld": "용접",
    "press_fit": "압입",
    "mount": "장착",
    "insert": "삽입",
    "cover": "커버 조립",
}

# 용접 조건표 (가상 값). 얇은 쪽 모재 두께 → 개선 형상 · 필러(용접봉) 지름 · 루트 갭
WELD_TABLE: tuple[tuple[float, str, str, str], ...] = (
    (1.5, "I형 (개선 없음)", "Φ1.0", "0 mm"),
    (3.0, "I형 (개선 없음)", "Φ1.6", "0 ~ 0.5 mm"),
    (6.0, "V형 60°", "Φ2.4", "1 ~ 2 mm"),
    (math.inf, "V형 60° · 다층 용접", "Φ3.2", "2 ~ 3 mm"),
)


def fmt_num(v: float) -> str:
    """JS `+v.toFixed(2)` 를 문자열로 만든 것과 같다 (소수 둘째 자리까지, 끝의 0 은 뗀다)."""
    text = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def mm(v: float) -> str:
    return f"{fmt_num(v)} mm"


def thickness(p: AssemblyPartInput) -> float | None:
    """부품의 두께(mm): 확정된 thickness 속성이 있으면 그 값, 없으면 CAD 크기의 가장 얇은 치수. 모르면 None."""
    raw = (p.attributes or {}).get("thickness")
    try:
        attr = float(raw) if raw is not None and not isinstance(raw, bool) else math.nan
    except (TypeError, ValueError):
        attr = math.nan
    if math.isfinite(attr) and attr > 0:
        return attr
    return min(p.size) if p.size else None


@dataclass(frozen=True)
class Built:
    title: str
    caption: str
    params: list[GuideParam]
    cautions: list[str]
    tools: list[str]


@dataclass(frozen=True)
class RuleDef:
    id: str
    name: str
    operation: str
    applies_to: list[str]
    description: str
    conditions: list[str]
    status: str
    sample: AssemblyPartInput
    match: re.Pattern[str]
    build: Callable[[AssemblyPartInput], Built]
    table: RuleTable | None = None
    classes: tuple[str, ...] = ()
    when: Callable[[AssemblyPartInput], bool] | None = None
    source: str | None = None


def _p(label: str, value: str, ok: bool | None = None) -> GuideParam:
    return GuideParam(label=label, value=value, ok=ok)


def _fas(p: AssemblyPartInput) -> Built:
    return Built(
        title=f"{p.name} 체결",
        caption="대각선 순서로 두 번에 나눠, 0.6 N·m까지 조입니다.",
        params=[_p("체결 토크", "0.6 N·m ±10%"), _p("체결 순서", "대각선, 2회 (50% → 100%)"), _p("나사 규격", "M3")],
        cautions=["나사산이 상하면 폐기하고, 같은 나사를 3번 넘게 다시 쓰지 않습니다.", "토크 드라이버가 교정 기한 안인지 확인합니다."],
        tools=["토크 드라이버 0.2 ~ 1.0 N·m"],
    )


def _cvr(p: AssemblyPartInput) -> Built:
    t = thickness(p)
    need = None if t is None else t + 4.5  # 필요 나사 길이 = 커버 두께 + 체결 깊이(1.5 × 나사 지름 4.5 mm)
    if t is None:
        caption = "접촉면을 닦고, 가스켓이 제자리에 있는지 본 뒤 닫습니다."
        params: list[GuideParam] = []
    else:
        assert need is not None
        caption = f"커버 두께 {mm(t)}: 나사 길이는 {mm(need)} 이상이어야 합니다. 접촉면을 닦고 닫습니다."
        params = [
            _p("커버 두께", mm(t)),
            _p("필요 나사 길이", f"≥ {mm(need)} (두께 + 1.5 × 지름)"),
            _p("사용 나사", "M3 × 12", 12 >= need),
        ]
    return Built(
        title=f"{p.name} 닫기",
        caption=caption,
        params=[*params, _p("체결 순서", "중앙에서 모서리로")],
        cautions=["접촉면의 이물을 닦아 냅니다.", "가스켓이 빠졌거나 말려 들어가지 않았는지 봅니다."],
        tools=["무진 와이퍼", "토크 드라이버"],
    )


def _elc(p: AssemblyPartInput) -> Built:
    return Built(
        title=f"{p.name} 올리기",
        caption="입력 포트가 왼쪽, 출력 포트가 오른쪽으로 오도록 놓습니다.",
        params=[_p("입력 포트 위치", "왼쪽 (−X)"), _p("출력 포트 위치", "오른쪽 (+X)"), _p("지지 스페이서", "4곳 정렬")],
        cautions=["정전기 방지 손목 스트랩을 착용합니다.", "기판은 가장자리만 잡습니다.", "방향이 반대면 케이블이 닿지 않아 불량이 됩니다."],
        tools=["ESD 손목 스트랩", "핀셋"],
    )


def _spc(p: AssemblyPartInput) -> Built:
    return Built(
        title=f"{p.name} 세우기",
        caption="높이가 같은지 확인하고 보스에 세웁니다.",
        params=[_p("높이 허용 편차", "±0.1 mm"), _p("수량", "4개")],
        cautions=["높이 편차가 허용치를 넘으면 기판이 기웁니다. 그 스페이서는 쓰지 않습니다."],
        tools=["버니어 캘리퍼"],
    )


def _bat(p: AssemblyPartInput) -> Built:
    return Built(
        title=f"{p.name} 넣기",
        caption="극성을 확인하고, 금속 공구가 단자에 닿지 않게 넣습니다.",
        params=[_p("극성", "(+)는 케이블 쪽"), _p("장착 시점", "기판 체결 후")],
        cautions=["금속 공구로 단자를 만지지 않습니다. 단락되면 발열합니다.", "부풀었거나 찍힌 배터리는 쓰지 않고 격리합니다."],
        tools=["절연 핀셋"],
    )


def _sw(p: AssemblyPartInput) -> Built:
    return Built(
        title=f"{p.name} 끼우기",
        caption="개구부에 맞춰 위에서 눌러 넣고, 걸림 없이 눌리는지 봅니다.",
        params=[_p("눌림 방향", "+Z (위쪽)"), _p("확인", "걸림 없이 복귀")],
        cautions=["눌렀을 때 걸리면 개구부 버를 확인합니다."],
        tools=[],
    )


def _red(p: AssemblyPartInput) -> Built:
    return Built(
        title=f"{p.name} 장착",
        caption="입력축이 모터 쪽을 향하게 놓고, 대각선 순서로 체결합니다.",
        params=[_p("입력축 방향", "모터 쪽"), _p("체결 순서", "대각선"), _p("그리스", "규정량, 기어면만")],
        cautions=["입력축 방향이 반대면 조립 후 분해해야 합니다.", "그리스가 체결면에 묻지 않게 합니다."],
        tools=["토크 렌치", "그리스 도포기"],
    )


def _mot(p: AssemblyPartInput) -> Built:
    return Built(
        title=f"{p.name} 장착",
        caption="전원 포트는 왼쪽, 엔코더 포트는 오른쪽으로 오게 돌려 끼웁니다.",
        params=[_p("전원 포트 위치", "왼쪽 (−X)"), _p("엔코더 포트 위치", "오른쪽 (+X)"), _p("케이블 여유", "굽힘 반경 이상")],
        cautions=["포트 방향이 바뀌면 케이블이 닿지 않습니다.", "엔코더 케이블을 당기지 않습니다."],
        tools=["토크 드라이버"],
    )


def _hsg(p: AssemblyPartInput) -> Built:
    return Built(
        title=f"{p.name} 맞추기",
        caption="접촉면을 닦고, 위치 핀을 먼저 맞춘 뒤 눌러 붙입니다.",
        params=[_p("정렬", "위치 핀 먼저"), _p("접촉면", "이물 없음")],
        cautions=["접촉면에 흠집이 있으면 사용하지 않습니다."],
        tools=["무진 와이퍼"],
    )


def _wld(p: AssemblyPartInput) -> Built:
    t = thickness(p)
    t = 2.0 if t is None else t
    _, groove, filler, gap = next(r for r in WELD_TABLE if t < r[0])
    return Built(
        title=f"{p.name} 용접",
        caption=f"모재 두께 {mm(t)}: {groove}, 필러 {filler}로 접합합니다.",
        params=[_p("모재 두께", mm(t)), _p("개선 형상", groove), _p("필러(용접봉) 지름", filler), _p("루트 갭", gap)],
        cautions=["가상 값입니다. 실제 용접 조건으로 쓰지 않습니다.", "지그로 고정한 뒤 용접하고, 용접 후 변형을 확인합니다.", "보호구(차광면, 장갑)를 착용합니다."],
        tools=["TIG 용접기", "용접 지그"],
    )


def _prs(p: AssemblyPartInput) -> Built:
    return Built(
        title=f"{p.name} 압입",
        caption="구멍과 중심을 맞춘 뒤, 프레스로 천천히 눌러 넣습니다.",
        params=[_p("끼워맞춤", "H7 / p6 (가상)"), _p("압입 속도", "느리게, 일정하게"), _p("압입력", "상한 이내, 값은 기록")],
        cautions=["중심이 어긋나면 깨질 수 있습니다. 정렬을 먼저 봅니다.", "압입력이 갑자기 오르면 멈추고 불량 처리합니다."],
        tools=["압입 프레스", "로드셀"],
    )


def _weld_table() -> RuleTable:
    rows: list[list[str]] = []
    for i, (up_to, groove, filler, gap) in enumerate(WELD_TABLE):
        label = "< 1.5 mm" if i == 0 else "≥ 6 mm" if up_to == math.inf else f"< {fmt_num(up_to)} mm"
        rows.append([label, groove, filler, gap])
    return RuleTable(title="모재 두께별 용접 조건 (가상 값)", columns=["모재 두께", "개선 형상", "필러 지름", "루트 갭"], rows=rows)


def _fas_when(p: AssemblyPartInput) -> bool:
    raw = (p.attributes or {}).get("threadSize")
    return ("" if raw is None else str(raw)).upper() == "M3" or "M3" in p.name


def _in(name: str, size: tuple[float, float, float] | None = None, class_name: str | None = None,
        attributes: dict[str, str | float | int] | None = None) -> AssemblyPartInput:
    return AssemblyPartInput(name=name, size=size, class_name=class_name, attributes=attributes)


def _rule(id: str, name: str, operation: str, applies_to: list[str], description: str, conditions: list[str], status: str,
          sample: AssemblyPartInput, match: str, build: Callable[[AssemblyPartInput], Built], *, table: RuleTable | None = None,
          classes: tuple[str, ...] = (), when: Callable[[AssemblyPartInput], bool] | None = None) -> RuleDef:
    return RuleDef(id, name, operation, applies_to, description, conditions, status, sample, re.compile(match), build, table, classes, when)


# JS 정규식의 `$` 는 문자열 끝에서만 맞는다 (Python 은 끝의 줄바꿈 앞에서도 맞으므로 \Z 를 쓴다)
RULES: tuple[RuleDef, ...] = (
    _rule("SP-FAS-01", "소형 나사(M3) 체결", "fasten", ["볼트 (나사 규격 M3)"], "M3 나사와 볼트를 조일 때 따르는 토크와 순서.",
          ["분류가 볼트이고 나사 규격(threadSize)이 M3이다", "분류를 모르면: 부품 이름에 나사 또는 볼트와 M3가 있다", "체결 공정"], "approved",
          _in("기판 나사 M3", (3, 3, 8), "볼트", {"threadSize": "M3"}), r"(나사|볼트).*M3|M3.*(나사|볼트)", _fas, classes=("볼트",), when=_fas_when),
    _rule("SP-CVR-01", "커버 조립", "cover", ["커버"], "커버를 닫을 때: 접촉면 청소, 가스켓 확인, 커버 두께로 나사 길이를 정한다.",
          ["분류가 커버이다", "분류를 모르면: 부품 이름이 커버로 끝난다", "커버 두께를 thickness 속성이나 CAD 크기에서 읽을 수 있다"], "approved",
          _in("상부 커버", (126, 80, 3), "커버"), r"커버\Z", _cvr, classes=("커버",)),
    _rule("SP-ELC-01", "제어 기판 장착", "mount", ["제어 기판"], "전자 기판을 올릴 때: 입력 · 출력 포트 방향과 정전기 방지.",
          ["부품 이름이 기판으로 끝난다 (시드 분류에 기판이 없어 이름으로 찾는다)"], "approved", _in("제어 기판"), r"기판\Z", _elc),
    _rule("SP-SPC-01", "스페이서 장착", "mount", ["스페이서"], "기판을 받치는 스페이서의 높이 확인.",
          ["부품 이름에 스페이서가 있다 (시드 분류에 스페이서가 없어 이름으로 찾는다)"], "approved", _in("스페이서"), r"스페이서", _spc),
    _rule("SP-BAT-01", "배터리 장착", "insert", ["배터리"], "배터리의 극성 확인과 단락 방지.",
          ["분류가 배터리이다", "분류를 모르면: 부품 이름에 배터리가 있다"], "approved", _in("배터리", class_name="배터리"), r"배터리", _bat, classes=("배터리",)),
    _rule("SP-SW-01", "버튼 장착", "insert", ["스위치 · 버튼"], "버튼을 개구부에 끼우고 걸림을 확인.",
          ["분류가 스위치 · 버튼이다", "분류를 모르면: 부품 이름에 버튼이 있다"], "approved", _in("전원 버튼", class_name="스위치 · 버튼"), r"버튼", _sw,
          classes=("스위치 · 버튼",)),
    _rule("SP-RED-01", "감속기 장착", "mount", ["감속기"], "감속기를 관절 모듈에 장착할 때: 입력축 방향, 그리스, 체결 순서.",
          ["분류가 감속기이다", "분류를 모르면: 부품 이름에 감속기가 있다"], "approved", _in("J1 감속기", class_name="감속기"), r"감속기", _red, classes=("감속기",)),
    _rule("SP-MOT-01", "서보 모터 장착", "mount", ["서보 모터"], "서보 모터를 장착할 때: 전원 · 엔코더 포트의 방향과 케이블 여유.",
          ["분류가 서보 모터이다", "분류를 모르면: 부품 이름에 모터가 있다"], "approved", _in("서보 모터 400W", class_name="서보 모터"), r"모터", _mot,
          classes=("서보 모터",)),
    _rule("SP-HSG-01", "하우징 조립", "cover", ["하우징"], "하우징을 맞붙일 때: 접촉면 청소와 위치 핀 정렬.",
          ["분류가 하우징이다", "분류를 모르면: 부품 이름이 하우징으로 끝난다"], "approved", _in("J1 하우징", class_name="하우징"), r"하우징\Z", _hsg,
          classes=("하우징",)),
    _rule("SP-WLD-01", "박판 용접 (가상 조건표)", "weld", ["접합 부품 (러그)"], "얇은 쪽 모재 두께에 따라 개선 형상과 필러(용접봉) 지름을 정한다. 가상 조건표.",
          ["접합 방식이 용접이다 (시드 분류에 접합 부품이 없어 이름으로 찾는다)", "얇은 쪽 모재 두께를 thickness 속성이나 CAD 크기에서 읽을 수 있다"], "draft",
          _in("러그", (3, 2.6, 7)), r"러그", _wld, table=_weld_table()),
    _rule("SP-PRS-01", "압입", "press_fit", ["유리 · 크리스털 (압입)"], "구멍과 중심을 맞춘 뒤 프레스로 천천히 눌러 넣는다. 압입력은 기록한다. 가상 값.",
          ["접합 방식이 압입이다 (시드 분류에 유리 · 크리스털이 없어 이름으로 찾는다)"], "draft", _in("사파이어 크리스털"), r"크리스털|유리", _prs),
)

_BY_ID = {r.id: r for r in RULES}
_CHAIN_SPLIT = re.compile(r"\s*[›>/]\s*")


def source_of(rule_id: str) -> str:
    return f"{COMPANY} 조립 표준 {rule_id}"


def class_chain(class_name: str) -> list[str]:
    """분류 사슬: '체결류 › 볼트' 처럼 상위 분류가 함께 들어와도 각 분류 이름으로 나눠 본다."""
    return [c.strip() for c in _CHAIN_SPLIT.split(class_name) if c.strip()]


def rule_applies(rule: RuleDef, part: AssemblyPartInput) -> bool:
    """이 부품에 이 규칙이 걸리는가.

    ① 분류(class_name)가 들어온 부품: 규칙에 분류가 있으면 분류로만 판단한다(분류가 다르면 이름이 비슷해도 걸리지 않는다).
       속성 조건(when)이 있으면 함께 본다.
    ② 분류를 모르거나 분류가 없는 규칙: 이름 패턴으로 찾는다 (이름만 가진 CAD 부품).
    """
    if part.class_name and rule.classes:
        chain = class_chain(part.class_name)
        if not any(c in chain for c in rule.classes):
            return False
        return rule.when(part) if rule.when else True
    return bool(rule.match.search(part.name))


def guide_for(part: AssemblyPartInput) -> AssemblyGuide | None:
    """부품(이름 · 분류 · 속성 · 크기)에 맞는 첫 규칙으로 조립 안내를 만든다. 맞는 규칙이 없으면 None.

    규칙 순서가 우선순위다: 나사는 이름에 '커버'가 들어 있어도 나사 규칙이 먼저다.
    """
    rule = next((r for r in RULES if rule_applies(r, part)), None)
    if rule is None:
        return None
    b = rule.build(part)
    return AssemblyGuide(
        part_name=part.name, rule_id=rule.id, rule_name=rule.name, operation=rule.operation,  # type: ignore[arg-type]
        operation_label=OPERATION_LABEL[rule.operation], source=rule.source or source_of(rule.id),
        title=b.title, caption=b.caption, params=b.params, cautions=b.cautions, tools=b.tools,
    )


def summarize_rules() -> list[AssemblyRuleSummary]:
    out: list[AssemblyRuleSummary] = []
    for r in RULES:
        b = r.build(r.sample)
        out.append(AssemblyRuleSummary(
            id=r.id, name=r.name, operation=r.operation, operation_label=OPERATION_LABEL[r.operation],  # type: ignore[arg-type]
            applies_to=r.applies_to, key_values=[LabeledValue(label=p.label, value=p.value) for p in b.params[:2]],
            caution_count=len(b.cautions), tool_count=len(b.tools), status=r.status,  # type: ignore[arg-type]
            source=source_of(r.id),
        ))
    return out


def describe_rule(rule_id: str, used_by: list[tuple[str, str]]) -> AssemblyRuleDetail | None:
    """규칙 상세. used_by 는 (품번, 이름) — 부르는 쪽(저장소)이 보이는 품목에서 채운다."""
    r = _BY_ID.get(rule_id)
    if r is None:
        return None
    b = r.build(r.sample)
    summary = next(s for s in summarize_rules() if s.id == rule_id)
    return AssemblyRuleDetail(
        **summary.model_dump(), description=r.description, conditions=r.conditions,
        parameters=[LabeledValue(label=p.label, value=p.value) for p in b.params], table=r.table,
        cautions=b.cautions, tools=b.tools, used_by=[RuleUsedBy(item_no=n, name=nm) for n, nm in used_by],
    )


def rule_matches(rule_id: str, name: str) -> bool:
    """이 규칙이 적용되는 부품 이름인가 (이름만으로. 분류와 속성까지 보려면 rule_applies)."""
    r = _BY_ID.get(rule_id)
    return bool(r and rule_applies(r, AssemblyPartInput(name=name)))


def _blank(v: object) -> bool:
    return not isinstance(v, str) or v.strip() == ""


def validate_rule_defs(defs: tuple[RuleDef, ...] | list[RuleDef]) -> list[RuleIssue]:
    """규칙 정의를 점검한다 (PRD F-RUL-6). 웹 `validateRuleDefs` 와 같은 검사 · 같은 문장이다.

    error: 쓸 수 없는 규칙(값이 비었음 · 출처 없음 · 조건표가 깨짐 · 적용 대상 없음)
    warning: 쓸 수는 있지만 확인할 것(주의사항 없음 · 다른 규칙과 겹침 · 검토 전 · 대표 부품에도 안 걸림)
    """
    issues: list[RuleIssue] = []

    def add(severity: str, r: RuleDef, code: str, message: str) -> None:
        issues.append(RuleIssue(severity=severity, rule_id=r.id, code=code, message=message))  # type: ignore[arg-type]

    for r in defs:
        if not [a for a in r.applies_to if not _blank(a)]:
            add("error", r, "no_scope", "적용 대상(분류 · 부품 종류)이 비어 있습니다.")
        if not [c for c in r.conditions if not _blank(c)]:
            add("error", r, "missing_value", "적용 조건이 비어 있어 언제 걸리는지 알 수 없습니다.")
        if _blank(r.source if r.source is not None else source_of(r.id)):
            add("error", r, "no_source", "출처 문서가 없습니다. 어느 표준에서 온 규칙인지 적어야 합니다.")

        g = r.build(r.sample)
        empty_param = next((p for p in g.params if _blank(p.label) or _blank(p.value)), None)
        if not g.params:
            add("error", r, "missing_value", "값이 하나도 없습니다.")
        elif empty_param is not None:
            add("error", r, "missing_value", f"값이 비어 있습니다: {'(이름 없음)' if _blank(empty_param.label) else empty_param.label}")
        if not g.cautions:
            add("warning", r, "no_caution", "주의사항이 없습니다. 작업자가 확인할 것이 정말 없는지 검토하세요.")

        if r.table is not None:
            columns, rows = r.table.columns, r.table.rows
            if not rows:
                add("error", r, "empty_table", f'조건표 "{r.table.title}"에 행이 없습니다.')
            elif any(len(row) != len(columns) for row in rows):
                add("error", r, "empty_table", f'조건표 "{r.table.title}"의 열 수가 맞지 않는 행이 있습니다.')
            elif any(_blank(c) for row in rows for c in row):
                add("error", r, "missing_value", f'조건표 "{r.table.title}"에 빈 칸이 있습니다.')

        if r.status == "draft":
            add("warning", r, "no_source", "검토 전 규칙(가상 값)입니다. 승인된 출처 문서가 없어 실제 작업에 쓰면 안 됩니다.")
        if not rule_applies(r, r.sample):
            add("warning", r, "unused", f'대표 부품 "{r.sample.name}"에도 걸리지 않습니다. 분류 · 이름 조건을 확인하세요.')

    # 겹침: 한 규칙의 대표 부품에 다른 규칙도 걸리면 어느 쪽이 쓰일지 순서에 달려 있다
    defs = list(defs)
    for i in range(len(defs)):
        for j in range(i + 1, len(defs)):
            a, b = defs[i], defs[j]
            if rule_applies(b, a.sample):
                add("warning", a, "overlap", f'{a.id}의 대표 부품 "{a.sample.name}"에 {b.id}도 걸립니다. 순서가 앞선 {a.id}가 쓰입니다.')
            elif rule_applies(a, b.sample):
                add("warning", b, "overlap", f'{b.id}의 대표 부품 "{b.sample.name}"에 {a.id}도 걸립니다. 순서가 앞선 {a.id}가 쓰입니다.')
    return issues


def validate_rules() -> list[RuleIssue]:
    """지금 정의된 규칙 전체의 검증 결과."""
    return validate_rule_defs(RULES)
