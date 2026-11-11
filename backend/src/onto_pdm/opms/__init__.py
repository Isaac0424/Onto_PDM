"""OPMS(parts-registry) 읽기 전용 접근.

온톨로지(분류 · 속성 · 개념 · 규칙)와 부품 마스터(`:Part`)는 OPMS 소유다. PDM 은 **읽기만** 한다:
OPMS 의 Neo4j 에 아무것도 쓰지 않는다(읽기 트랜잭션만, 쓰기 문장은 어댑터가 거부한다).
읽는 길은 지금 Neo4j 직접이고, OPMS API 로 바꿀 때 `OpmsReader` 만 새로 구현하면 된다(reader.py).
"""

from onto_pdm.opms.errors import OpmsUnavailable
from onto_pdm.opms.mates import MatesRule, SubstituteRule, mates_rules, substitute_rules
from onto_pdm.opms.reader import Neo4jOpmsReader, OntologySnapshot, OpmsReader, RawPart, UnconfiguredOpmsReader, reader_from_env

__all__ = [
    "MatesRule",
    "Neo4jOpmsReader",
    "OntologySnapshot",
    "OpmsReader",
    "OpmsUnavailable",
    "RawPart",
    "SubstituteRule",
    "UnconfiguredOpmsReader",
    "mates_rules",
    "reader_from_env",
    "substitute_rules",
]
