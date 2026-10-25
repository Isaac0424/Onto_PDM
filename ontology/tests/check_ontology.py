"""ontology/ 검사: SHACL 데이터 규칙, 분류 제안(TBox) 규칙, OWL 2 RL 추론 질의, (선택) QUDT 단위 대조.

    python ontology/tests/check_ontology.py            # 기본 검사 (네트워크 불필요)
    python ontology/tests/check_ontology.py --qudt     # QUDT 공개본을 받아 단위 · IEC 단위 IRDI까지 대조

실패가 하나라도 있으면 종료 코드 1.
"""
from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

import owlrl
from pyshacl import validate
from rdflib import Graph, Literal, Namespace, RDF
from rdflib.namespace import OWL, RDFS, SKOS

ONTO = Path(__file__).resolve().parents[1]
QUDT_TAG = "v3.5.3"   # 대조에 쓰는 QUDT 공개본 (CC BY 4.0)
QUDT_FILES = {
    "VOCAB_QUDT-UNITS-ALL.ttl": "vocab/unit/VOCAB_QUDT-UNITS-ALL.ttl",
    "VOCAB_QUDT-QUANTITY-KINDS-ALL.ttl": "vocab/quantitykinds/VOCAB_QUDT-QUANTITY-KINDS-ALL.ttl",
    "SCHEMA_QUDT.ttl": "schema/SCHEMA_QUDT.ttl",
}

OPDM = Namespace("https://ontology.example.com/onto-pdm/core#")
CLS = Namespace("https://ontology.example.com/onto-pdm/class/")
MAT = Namespace("https://ontology.example.com/onto-pdm/material/")
PART = Namespace("https://ontology.example.com/onto-pdm/part/")
REV = Namespace("https://ontology.example.com/onto-pdm/revision/")
BOM = Namespace("https://ontology.example.com/onto-pdm/bomline/")
SH = Namespace("http://www.w3.org/ns/shacl#")
QUDT = Namespace("http://qudt.org/schema/qudt/")

passed = failed = 0


def check(cond: bool, label: str) -> None:
    global passed, failed
    passed += bool(cond)
    failed += not cond
    print(("PASS " if cond else "FAIL ") + label)


def results(report: Graph) -> list[tuple[str, str, str]]:
    out = []
    for r in report.subjects(RDF.type, SH.ValidationResult):
        out.append((str(report.value(r, SH.focusNode)).rsplit("/", 1)[-1],
                    str(report.value(r, SH.resultSeverity)).rsplit("#", 1)[-1],
                    str(report.value(r, SH.resultMessage))))
    return sorted(out)


def load(name: str) -> Graph:
    return Graph().parse(ONTO / name)


def data_shapes(core: Graph, sample: Graph, shapes: Graph) -> None:
    print("\n== 데이터(ABox) 규칙: shapes-data.ttl")
    conforms, report, _ = validate(core + sample, shacl_graph=shapes)
    check(conforms, "예시 데이터가 규칙을 통과한다")
    for r in results(report):
        print("    ", r)

    bad = core + sample
    bad.remove((PART.P0000002, OPDM.hasMaterial, None))                     # 가공품인데 재료 없음
    bad.add((PART.P0000001, OPDM.partNumber, Literal("P0000099")))          # 대표 품번 두 개
    bad.add((PART.P0000001, OPDM.currentRevision, REV["P0000002-R00"]))    # 현재 리비전 두 개
    bad.remove((BOM["P0000010-R01-1"], OPDM.quantity, None))
    bad.add((BOM["P0000010-R01-1"], OPDM.quantity, Literal(0)))             # 수량 0
    bad.add((MAT.M000003, OPDM.density, Literal(-2.7)))                     # 밀도 두 개, 음수
    conforms, report, _ = validate(bad, shacl_graph=shapes)
    text = " | ".join(m for _, _, m in results(report))
    check(not conforms, "망가뜨린 데이터는 거부된다")
    for needle in ["재료가 필요", "대표 품번은 정확히 하나", "현재 승인 리비전은 하나만", "수량은 양수", "밀도는"]:
        check(needle in text, f"  위반으로 잡힘: {needle}")


def reasoning(core: Graph, sample: Graph) -> None:
    print("\n== OWL 2 RL 추론 질의")
    inf = core + sample
    owlrl.DeductiveClosure(owlrl.OWLRL_Semantics).expand(inf)
    prefixes = """PREFIX opdm: <https://ontology.example.com/onto-pdm/core#>
PREFIX cls: <https://ontology.example.com/onto-pdm/class/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>"""

    def products_containing(material_class: str) -> list[str]:
        q = prefixes + f"""
        SELECT DISTINCT ?name WHERE {{
          ?product a opdm:Product ; opdm:rootItem ?root ; skos:prefLabel ?name .
          ?root opdm:hasComponentTransitive ?part .
          ?part opdm:hasMaterial ?m . ?m a {material_class} .
        }} ORDER BY ?name"""
        return [str(r.name) for r in inf.query(q)]

    check(products_containing("cls:M0111") == ["HCR3A"], "스테인리스강이 들어간 제품 = HCR3A (BOM 두 단계 아래)")
    check(products_containing("cls:M0100") == ["HCR3A", "HCR5A"], "금속(상위 분류)이 들어간 제품 = HCR3A, HCR5A")
    alias = [str(r.n) for r in inf.query(prefixes + 'SELECT ?n WHERE { ?p opdm:altPartNumber "BLT-0038" ; opdm:partNumber ?n }')]
    check(alias == ["P0000001"], "레거시 품번을 altPartNumber 상위 속성으로 찾는다")
    check((PART.P0000020, OPDM.hasComponent, PART.P0000010) in inf, "속성 사슬: 현재 승인 BOM의 직접 하위 품목")
    check((PART.P0000020, OPDM.hasComponent, PART.P0000001) not in inf
          and (PART.P0000020, OPDM.hasComponentTransitive, PART.P0000001) in inf, "이행 관계는 hasComponentTransitive 에만")
    same = [(s, o) for s, o in inf.subject_objects(OWL.sameAs) if s != o]
    check(not same, f"추론이 개체를 합치지 않는다 (owl:sameAs {len(same)}건)")


def taxonomy(core: Graph, sample: Graph, shapes: Graph) -> None:
    print("\n== 분류 제안(TBox) 규칙: shapes-taxonomy.ttl")
    conforms, report, _ = validate(core + sample, shacl_graph=shapes)
    check(conforms, "지금 분류체계가 규칙을 통과한다")
    for r in results(report):
        print("    ", r)

    def proposal(triples, label):
        g = core + sample
        for t in triples:
            g.add(t)
        ok, report, _ = validate(g, shacl_graph=shapes, allow_warnings=True)
        res = results(report)
        print(f"   [{label}] conforms={ok}")
        for r in res:
            print("      ", r)
        return ok, res

    def cls(code, parents, labels, definition=None):
        s = CLS[code]
        out = [(s, RDF.type, OWL.Class)] + [(s, RDFS.subClassOf, p) for p in parents]
        out += [(s, SKOS.prefLabel, Literal(text, lang=lang)) for text, lang in labels]
        if definition:
            out.append((s, SKOS.definition, Literal(definition, lang="ko")))
        return out

    ok, _ = proposal(cls("C0102", [CLS.C0100], [("셀프태핑 나사", "ko"), ("Self-tapping screw", "en")], "스스로 나사산을 내며 체결되는 나사"), "정상")
    check(ok, "정상 제안은 통과")
    ok, res = proposal(cls("C0103", [CLS.C0100], [("보울트", "ko")], "볼트"), "동의어 중복")
    check(not ok and any("같은 이름" in m for *_, m in res), "형제 분류의 동의어와 겹치면 거부")
    ok, res = proposal(cls("C0104", [CLS.C0100, CLS.C0200], [("리벳", "ko")], "..."), "상위 둘")
    check(not ok and any("트리 구조" in m for *_, m in res), "상위 분류가 둘이면 거부")
    ok, res = proposal(cls("C0105", [CLS.C0100], [("Rivet", "en")]), "한국어 이름 · 정의 없음")
    check(not ok and any("한국어 이름" in m for *_, m in res) and any("정의" in m for *_, m in res), "한국어 이름 · 정의가 없으면 거부")
    ok, res = proposal(cls("C0106", [CLS.C9999], [("와셔", "ko")], "..."), "없는 상위")
    check(not ok and any("이미 있는 클래스" in m for *_, m in res), "없는 상위 분류면 거부")
    ok, res = proposal(cls("C0107", [CLS.C0101], [("볼트 M3x8", "ko")], "M3 길이 8 볼트"), "규격 이름")
    check(ok and any(sev == "Warning" and "규격" in m for _, sev, m in res), "이름에 규격 값이 있으면 경고 (분류가 아니라 속성)")


def qudt_files(target: Path) -> Path:
    target.mkdir(parents=True, exist_ok=True)
    for name, path in QUDT_FILES.items():
        dest = target / name
        if not dest.exists():
            url = f"https://raw.githubusercontent.com/qudt/qudt-public-repo/{QUDT_TAG}/src/main/rdf/{path}"
            print(f"QUDT 내려받기: {url}")
            urllib.request.urlretrieve(url, dest)
    return target


def qudt(core: Graph, qudt_dir: Path) -> None:
    print(f"\n== QUDT 대조 ({qudt_dir})")
    units = Graph().parse(qudt_dir / "VOCAB_QUDT-UNITS-ALL.ttl")
    kinds = Graph().parse(qudt_dir / "VOCAB_QUDT-QUANTITY-KINDS-ALL.ttl")
    schema = Graph().parse(qudt_dir / "SCHEMA_QUDT.ttl")
    for prop in sorted(set(core.subjects(OPDM.unit, None))):
        name = str(prop).rsplit("#", 1)[-1]
        unit, kind = core.value(prop, OPDM.unit), core.value(prop, OPDM.quantityKind)
        irdi = str(core.value(prop, OPDM.unitIrdi))
        check((unit, None, None) in units, f"{name}: 단위 {unit.rsplit('/', 1)[-1]} 가 QUDT에 있다")
        check((kind, None, None) in kinds, f"{name}: 수량 종류 {kind.rsplit('/', 1)[-1]} 가 QUDT에 있다")
        check(irdi in [str(o) for o in units.objects(unit, QUDT.iec61360Code)], f"{name}: unitIrdi {irdi} = QUDT iec61360Code")
    merged = core + schema
    clash = [str(p) for p in merged.subjects(RDF.type, OWL.AnnotationProperty)
             if (p, RDF.type, OWL.ObjectProperty) in merged or (p, RDF.type, OWL.DatatypeProperty) in merged]
    check(not clash, f"QUDT 스키마와 같이 올려도 속성 종류가 충돌하지 않는다 {clash or ''}")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--qudt", action="store_true", help=f"QUDT {QUDT_TAG} 를 받아(ontology/.cache) 단위 · IRDI까지 대조")
    ap.add_argument("--qudt-dir", type=Path, help="이미 받아 둔 QUDT 파일 폴더")
    args = ap.parse_args()

    core, sample = load("core.ttl"), load("examples/sample-abox.ttl")
    data_shapes(core, sample, load("shapes-data.ttl"))
    reasoning(core, sample)
    taxonomy(core, sample, load("shapes-taxonomy.ttl"))
    if args.qudt or args.qudt_dir:
        qudt(core, args.qudt_dir or qudt_files(ONTO / ".cache" / f"qudt-{QUDT_TAG}"))
    else:
        print("\n(QUDT 대조는 건너뜀 — --qudt 로 켠다)")

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
