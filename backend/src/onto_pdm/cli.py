"""onto-pdm 명령줄: 계약 내보내기, 서버 실행, Neo4j 그래프 초기화 · 발행."""

from __future__ import annotations

import json
import sys
from typing import Annotated

import typer

app = typer.Typer(no_args_is_help=True, help="Onto PDM 백엔드")
contracts_app = typer.Typer(no_args_is_help=True, help="계약(JSON Schema · 예시) 생성")
graph_app = typer.Typer(no_args_is_help=True, help="Neo4j 그래프 (PdmItem 모델)")
app.add_typer(contracts_app, name="contracts")
app.add_typer(graph_app, name="graph")


@contracts_app.command("export")
def contracts_export(check: Annotated[bool, typer.Option("--check", help="쓰지 않고 커밋된 생성물이 최신인지만 본다")] = False) -> None:
    from onto_pdm import contract_export

    if check:
        old = contract_export.stale()
        if old:
            typer.echo("최신이 아닌 계약 파일: " + ", ".join(old) + "\n`onto-pdm contracts export` 로 다시 만드세요.", err=True)
            raise typer.Exit(1)
        typer.echo("계약 생성물이 최신입니다")
        return
    for path in contract_export.write():
        typer.echo(f"wrote {path}")


@app.command()
def serve(host: str = "127.0.0.1", port: int = 8100) -> None:
    """개발 서버 (인메모리 시드 저장소)."""
    import uvicorn

    uvicorn.run("onto_pdm.api.app:app", host=host, port=port)


def _driver(uri: str, user: str | None, password: str | None):  # type: ignore[no-untyped-def]
    from neo4j import GraphDatabase

    auth = (user, password) if user and password else None
    return GraphDatabase.driver(uri, auth=auth)


@graph_app.command("init")
def graph_init(
    uri: Annotated[str, typer.Option(envvar="NEO4J_URI")] = "bolt://127.0.0.1:7687",
    user: Annotated[str | None, typer.Option(envvar="NEO4J_USER")] = None,
    password: Annotated[str | None, typer.Option(envvar="NEO4J_PASSWORD")] = None,
) -> None:
    """neo4j/schema.cypher 의 제약 · 인덱스를 적용한다 (IF NOT EXISTS 라 여러 번 해도 된다)."""
    from onto_pdm.graph import apply_schema

    with _driver(uri, user, password) as driver:
        n = apply_schema(driver)
    typer.echo(f"{n}개 문장을 적용했습니다")


@graph_app.command("publish")
def graph_publish(
    product: Annotated[str, typer.Argument(help="제품 코드 (예: HCR3A)")],
    uri: Annotated[str, typer.Option(envvar="NEO4J_URI")] = "bolt://127.0.0.1:7687",
    user: Annotated[str | None, typer.Option(envvar="NEO4J_USER")] = None,
    password: Annotated[str | None, typer.Option(envvar="NEO4J_PASSWORD")] = None,
) -> None:
    """시드 저장소의 제품 승인 BOM 을 Neo4j 에 발행한다 (PdmItem 모델 B, MERGE 멱등)."""
    from onto_pdm.graph import GraphPublishError, publish_product
    from onto_pdm.store import InMemoryPdmStore

    store = InMemoryPdmStore()
    try:
        with _driver(uri, user, password) as driver:
            counts = publish_product(driver, store, product)  # 승인본만 나간다 (작업중 · 검토중은 내보내지 않는다)
    except GraphPublishError as e:
        typer.echo(f"{e.code}: {e}", err=True)
        raise typer.Exit(1) from e
    typer.echo(json.dumps(counts, ensure_ascii=False))


def main() -> None:  # pragma: no cover
    sys.exit(app())
