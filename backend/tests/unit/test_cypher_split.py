"""neo4j/*.cypher 를 문장 · 검사 단위로 나누는 일 (Docker 없이)."""

from __future__ import annotations

from onto_pdm.graph.cypher import check_statements, named_blocks, neo4j_dir, schema_statements, split_statements


def test_split_ignores_comments_and_semicolons_inside_strings() -> None:
    text = """
    // 주석 ; 은 문장 끝이 아니다
    CREATE (a {note: 'x;y // z'}) ;  // 뒤 주석
    MATCH (n) WHERE n.t = "a;b"
    RETURN `weird;name`;
    CALL db.awaitIndexes();
    """
    assert split_statements(text) == [
        "CREATE (a {note: 'x;y // z'})",
        'MATCH (n) WHERE n.t = "a;b"\n    RETURN `weird;name`',
        "CALL db.awaitIndexes()",
    ]


def test_named_blocks_use_the_at_marker() -> None:
    text = "// 머리\n// @first\nMATCH (a) RETURN a;\n\n// 설명\n// @second ($x)\nMATCH (b) RETURN b;\n"
    assert named_blocks(text) == {"first": "MATCH (a) RETURN a", "second": "MATCH (b) RETURN b"}


def test_schema_file_is_all_idempotent_statements() -> None:
    stmts = schema_statements()
    assert len(stmts) >= 9
    ddl = [s for s in stmts if not s.startswith("CALL")]
    assert all(" IF NOT EXISTS" in s for s in ddl), "스키마 문장은 모두 IF NOT EXISTS 여야 여러 번 돌려도 안전하다"
    assert stmts[-1] == "CALL db.awaitIndexes()"
    assert any("pdm_item_id" in s and "UNIQUE" in s for s in stmts)


def test_checks_are_read_only_and_each_returns_rule_subject_message() -> None:
    checks = check_statements()
    assert len(checks) >= 27
    assert {"item_one_part", "part_one_item", "bom_quantity_positive", "bom_no_cycle", "identifier_key"} <= set(checks)
    for name, q in checks.items():
        assert q.lstrip().startswith(("MATCH", "OPTIONAL")), name
        assert "AS rule" in q and "AS subject" in q and "AS message" in q, name
        for write in ("CREATE ", "MERGE ", " SET ", "DELETE "):
            assert write not in q.upper().replace("\n", " "), f"{name}: 검사는 쓰지 않는다"


def test_neo4j_dir_points_at_the_repo_folder() -> None:
    assert (neo4j_dir() / "schema.cypher").exists() and (neo4j_dir() / "checks.cypher").exists()
