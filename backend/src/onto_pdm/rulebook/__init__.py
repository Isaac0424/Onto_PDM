"""조립 규칙 · 작업표준서(`rules/` YAML)를 읽어 API 로 내보내는 읽기 전용 패키지.

정본은 저장소의 `rules/` 이고(사람이 쓴 YAML, 출처 등급 필수), 이 패키지는 검증해서 읽기만 한다. 분류 · 속성은 OPMS 소유이고 규칙 · 작업표준은 PDM 소유다.
"""

from onto_pdm.rulebook.build import Rulebook, RulebookError, build
from onto_pdm.rulebook.select import select_rules
from onto_pdm.rulebook.store import DEFAULT_RULES_DIR, RulebookStore, Snapshot

__all__ = ["DEFAULT_RULES_DIR", "Rulebook", "RulebookError", "RulebookStore", "Snapshot", "build", "select_rules"]
