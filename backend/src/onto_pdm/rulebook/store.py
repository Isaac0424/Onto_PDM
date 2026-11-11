"""`rules/` 를 읽어 메모리에 올리고, 파일이 바뀌면 다음 요청에서 다시 읽는다. **읽기 전용** — 쓰기 경로가 없다.

로드할 때마다 `tools/check_rules.py` 의 검증을 돌린다(importlib 로 파일 경로에서 불러온다 — backend 가 그 도구에 import 의존하지 않는다).
그 도구를 찾지 못하거나 불러오지 못하면 로더가 **최소 검사**(YAML 문법 · 참조 무결성 · 출처 등급 필수)만 하고 검증 결과에 그렇게 적는다.
오류가 있으면 앱은 죽지 않고, 규칙 엔드포인트가 503 `RULEBOOK_INVALID` + 오류 목록을 돌려준다(상태 `/rulebook/status` 는 항상 200).
"""

from __future__ import annotations

import importlib.util
import os
import sys
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from onto_pdm.rulebook.build import GRADES, Rulebook, RulebookError, build
from onto_pdm.rulebook.models import Finding, RulebookCounts, RulebookState, RulebookStatus, Validation

FILES = ("sources", "operations", "tools", "rules", "gaps", "work-standards")
# backend/src/onto_pdm/rulebook/store.py → 저장소 루트
_REPO = Path(__file__).resolve().parents[4]
DEFAULT_RULES_DIR = _REPO / "rules"


@dataclass
class Snapshot:
    state: RulebookState
    message: str | None
    loaded_at: str
    book: Rulebook | None
    validation: Validation | None
    by_grade: dict[str, int] | None


# ---------------------------------------------------------------- 검증
def _load_checker(candidates: list[Path]) -> Any | None:
    for path in candidates:
        if not path.is_file():
            continue
        try:
            name = f"_pdm_rulebook_check_{abs(hash(str(path)))}"
            spec = importlib.util.spec_from_file_location(name, path)
            if spec is None or spec.loader is None:
                continue
            mod = importlib.util.module_from_spec(spec)
            sys.modules[name] = mod                       # dataclass 가 모듈을 이름으로 찾는다
            try:
                spec.loader.exec_module(mod)
            except Exception:
                sys.modules.pop(name, None)
                raise
            if callable(getattr(mod, "check", None)):
                return mod
        except Exception:                                  # noqa: BLE001 — 불러오지 못하면 최소 검사로 넘어간다
            continue
    return None


def _minimal(data: dict[str, Any]) -> Validation:
    """check_rules.py 가 없을 때의 최소 검사: 참조 무결성 · 출처 등급 필수 · unknown 은 값이 비어 있다."""
    v = Validation(tool="minimal", notes=["tools/check_rules.py 를 찾지 못해 로더의 최소 검사만 했습니다 (검증 도구 없음)"])

    def err(where: str, msg: str) -> None:
        v.errors.append(Finding(level="error", where=where, message=msg))

    ops = (data["operations"] or {}).get("operations") or {}
    tools = (data["tools"] or {}).get("tools") or {}
    rules = (data["rules"] or {}).get("assembly_rules") or {}
    wss = (data["work-standards"] or {}).get("work_standards") or {}

    def walk(where: str, node: Any) -> None:
        if isinstance(node, dict):
            if "source" in node and node["source"] not in GRADES:
                err(where, f"source 가 등급이 아닙니다({node['source']!r})")
            if node.get("source") == "unknown" and any(node.get(k) not in (None, "", []) for k in ("value", "values", "text")):
                err(where, "source: unknown 인데 값이 비어 있지 않습니다")
            for k, x in node.items():
                walk(f"{where}.{k}", x)
        elif isinstance(node, list):
            for i, x in enumerate(node):
                walk(f"{where}[{i}]", x)

    for rid, r in rules.items():
        if r.get("operation") not in ops:
            err(f"rules.{rid}", f"operation {r.get('operation')!r} 이 operations 에 없습니다")
        for t in r.get("tools") or []:
            if t not in tools:
                err(f"rules.{rid}", f"tool {t} 가 tools 에 없습니다")
        walk(f"rules.{rid}", r)
    for wid, w in wss.items():
        for rid in w.get("rules") or []:
            if rid not in rules:
                err(f"work_standards.{wid}", f"rule {rid} 가 rules 에 없습니다")
        for i, s in enumerate(w.get("steps") or []):
            if s.get("operation") not in ops:
                err(f"work_standards.{wid}.steps[{i}]", f"operation {s.get('operation')!r} 이 operations 에 없습니다")
            for rid in s.get("rules") or []:
                if rid not in rules:
                    err(f"work_standards.{wid}.steps[{i}]", f"rule {rid} 가 rules 에 없습니다")
        walk(f"work_standards.{wid}", w)
    return v


def _read(rules_dir: Path) -> dict[str, Any]:
    data: dict[str, Any] = {}
    for name in FILES:
        path = rules_dir / f"{name}.yaml"
        if not path.is_file():
            raise RulebookError(f"{path} 가 없습니다")
        try:
            with path.open(encoding="utf-8") as f:
                data[name] = yaml.safe_load(f)
        except (OSError, yaml.YAMLError) as e:
            raise RulebookError(f"{path.name} 를 읽지 못했습니다: {e}") from e
    return data


class RulebookStore:
    """읽기 전용 저장소. `snapshot()` 이 파일 수정 시각을 보고 필요하면 다시 읽는다."""

    def __init__(self, rules_dir: Path | None = None, *, opms_home: Path | None = None, checker: Path | None = None) -> None:
        self.rules_dir = Path(rules_dir) if rules_dir is not None else DEFAULT_RULES_DIR
        self.opms_home = opms_home
        self._checker_candidates = [p for p in (checker, self.rules_dir.parent / "tools" / "check_rules.py", _REPO / "tools" / "check_rules.py") if p]
        self._lock = threading.Lock()
        self._sig: tuple[Any, ...] | None = None
        self._snap: Snapshot | None = None

    @classmethod
    def from_env(cls) -> RulebookStore:
        d = os.environ.get("PDM_RULES_DIR")
        home = os.environ.get("PDM_RULES_OPMS_HOME")
        checker = os.environ.get("PDM_RULES_CHECKER")
        return cls(Path(d) if d else None, opms_home=Path(home) if home else None, checker=Path(checker) if checker else None)

    def _signature(self) -> tuple[Any, ...]:
        sig: list[Any] = []
        for name in FILES:
            try:
                st = (self.rules_dir / f"{name}.yaml").stat()
                sig.append((name, st.st_mtime_ns, st.st_size))
            except OSError:
                sig.append((name, None, None))
        return tuple(sig)

    def snapshot(self) -> Snapshot:
        sig = self._signature()
        with self._lock:
            if self._snap is None or sig != self._sig:
                self._snap = self._load()
                self._sig = sig
            return self._snap

    # ------------------------------------------------------------ 적재
    def _load(self) -> Snapshot:
        now = datetime.now(UTC).isoformat(timespec="seconds")
        try:
            data = _read(self.rules_dir)
        except RulebookError as e:
            return Snapshot("unavailable", str(e), now, None, None, None)

        checker = _load_checker(self._checker_candidates)
        validation: Validation
        by_grade: dict[str, int] | None = None
        if checker is not None:
            try:
                report = checker.check(self.rules_dir, self.opms_home)
            except Exception as e:                           # noqa: BLE001 — 검증 도구가 죽어도 앱은 산다
                return Snapshot("unavailable", f"rules/ 검증 도구가 실패했습니다: {type(e).__name__}: {e}", now, None, None, None)
            validation = Validation(
                tool="check_rules", notes=list(report.notes),
                errors=[Finding(level="error", where=f.where, message=f.message) for f in report.errors],
                warnings=[Finding(level="warning", where=f.where, message=f.message) for f in report.warnings],
            )
            by_grade = dict(report.by_grade())
        else:
            validation = _minimal(data)

        try:
            book = build(data)
        except RulebookError as e:
            validation.errors.append(Finding(level="error", where="rules/", message=str(e)))
            return Snapshot("invalid", f"rules/ 에 오류가 {len(validation.errors)}건 있습니다", now, None, validation, by_grade)
        if by_grade is None:
            by_grade = dict(book.by_grade)
        if validation.errors:
            # book 은 개수 표시용으로만 남긴다 — state 가 ok 가 아니면 엔드포인트가 내용을 내보내지 않는다
            return Snapshot("invalid", f"rules/ 에 오류가 {len(validation.errors)}건 있습니다 — 고칠 때까지 규칙을 내보내지 않습니다", now, book, validation, by_grade)
        return Snapshot("ok", None, now, book, validation, by_grade)

    def status(self) -> RulebookStatus:
        snap = self.snapshot()
        counts = None
        if snap.book is not None:
            counts = RulebookCounts(**snap.book.counts)
        return RulebookStatus(
            state=snap.state, message=snap.message, rules_dir=str(self.rules_dir), loaded_at=snap.loaded_at, counts=counts,
            by_grade=snap.by_grade, validation=snap.validation,
        )
