"""neo4j/ 검사: 스키마 · 예시 데이터 · 검사 규칙 · 질의 · 멱등성을 일회용 Neo4j 컨테이너에서 확인한다.

    python neo4j/test/verify.py

Docker 가 필요하다. OPMS compose 와 같은 이미지(neo4j:5.26.x-community)를 포트 없이 임시로 띄우고 끝나면 지운다.
OPMS 의 실제 DB 에는 닿지 않는다. 실패가 하나라도 있으면 종료 코드 1.
"""
from __future__ import annotations

import csv
import io
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
NEO = HERE.parent
IMAGE = "neo4j:5.26.32-community"          # OPMS docker-compose.yml 의 neo4j 와 같은 버전
NAME = f"onto-pdm-lpg-verify-{uuid.uuid4().hex[:8]}"

passed = failed = 0


def check(cond: bool, label: str, detail: str = "") -> None:
    global passed, failed
    passed += bool(cond)
    failed += not cond
    print(("PASS " if cond else "FAIL ") + label + (f"  → {detail}" if detail and not cond else ""))


def docker(*args: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], input=stdin, capture_output=True, text=True, encoding="utf-8")


def shell(text: str, params: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    head = "".join(f":param {k} => {v}\n" for k, v in (params or {}).items())
    return docker("exec", "-i", "-e", "JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8", NAME,
                  "cypher-shell", "--format", "plain", stdin=head + text)


def run_file(path: Path) -> None:
    r = shell(path.read_text(encoding="utf-8"))
    if r.returncode:
        raise SystemExit(f"{path.name} 실행 실패:\n{r.stderr}\n{r.stdout}")


def rows(text: str) -> list[list[str]]:
    """cypher-shell --format plain 출력에서 머리줄을 빼고 행을 읽는다."""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if lines and re.fullmatch(r"[A-Za-z_]\w*(, [A-Za-z_]\w*)*", lines[0]):
        lines = lines[1:]
    return [r for r in csv.reader(io.StringIO("\n".join(lines)), skipinitialspace=True)]


def blocks(path: Path) -> dict[str, tuple[list[str], str]]:
    """'// @이름 ($인자, …)' 줄로 시작하는 블록을 {이름: (인자, 문장)} 으로 나눈다."""
    out: dict[str, tuple[list[str], str]] = {}
    name, args, buf = None, [], []
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"//\s*@(\w+)\s*(?:\((.*?)\))?\s*$", line)
        if m:
            if name:
                out[name] = (args, "\n".join(buf))
            name, args, buf = m.group(1), re.findall(r"\$(\w+)", m.group(2) or ""), []
        elif name and not line.lstrip().startswith("//"):
            buf.append(line)
    if name:
        out[name] = (args, "\n".join(buf))
    return out


def q(name: str, defs: dict[str, tuple[list[str], str]], **params: str) -> list[list[str]]:
    args, text = defs[name]
    assert set(args) == set(params), f"{name}: 인자 {args}"
    r = shell(text, {k: f"'{v}'" for k, v in params.items()})
    if r.returncode:
        raise SystemExit(f"{name} 실패:\n{r.stderr}\n{r.stdout}")
    return rows(r.stdout)


def count(what: str) -> str:
    r = shell(f"MATCH {what} RETURN count(*) AS n;")
    return r.stdout.strip().splitlines()[-1]


def part_snapshot() -> str:
    """OPMS 가 소유하는 :Part 의 모양(개수 · 속성 수 · 라벨 수). PDM 이 :Part 를 건드리면 달라진다."""
    r = shell("MATCH (p:Part) RETURN count(p) AS parts, sum(size(keys(p))) AS keys, sum(size(labels(p))) AS labels;")
    return r.stdout.strip().splitlines()[-1]


def violations(defs: dict[str, tuple[list[str], str]]) -> dict[str, list[list[str]]]:
    return {n: found for n in defs if (found := q(n, defs))}


def wait_ready() -> None:
    for _ in range(90):
        if shell("RETURN 1;").returncode == 0:
            return
        time.sleep(2)
    raise SystemExit("Neo4j 가 시간 안에 뜨지 않았다")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    started = docker("run", "-d", "--rm", "--name", NAME, "-e", "NEO4J_AUTH=none", IMAGE)
    if started.returncode:
        raise SystemExit(f"컨테이너를 띄우지 못했다: {started.stderr}")
    try:
        wait_ready()

        print("\n== 스키마와 예시 데이터")
        run_file(HERE / "opms-standin.cypher")
        run_file(NEO / "schema.cypher")
        parts_before = part_snapshot()
        run_file(NEO / "sample.cypher")
        check(part_snapshot() == parts_before, "PDM 은 OPMS 의 :Part 에 라벨도 속성도 쓰지 않는다", f"{parts_before} → {part_snapshot()}")
        check(count("(p:PdmItem)") == "6", "품목 6개")
        check(count("(:PdmItem)-[:OF_PART]->(:Part)") == "6", "품목마다 OPMS 품목 마스터(:Part) 하나로 이어진다")
        check(count("(:ItemRevision)") == "7", "승인 리비전 7개")
        check(count("()-[:CONTAINS]->()") == "6", "BOM 줄 6개 (노드가 아니라 관계)")
        check(count("(:ProductModel)-[:ROOT_ITEM]->(:PdmItem)") == "2", "제품 2개, 각각 최상위 조립품 하나")
        before = (count("(n)"), count("()-[r]->()"))
        run_file(NEO / "schema.cypher")
        run_file(NEO / "sample.cypher")
        check((count("(n)"), count("()-[r]->()")) == before, "같은 승인본을 다시 발행해도 결과가 같다 (멱등)", f"{before}")

        print("\n== 데이터 검사: checks.cypher")
        checks = blocks(NEO / "checks.cypher")
        found = violations(checks)
        want = ["item_one_part", "part_one_item", "part_no_format", "item_name_required", "item_type_valid",
                "material_required", "material_in_scheme", "mass_positive",
                "revision_status_valid", "revision_label_required", "revision_owner",
                "one_current_revision", "current_is_revision_of_item", "current_is_released",
                "bom_child_is_item", "bom_quantity_positive", "bom_find_no_integer", "bom_find_no_unique",
                "bom_child_once", "bom_no_cycle", "product_root_assembly", "product_one_root",
                "density_positive", "profile_one_concept", "identifier_scheme_valid", "identifier_owner", "identifier_key"]
        check(set(checks) == set(want), f"검사 {len(checks)}개를 읽었고 모두 망가뜨린 데이터 시험이 있다",
              str(sorted(set(checks) ^ set(want))))
        check(not found, "예시 데이터가 모든 검사를 통과한다", str(found))

        print("\n== 질의: queries.cypher")
        qs = blocks(NEO / "queries.cypher")
        flat = lambda rs: [r[0] for r in rs]
        check(flat(q("products_with_material", qs, material="Stainless")) == ['HCR3A'],
              "스테인리스(상위 개념)가 들어간 제품 = HCR3A (BOM 두 단계 아래)")
        check(flat(q("products_with_material", qs, material="CarbonSteel")) == ['HCR3A', 'HCR5A'],
              "탄소강이 들어간 제품 = HCR3A, HCR5A")
        check(flat(q("products_with_material", qs, material="SUS316")) == [], "SUS316 이 들어간 제품은 없다")
        check(flat(q("direct_components", qs, part_no="P-00000000020")) == ['P-00000000010'],
              "직접 하위 품목: 본체 → 체결 세트 (한 단계만)")
        explode = [(r[0].strip('"'), r[1], r[2]) for r in q("bom_explode", qs, part_no="P-00000000020")]
        check(explode == [("P-00000000010", "1", "2.0"), ("P-00000000001", "2", "8.0"),
                          ("P-00000000002", "2", "8.0"), ("P-00000000003", "2", "16.0")],
              "전개: 현재 승인 BOM 만 따르고 수량을 곱해 누적 (obsolete R00 의 볼트 ×4 는 안 섞인다)", str(explode))
        check(flat(q("where_used", qs, part_no="P-00000000001")) == ['P-00000000010', 'P-00000000020'],
              "역전개: 볼트가 들어간 모든 상위 품목")
        check(flat(q("items_of_class", qs, **{"class": "Fastener"})) == ['P-00000000001', 'P-00000000002', 'P-00000000003'],
              "하위 클래스 추론 대신 SUBCLASS_OF*0.. : 체결 부품 아래 품목")
        check(flat(q("items_of_class", qs, **{"class": "HexNut"})) == ['P-00000000002'], "분류를 좁히면 하위 클래스만")
        check(flat(q("find_by_alias", qs, norm="BLT0038")) == ['P-00000000001'], "레거시 품번으로 대표 품번을 찾는다")
        check(flat(q("find_by_alias", qs, norm="N0008")) == ['P-00000000002'], "다른 종류(erp) 별칭도 같은 질의로 찾는다")
        revs = [tuple(x.strip('"') for x in r) for r in q("revisions", qs, part_no="P-00000000010")]
        check(revs == [("R00", "obsolete", "FALSE"), ("R01", "released", "TRUE")], "리비전 이력과 현재 표시", str(revs))
        found_names = flat(q("search_name", qs, q="육각볼트"))
        check(found_names[:1] == ['P-00000000001'], "한글 이름 검색: 점수 순 첫 결과가 볼트 (cjk 분석기는 2글자씩 쪼갠다)", str(found_names))

        print("\n== 망가뜨린 데이터는 거부된다")
        run_file(HERE / "break.cypher")
        bad = violations(checks)
        for rule in want:
            check(rule in bad, f"  위반으로 잡힘: {rule}")
        check(set(bad) <= set(want), "  예상 밖 위반이 없다", str(sorted(set(bad) - set(want))))
    finally:
        docker("rm", "-f", NAME)

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
