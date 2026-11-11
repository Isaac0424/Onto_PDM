"""rules/ 의 조립 규칙 · 작업표준서 검증 (backend 와 무관한 독립 스크립트, PyYAML 만 필요).

    python tools/check_rules.py            # 사람이 읽는 보고서. 오류가 있으면 종료 코드 1
    python tools/check_rules.py --json     # 같은 내용을 JSON 으로

검사하는 것 (docs/work-standards.md 4장):
  * 구조: 필수 필드, 번호 형식, 참조 무결성(규칙 → 공정 · 공구 · 공백, 작업표준 → 규칙 · 공정 · 공구)
  * 출처 등급: 모든 값에 source(manual · standard · cad · unknown)가 있다
      - manual   : 출처 문서 · 쪽 번호가 있고, 쪽이 문서 쪽수 안이다
      - cad      : 출처 문서(CAD · 파생 자료)가 있다
      - standard : 표준 번호와 `approval_required: true` 가 있다
      - unknown  : 값이 비어 있고(value: null) gap 번호가 gaps.yaml 에 있다
  * 작업 시간(standard_time)은 근거가 없으므로 비어 있어야 한다
  * OPMS 분류 이름은 OPMS PDM 브랜치 ontology/classes.yaml 에 있어야 한다(없는 것은 proposed_classes). OPMS 경로가 없으면 건너뛰고 경고한다.
    OPMS 저장소는 읽기만 한다.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

REPO = Path(__file__).resolve().parents[1]
RULES_DIR = REPO / "rules"
GRADES = ("manual", "standard", "cad", "unknown")
LEVELS = ("위험", "경고", "주의", "참고", "안내")     # 안내 = 안전 표시 없이 본문에 적힌 지시
STATUSES = ("unreviewed", "approved")
MODELS = ("HCR-3A", "HCR-5A", "HCR-12A")
FILES = ("sources", "operations", "tools", "rules", "gaps", "work-standards")


@dataclass
class Finding:
    level: str          # error | warning
    where: str
    message: str


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)
    stats: Counter = field(default_factory=Counter)             # "<종류>:<등급>" → 개수
    counts: dict[str, int] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def error(self, where: str, message: str) -> None:
        self.findings.append(Finding("error", where, message))

    def warn(self, where: str, message: str) -> None:
        self.findings.append(Finding("warning", where, message))

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.level == "error"]

    @property
    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.level == "warning"]

    def by_grade(self) -> dict[str, int]:
        out = {g: 0 for g in GRADES}
        for key, n in self.stats.items():
            out[key.split(":", 1)[1]] += n
        return out


# ---------------------------------------------------------------- 읽기
def load_all(rules_dir: Path = RULES_DIR) -> dict[str, Any]:
    data: dict[str, Any] = {}
    for name in FILES:
        path = rules_dir / f"{name}.yaml"
        with path.open(encoding="utf-8") as f:
            data[name] = yaml.safe_load(f)
    return data


def opms_home() -> Path:
    env = os.environ.get("OPMS_HOME")
    if env:
        return Path(env)
    local_env = REPO / ".env"
    if local_env.exists():
        for line in local_env.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("OPMS_HOME="):
                return Path(line.split("=", 1)[1].strip().strip("'\""))
    return Path("D:/ernest_hemingway_OPMS")


def load_opms_classes(home: Path | None = None) -> tuple[set[str] | None, str | None]:
    """OPMS PDM 브랜치의 분류 이름. (없으면 None, 메시지). 읽기만 한다."""
    home = home or opms_home()
    path = home / "ontology" / "classes.yaml"
    if not path.exists():
        return None, f"OPMS 분류 파일이 없다({path}) — 분류 이름 검사를 건너뛴다"
    with path.open(encoding="utf-8") as f:
        classes = (yaml.safe_load(f) or {}).get("classes") or {}
    note = None
    try:
        branch = subprocess.run(
            ["git", "-C", str(home), "branch", "--show-current"], capture_output=True, text=True, timeout=10, check=False,
        ).stdout.strip()
        if branch and branch != "PDM":
            note = f"OPMS 저장소의 현재 브랜치가 PDM 이 아니다({branch}) — 연동 기준은 PDM 브랜치"
    except (OSError, subprocess.SubprocessError):
        pass
    return set(classes), note


# ---------------------------------------------------------------- 검사
class Checker:
    def __init__(self, data: dict[str, Any], opms_classes: set[str] | None = None) -> None:
        self.d = data
        self.opms = opms_classes
        self.r = Report()
        src = data["sources"] or {}
        self.docs: dict[str, dict] = src.get("documents") or {}
        self.ops: dict[str, dict] = (data["operations"] or {}).get("operations") or {}
        self.not_covered: dict[str, dict] = (data["operations"] or {}).get("not_covered") or {}
        self.tools: dict[str, dict] = (data["tools"] or {}).get("tools") or {}
        self.rules: dict[str, dict] = (data["rules"] or {}).get("assembly_rules") or {}
        self.roles: dict[str, str] = (data["rules"] or {}).get("roles") or {}
        self.gaps: dict[str, dict] = (data["gaps"] or {}).get("gaps") or {}
        self.ws: dict[str, dict] = (data["work-standards"] or {}).get("work_standards") or {}
        self.gap_refs: set[str] = set()

    # --- 공통: 출처가 있는 값 하나
    def valued(self, where: str, item: Any, kind: str, *, content_keys: tuple[str, ...] = ("text", "value"), need_content: bool = True) -> None:
        r = self.r
        if not isinstance(item, dict):
            r.error(where, "출처가 있는 항목은 매핑이어야 한다")
            return
        source = item.get("source")
        if source not in GRADES:
            r.error(where, f"source 가 없거나 등급이 아니다({source!r}; {', '.join(GRADES)})")
            return
        r.stats[f"{kind}:{source}"] += 1
        has_content = any(k in item for k in content_keys) or any(
            k not in ("source", "ref", "gap", "note", "estimated", "level", "level_note", "condition", "cycle_note", "inferred", "operation", "rules", "seq", "approval_required")
            for k in item
        )
        if need_content and not has_content:
            r.error(where, "내용(text · value 등)이 없다")
        if source == "manual":
            self._ref_manual(where, item.get("ref"))
        elif source == "cad":
            self._ref_cad(where, item.get("ref"))
        elif source == "standard":
            refs = self._refs(item.get("ref"))
            if not any(isinstance(x, dict) and x.get("standard") for x in refs):
                r.error(where, "standard 는 ref.standard(표준 번호)가 필요하다")
            if item.get("approval_required") is not True:
                r.error(where, "standard 는 approval_required: true(설계 승인 전 사용 금지)가 필요하다")
        else:  # unknown
            for k in ("value", "values", "text"):
                if item.get(k) not in (None, "", []):
                    r.error(where, f"source: unknown 인데 {k} 가 비어 있지 않다 — 값을 지어내지 않는다")
            self._gap(where, item.get("gap"))

    @staticmethod
    def _refs(ref: Any) -> list[Any]:
        if ref is None:
            return []
        return ref if isinstance(ref, list) else [ref]

    def _ref_manual(self, where: str, ref: Any) -> None:
        refs = self._refs(ref)
        if not refs:
            self.r.error(where, "source: manual 인데 ref(문서 · 절 · 쪽)가 없다")
            return
        for one in refs:
            if not isinstance(one, dict) or one.get("doc") not in self.docs:
                self.r.error(where, f"ref.doc 가 sources.yaml 에 없다({one!r})")
                continue
            doc = self.docs[one["doc"]]
            if doc.get("kind") != "manual":
                self.r.error(where, f"manual 의 ref.doc 는 사용설명서여야 한다({one['doc']})")
            page = one.get("page")
            pages = page if isinstance(page, list) else [page]
            if page is None or not all(isinstance(p, int) and p >= 1 for p in pages):
                self.r.error(where, f"manual 은 ref.page(쪽 번호 정수 또는 목록)가 필요하다({page!r})")
                continue
            if doc.get("pages") and any(p > doc["pages"] for p in pages):
                self.r.error(where, f"쪽 번호가 문서 쪽수({doc['pages']})를 넘는다({pages})")
            if not one.get("sec"):
                self.r.warn(where, "ref.sec(절 번호)가 없다")

    def _ref_cad(self, where: str, ref: Any) -> None:
        refs = self._refs(ref)
        if not refs:
            self.r.error(where, "source: cad 인데 ref(CAD 출처 문서)가 없다")
            return
        for one in refs:
            if not isinstance(one, dict) or one.get("doc") not in self.docs:
                self.r.error(where, f"ref.doc 가 sources.yaml 에 없다({one!r})")
                continue
            if self.docs[one["doc"]].get("kind") not in ("cad", "derived"):
                self.r.error(where, f"cad 의 ref.doc 는 CAD · 파생 자료여야 한다({one['doc']})")
            if not (one.get("node") or one.get("note")):
                self.r.warn(where, "cad ref 에 node(CAD 부품 이름) 또는 note 가 없다")

    def _gap(self, where: str, gap: Any) -> None:
        if not gap:
            self.r.error(where, "source: unknown 은 gap(gaps.yaml 번호)이 필요하다")
            return
        self.gap_refs.add(gap)
        if gap not in self.gaps:
            self.r.error(where, f"gap {gap} 이 gaps.yaml 에 없다")

    # --- 문서별
    def check_sources(self) -> None:
        grades = (self.d["sources"] or {}).get("grades") or {}
        if set(grades) != set(GRADES):
            self.r.error("sources.grades", f"등급은 {GRADES} 여야 한다({sorted(grades)})")
        if not self.docs:
            self.r.error("sources.documents", "출처 문서가 없다")
        for k, doc in self.docs.items():
            if not doc.get("title") or doc.get("kind") not in ("manual", "cad", "derived", "opms"):
                self.r.error(f"sources.documents.{k}", "title · kind(manual · cad · derived · opms)가 필요하다")

    def check_operations(self) -> None:
        for code, op in self.ops.items():
            where = f"operations.{code}"
            if not (op.get("label") or {}).get("ko"):
                self.r.error(where, "label.ko 가 없다")
            if not op.get("definition"):
                self.r.error(where, "definition 이 없다")
            parent = op.get("parent")
            if parent and parent not in self.ops:
                self.r.error(where, f"parent {parent} 가 없다")
            self.valued(where, op, "operation", content_keys=("definition",))
            seen, cur = {code}, parent
            while cur:
                if cur in seen:
                    self.r.error(where, "parent 가 순환한다")
                    break
                seen.add(cur)
                cur = (self.ops.get(cur) or {}).get("parent")
        for code, nc in self.not_covered.items():
            where = f"operations.not_covered.{code}"
            if code in self.ops:
                self.r.error(where, "근거가 없는 공정이 operations 에도 있다")
            if nc.get("source") != "unknown":
                self.r.error(where, "not_covered 는 source: unknown 이어야 한다")
            self._gap(where, nc.get("gap"))
            if not nc.get("reason"):
                self.r.error(where, "reason 이 없다")

    def check_tools(self) -> None:
        for tid, tool in self.tools.items():
            where = f"tools.{tid}"
            if not (tool.get("name") or {}).get("ko"):
                self.r.error(where, "name.ko 가 없다")
            self.valued(f"{where}.need", tool.get("need"), "tool_need")
            for name, spec in (tool.get("spec") or {}).items():
                if name == "note":
                    continue
                self.valued(f"{where}.spec.{name}", spec, "tool_spec", need_content=False)

    def _class_names(self, where: str, names: Any, *, proposed: bool) -> None:
        for name in names or []:
            if self.opms is None:
                continue
            if proposed and name in self.opms:
                self.r.warn(where, f"proposed_classes 의 {name} 은 이미 OPMS 에 있다 — classes 로 옮긴다")
            if not proposed and name not in self.opms:
                self.r.error(where, f"분류 {name} 이 OPMS PDM 브랜치 classes.yaml 에 없다 — 없으면 proposed_classes 로 쓴다")

    def check_applies_to(self, where: str, ap: Any) -> None:
        if not isinstance(ap, dict):
            self.r.error(where, "applies_to 가 필요하다")
            return
        if not (ap.get("classes") or ap.get("proposed_classes") or ap.get("context")):
            self.r.error(where, "applies_to 에 classes · proposed_classes · context 중 하나는 있어야 한다")
        self._class_names(f"{where}.classes", ap.get("classes"), proposed=False)
        self._class_names(f"{where}.proposed_classes", ap.get("proposed_classes"), proposed=True)
        ctx = ap.get("context") or {}
        role = ctx.get("role")
        if role is not None and role not in self.roles:
            self.r.error(where, f"context.role {role!r} 가 rules.roles 에 없다")
        models = ctx.get("model") or []
        for m in models if isinstance(models, list) else [models]:
            if m not in MODELS:
                self.r.error(where, f"알 수 없는 로봇 모델 {m!r}")
        self.valued(where, ap, "applies_to", need_content=False)

    def check_rules(self) -> None:
        for rid, rule in self.rules.items():
            where = f"rules.{rid}"
            if not rid.startswith("AR-"):
                self.r.error(where, "규칙 번호는 AR- 로 시작한다")
            if not rule.get("name"):
                self.r.error(where, "name 이 없다")
            if rule.get("operation") not in self.ops:
                self.r.error(where, f"operation {rule.get('operation')!r} 이 operations 에 없다")
            if rule.get("status") not in STATUSES:
                self.r.error(where, f"status 는 {STATUSES} 중 하나")
            self.check_applies_to(f"{where}.applies_to", rule.get("applies_to"))
            for tid in rule.get("tools") or []:
                if tid not in self.tools:
                    self.r.error(where, f"tool {tid} 가 tools.yaml 에 없다")
            for name, p in (rule.get("parameters") or {}).items():
                self.valued(f"{where}.parameters.{name}", p, "parameter", need_content=False)
            lk = rule.get("lookup")
            if lk:
                if not lk.get("key") or not lk.get("table"):
                    self.r.error(f"{where}.lookup", "key · table 이 필요하다")
                for k, row in (lk.get("table") or {}).items():
                    self.valued(f"{where}.lookup.{k}", row, "lookup_row", need_content=True)
            for i, c in enumerate(rule.get("cautions") or []):
                w = f"{where}.cautions[{i}]"
                if c.get("level") not in LEVELS:
                    self.r.error(w, f"level 은 {LEVELS} 중 하나({c.get('level')!r})")
                self.valued(w, c, "caution", content_keys=("text",))
            if rule.get("cad_inference"):
                self.valued(f"{where}.cad_inference", rule["cad_inference"], "cad_inference", need_content=False)
            if not (rule.get("parameters") or rule.get("lookup") or rule.get("cautions")):
                self.r.error(where, "parameters · lookup · cautions 중 하나는 있어야 한다")

    def check_ws(self) -> None:
        for wid, ws in self.ws.items():
            where = f"work_standards.{wid}"
            if not wid.startswith("WS-"):
                self.r.error(where, "작업표준 번호는 WS- 로 시작한다")
            for k in ("title", "purpose", "models", "revision"):
                if not ws.get(k):
                    self.r.error(where, f"{k} 가 없다")
            if ws.get("status") not in STATUSES:
                self.r.error(where, f"status 는 {STATUSES} 중 하나")
            for m in ws.get("models") or []:
                if m not in MODELS:
                    self.r.error(where, f"알 수 없는 로봇 모델 {m!r}")
            for rid in ws.get("rules") or []:
                if rid not in self.rules:
                    self.r.error(where, f"rule {rid} 가 rules.yaml 에 없다")
            for tid in ws.get("tools") or []:
                if tid not in self.tools:
                    self.r.error(where, f"tool {tid} 가 tools.yaml 에 없다")
            # 작업 시간은 근거가 없다 → 비어 있어야 한다
            st = ws.get("standard_time")
            if not (isinstance(st, dict) and st.get("source") == "unknown" and st.get("value") is None):
                self.r.error(where, "standard_time 은 근거가 없으므로 {value: null, source: unknown, gap} 이어야 한다")
            else:
                self.valued(f"{where}.standard_time", st, "standard_time", need_content=False)
            steps = ws.get("steps")
            if steps is None:
                self.r.error(where, "steps 가 없다(없으면 [])")
                steps = []
            for i, step in enumerate(steps, 1):
                w = f"{where}.steps[{i}]"
                if step.get("seq") != i:
                    self.r.error(w, f"단계 번호가 1부터 이어지지 않는다(seq={step.get('seq')!r}, 기대 {i})")
                if step.get("operation") not in self.ops:
                    self.r.error(w, f"operation {step.get('operation')!r} 이 operations 에 없다")
                for rid in step.get("rules") or []:
                    if rid not in self.rules:
                        self.r.error(w, f"rule {rid} 가 없다")
                    elif rid not in (ws.get("rules") or []):
                        self.r.warn(w, f"단계가 쓰는 규칙 {rid} 가 문서의 rules 에 없다")
                for t in step.get("targets") or []:
                    if t.get("role") not in self.roles:
                        self.r.error(w, f"targets.role {t.get('role')!r} 가 rules.roles 에 없다")
                self.valued(w, step, "step", content_keys=("text",))
            for rid in ws.get("precautions") or []:
                if rid not in self.rules:
                    self.r.error(where, f"precautions 의 규칙 {rid} 가 없다")
            for i, c in enumerate(ws.get("checks") or []):
                self.valued(f"{where}.checks[{i}]", c, "check", content_keys=("text",))
            for i, it in enumerate(ws.get("inspection_items") or []):
                w = f"{where}.inspection_items[{i}]"
                if not (it.get("cycle") or {}).get("value"):
                    self.r.error(w, "cycle.value 가 없다")
                self.valued(w, it, "inspection_item", content_keys=("check",))
            for i, ev in enumerate(ws.get("event_checks") or []):
                w = f"{where}.event_checks[{i}]"
                for rid in ev.get("rules") or []:
                    if rid not in self.rules:
                        self.r.error(w, f"rule {rid} 가 없다")
                self.valued(w, ev, "event_check", content_keys=("text",))
            if ws.get("kind") == "structure_only":
                if steps:
                    self.r.error(where, "structure_only 문서는 절차(steps)를 쓰지 않는다 — 근거가 없다")
                self._gap(f"{where}.procedure_gap", ws.get("procedure_gap"))
                for doc in ws.get("source_files") or []:
                    if doc not in self.docs:
                        self.r.error(where, f"source_files {doc} 가 sources.yaml 에 없다")
                for a, asm in enumerate(ws.get("assemblies") or []):
                    for j, part in enumerate(asm.get("parts") or []):
                        w = f"{where}.assemblies[{a}].parts[{j}]"
                        q = part.get("quantity")
                        if not (isinstance(q, int) and q >= 1):
                            self.r.error(w, f"quantity 는 1 이상의 정수({q!r})")
                        if part.get("source") != "cad":
                            self.r.error(w, "CAD 구조 부품은 source: cad 여야 한다")
                        self.valued(w, part, "cad_part", content_keys=("cad_name",))
                        cls = part.get("class")
                        if cls:
                            self._class_names(w, [cls], proposed=False)
                        if part.get("length_source") == "unknown" and part.get("length_mm") is not None:
                            self.r.error(w, "length_source: unknown 인데 length_mm 이 비어 있지 않다")
                        if part.get("gap"):
                            self._gap(w, part["gap"])

    def check_gaps(self) -> None:
        for gid, gap in self.gaps.items():
            where = f"gaps.{gid}"
            for k in ("title", "needs", "why", "who"):
                if not gap.get(k):
                    self.r.error(where, f"{k} 가 없다")
        unused = sorted(set(self.gaps) - self.gap_refs)
        for gid in unused:
            # blocks 에서만 참조되는 공백(값을 직접 비워 두지 않고 문서 수준으로 막는 것)은 경고하지 않는다
            blocks = " ".join(map(str, (self.gaps[gid].get("blocks") or [])))
            if not blocks:
                self.r.warn(f"gaps.{gid}", "어디에서도 참조되지 않는다")

    def run(self) -> Report:
        self.check_sources()
        self.check_operations()
        self.check_tools()
        self.check_rules()
        self.check_ws()
        self.check_gaps()
        self.r.counts = {
            "operations": len(self.ops), "not_covered": len(self.not_covered), "tools": len(self.tools),
            "rules": len(self.rules), "work_standards": len(self.ws), "gaps": len(self.gaps),
            "steps": sum(len(w.get("steps") or []) for w in self.ws.values()),
            "inspection_items": sum(len(w.get("inspection_items") or []) for w in self.ws.values()),
        }
        return self.r


def check(rules_dir: Path = RULES_DIR, opms: Path | None = None) -> Report:
    data = load_all(rules_dir)
    classes, note = load_opms_classes(opms)
    report = Checker(data, classes).run()
    if classes is None and note:
        report.warn("opms", note)
    elif note:
        report.warn("opms", note)
    if classes is not None:
        report.notes.append(f"OPMS 분류 {len(classes)}개와 대조했다")
    return report


# ---------------------------------------------------------------- 출력
def render(report: Report) -> str:
    lines = ["rules/ 검증", "-" * 40]
    c = report.counts
    lines.append(
        f"공정 {c['operations']}(근거 없음 {c['not_covered']}) · 공구 {c['tools']} · 규칙 {c['rules']} · 작업표준 {c['work_standards']}"
        f"(단계 {c['steps']} · 점검 항목 {c['inspection_items']}) · 공백 {c['gaps']}"
    )
    grades = report.by_grade()
    lines.append("출처 등급별 값: " + " · ".join(f"{g} {grades[g]}" for g in GRADES))
    for n in report.notes:
        lines.append(f"참고: {n}")
    for f in report.findings:
        lines.append(f"[{'오류' if f.level == 'error' else '경고'}] {f.where}: {f.message}")
    lines.append(f"오류 {len(report.errors)} · 경고 {len(report.warnings)}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rules-dir", type=Path, default=RULES_DIR)
    ap.add_argument("--opms", type=Path, default=None, help="OPMS 저장소 경로(기본: OPMS_HOME, .env, D:/ernest_hemingway_OPMS)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")                    # Windows 콘솔 · 파이프의 기본 인코딩(cp949)과 무관하게 UTF-8 로 쓴다
    report = check(args.rules_dir, args.opms)
    if args.json:
        print(json.dumps({
            "counts": report.counts, "by_grade": report.by_grade(), "stats": dict(report.stats), "notes": report.notes,
            "errors": [f.__dict__ for f in report.errors], "warnings": [f.__dict__ for f in report.warnings],
        }, ensure_ascii=False, indent=2))
    else:
        print(render(report))
    return 1 if report.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
