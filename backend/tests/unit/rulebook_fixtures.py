"""조립 규칙 · 작업표준(rulebook) 시험 도구. 실제 `rules/` 를 쓰고, 깨뜨린 사본은 `tempfile` 로 만든다.

(Windows 에서 pytest 의 tmp_path 는 한글 사용자 폴더 때문에 권한 오류가 나서 tempfile 을 쓴다. docs/work-standards.md 8장)
"""

from __future__ import annotations

import contextlib
import shutil
import tempfile
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import yaml
from fastapi.testclient import TestClient

from onto_pdm.api.app import PREFIX, create_app
from onto_pdm.opms.reader import UnconfiguredOpmsReader
from onto_pdm.rulebook import DEFAULT_RULES_DIR, RulebookStore
from onto_pdm.store import InMemoryPdmStore

B = f"{PREFIX}/rulebook"
# 시험이 이 PC 의 OPMS 저장소에 기대지 않게 존재하지 않는 경로를 준다(분류 이름 대조는 경고로 건너뛴다)
NO_OPMS = Path(tempfile.gettempdir()) / "pdm-rulebook-no-opms"


def real_store() -> RulebookStore:
    return RulebookStore(DEFAULT_RULES_DIR, opms_home=NO_OPMS)


def client(store: RulebookStore | None = None) -> TestClient:
    return TestClient(create_app(InMemoryPdmStore(), UnconfiguredOpmsReader(), store or real_store()))


@contextlib.contextmanager
def temp_rules(mutate: Callable[[dict[str, Any]], None] | None = None) -> Iterator[Path]:
    """실제 rules/ 를 임시 폴더로 복사하고 mutate(파일 이름 → 파싱한 YAML)로 깨뜨린다. 폴더를 지우는 것은 임시 폴더뿐이다."""
    with tempfile.TemporaryDirectory(prefix="pdm-rules-") as tmp:
        dst = Path(tmp) / "rules"
        dst.mkdir()
        data: dict[str, Any] = {}
        for src in DEFAULT_RULES_DIR.glob("*.yaml"):
            data[src.stem] = yaml.safe_load(src.read_text(encoding="utf-8"))
        if mutate is not None:
            mutate(data)
        for name, content in data.items():
            (dst / f"{name}.yaml").write_text(yaml.safe_dump(content, allow_unicode=True, sort_keys=False), encoding="utf-8")
        yield dst


def copy_real(dst: Path) -> None:
    shutil.copytree(DEFAULT_RULES_DIR, dst, dirs_exist_ok=True, ignore=shutil.ignore_patterns("tests", "__pycache__"))
