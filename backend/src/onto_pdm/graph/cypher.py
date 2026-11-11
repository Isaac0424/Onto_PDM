"""neo4j/*.cypher 파일을 문장 · 검사 단위로 나눈다.

파일은 사람이 읽고 `cypher-shell` 로도 돌릴 수 있는 형식(// 주석, ; 로 끝나는 문장)이라, 드라이버로 돌리려면 나눠야 한다.
문자열 안의 `;` 와 `//` 는 문장 끝 · 주석으로 보지 않는다.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[3]


def neo4j_dir() -> Path:
    """저장소의 neo4j/ 폴더 (스키마 · 검사 규칙). PDM_NEO4J_DIR 로 바꿀 수 있다."""
    env = os.environ.get("PDM_NEO4J_DIR")
    return Path(env) if env else _BACKEND_ROOT.parent / "neo4j"


def split_statements(text: str) -> list[str]:
    """`;` 로 끝나는 문장으로 나눈다. `//` 주석과 빈 문장은 버린다."""
    out: list[str] = []
    buf: list[str] = []
    quote: str | None = None
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if quote:
            buf.append(ch)
            if ch == "\\" and quote != "`" and i + 1 < n:
                buf.append(text[i + 1])
                i += 1
            elif ch == quote:
                quote = None
        elif ch in ("'", '"', "`"):
            quote = ch
            buf.append(ch)
        elif ch == "/" and text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
            continue
        elif ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
        else:
            buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out


_MARK = re.compile(r"//\s*@(\w+)\s*(?:\((.*?)\))?\s*$")


def named_blocks(text: str) -> dict[str, str]:
    """`// @이름` 줄로 시작하는 블록을 {이름: 문장} 으로 나눈다 (neo4j/test/verify.py 와 같은 표지)."""
    blocks: dict[str, list[str]] = {}
    name: str | None = None
    for line in text.splitlines():
        m = _MARK.match(line.strip())
        if m:
            name = m.group(1)
            blocks[name] = []
        elif name and not line.lstrip().startswith("//"):
            blocks[name].append(line)
    return {k: "\n".join(v).strip().rstrip(";").strip() for k, v in blocks.items() if "".join(v).strip()}


def schema_statements() -> list[str]:
    return split_statements((neo4j_dir() / "schema.cypher").read_text(encoding="utf-8"))


def check_statements() -> dict[str, str]:
    return named_blocks((neo4j_dir() / "checks.cypher").read_text(encoding="utf-8"))
