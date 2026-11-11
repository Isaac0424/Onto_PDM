"""시드 데이터로 도는 메모리 저장소. 공개 범위 · BOM 전개 · 매칭 규칙은 web/src/api/mock/mockApi.ts 와 같다.

- 작업중 · 검토중 리비전과 임시저장은 작성자와 관리자 모드(admin · approver)만 본다.
- 서버를 다시 켜면 처음 상태로 돌아간다 (데모 · 시험용).
"""

from __future__ import annotations

import copy
import json
import re
import threading
from datetime import datetime, timezone
from importlib import resources
from typing import Any

from onto_pdm import rules
from onto_pdm.contracts import (
    AssemblyGuide,
    AssemblyPartInput,
    AssemblyRuleDetail,
    AssemblyRuleSummary,
    BomNode,
    BomRule,
    BomSheetMatch,
    BomSheetRowInput,
    CadPartMatch,
    DocumentLink,
    ItemDetail,
    ItemSummary,
    Material,
    PartRequest,
    PartRequestPayload,
    Product,
    ProductBom,
    Revision,
    RuleIssue,
    TaxonomyClass,
    User,
    WhereUsedRow,
)
from onto_pdm.errors import bad_request, conflict, forbidden, not_found
from onto_pdm.matching import Catalog, duplicate_candidates, match_bom_sheet_row, match_cad_part
from onto_pdm.store.base import Session

_CAMEL = re.compile(r"(?<!^)(?=[A-Z])")


def _snake(key: str) -> str:
    return _CAMEL.sub("_", key).lower()


def _snake_keys(node: Any, *, free_keys: bool = False) -> Any:
    """시드(camelCase JSON)의 키를 snake_case 로 바꾼다. 부품 속성(attributes)처럼 키가 자유 문자열인 곳은 그대로 둔다."""
    if isinstance(node, list):
        return [_snake_keys(x, free_keys=free_keys) for x in node]
    if isinstance(node, dict):
        return {
            (k if free_keys else _snake(k)): _snake_keys(v, free_keys=(not free_keys and k == "attributes"))
            for k, v in node.items()
        }
    return node


def load_seed() -> dict[str, Any]:
    raw = resources.files("onto_pdm.seed").joinpath("seed.json").read_text(encoding="utf-8")
    return _snake_keys(json.loads(raw))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class InMemoryPdmStore:
    def __init__(self, seed: dict[str, Any] | None = None) -> None:
        self._seed = seed
        self._lock = threading.RLock()
        self.reset()

    def reset(self) -> None:
        with self._lock:
            self.db: dict[str, Any] = copy.deepcopy(self._seed) if self._seed is not None else load_seed()

    # ---------- 사용자 · 기준 정보 ----------

    def list_users(self) -> list[User]:
        return [User(**u) for u in self.db["users"]]

    def find_user(self, login_id: str) -> User | None:
        return next((User(**u) for u in self.db["users"] if u["login_id"] == login_id), None)

    def list_products(self) -> list[Product]:
        return [Product(**p) for p in self.db["products"]]

    def list_classes(self) -> list[TaxonomyClass]:
        return [TaxonomyClass(**c) for c in self.db["classes"]]

    def list_materials(self) -> list[Material]:
        return [Material(**m) for m in self.db["materials"]]

    # ---------- 공개 범위 ----------

    @staticmethod
    def _can_see_revision(s: Session, r: dict[str, Any]) -> bool:
        return r["status"] in ("released", "obsolete") or s.is_admin or r["created_by"] == s.user.id

    def _visible_revisions(self, s: Session, item_id: int) -> list[dict[str, Any]]:
        revs = [r for r in self.db["revisions"] if r["item_id"] == item_id and self._can_see_revision(s, r)]
        return sorted(revs, key=lambda r: r["rev_seq"])

    def _can_see_item(self, s: Session, it: dict[str, Any]) -> bool:
        return bool(self._visible_revisions(s, it["id"])) or s.is_admin or it["created_by"] == s.user.id

    def _item(self, item_id: int) -> dict[str, Any]:
        return next(i for i in self.db["items"] if i["id"] == item_id)

    def _summarize(self, s: Session, it: dict[str, Any]) -> ItemSummary:
        revs = self._visible_revisions(s, it["id"])
        released = [r for r in revs if r["status"] == "released"]
        return ItemSummary(**it, latest_revision=Revision(**revs[-1]) if revs else None,
                           released_revision=Revision(**released[-1]) if released else None)

    def _effective_revision(self, s: Session, item_id: int, rule: BomRule) -> dict[str, Any] | None:
        """released = 최신 승인본(없으면 보이는 최신), latest = 보이는 최신 (폐기 제외)."""
        revs = [r for r in self._visible_revisions(s, item_id) if r["status"] != "obsolete"]
        if rule == "released":
            rel = [r for r in revs if r["status"] == "released"]
            if rel:
                return rel[-1]
        return revs[-1] if revs else None

    def _find_item(self, s: Session, item_no: str) -> dict[str, Any]:
        it = next((i for i in self.db["items"] if i["item_no"] == item_no), None)
        if it is None or not self._can_see_item(s, it):
            raise not_found("ITEM_NOT_FOUND", f"품목 {item_no}을(를) 찾을 수 없습니다")
        return it

    def _find_revision(self, s: Session, revision_id: int) -> dict[str, Any]:
        r = next((x for x in self.db["revisions"] if x["id"] == revision_id), None)
        if r is None or not self._can_see_revision(s, r):
            raise not_found("REVISION_NOT_FOUND", "리비전을 찾을 수 없습니다")
        return r

    # ---------- 품목 ----------

    def list_items(self, s: Session, *, q: str | None = None, item_type: str | None = None, status: str | None = None,
                   product_id: int | None = None) -> list[ItemSummary]:
        rows = [self._summarize(s, it) for it in self.db["items"] if self._can_see_item(s, it)]
        needle = (q or "").strip().lower()
        if needle:
            aliases = self._aliases_by_item()
            rows = [it for it in rows if any(needle in v.lower() for v in
                    [it.item_no, it.name, it.name_ko or "", *[a["value"] for a in aliases.get(it.id, [])]])]
        if item_type:
            rows = [it for it in rows if it.item_type == item_type]
        if status:
            rows = [it for it in rows if it.latest_revision and it.latest_revision.status == status]
        if product_id:
            p = next((x for x in self.db["products"] if x["id"] == product_id), None)
            root = next((i for i in self.db["items"] if p and i["item_no"] == p["root_item_no"]), None)
            in_product: set[int] = set()
            if root:
                in_product.add(root["id"])
                rr = self._effective_revision(s, root["id"], "released")
                if rr:
                    def walk(nodes: list[BomNode]) -> None:
                        for n in nodes:
                            in_product.add(n.item.id)
                            walk(n.children)

                    walk(self._explode(s, rr["id"], "released", 1, 1, [root["id"]]))
            rows = [it for it in rows if it.id in in_product]
        return sorted(rows, key=lambda it: it.item_no)

    def _aliases_by_item(self) -> dict[int, list[dict[str, Any]]]:
        out: dict[int, list[dict[str, Any]]] = {}
        for x in self.db["identifiers"]:
            out.setdefault(x["item_id"], []).append(x)
        return out

    def get_item(self, s: Session, item_no: str) -> ItemDetail:
        it = self._find_item(s, item_no)
        used_by = {w.parent.item_no for w in self._where_used(s, it["id"])} | {it["item_no"]}
        base = self._summarize(s, it)
        return ItemDetail(
            **base.model_dump(),
            revisions=[Revision(**r) for r in reversed(self._visible_revisions(s, it["id"]))],
            identifiers=[{"scheme": x["scheme"], "value": x["value"]} for x in self.db["identifiers"] if x["item_id"] == it["id"]],  # type: ignore[misc]
            inventory=[{k: v for k, v in row.items() if k != "item_id"} for row in self.db["inventory"] if row["item_id"] == it["id"]],  # type: ignore[misc]
            products=[Product(**p) for p in self.db["products"] if p["root_item_no"] in used_by],
        )

    # ---------- BOM ----------

    def _explode(self, s: Session, revision_id: int, rule: BomRule, depth: int, total: float, path: list[int]) -> list[BomNode]:
        if depth > 30:
            return []
        lines = [l for l in self.db["bom_lines"] if l["parent_revision_id"] == revision_id and l["child_item_id"] not in path]
        out: list[BomNode] = []
        for l in sorted(lines, key=lambda l: l.get("find_no") or 0):
            child = self._item(l["child_item_id"])
            child_rev = self._effective_revision(s, child["id"], rule)
            t = total * l["quantity"]
            out.append(BomNode(
                line_id=l["id"], depth=depth, find_no=l.get("find_no"), quantity=l["quantity"], total_quantity=t,
                item=self._summarize(s, child), revision=Revision(**child_rev) if child_rev else None,
                children=self._explode(s, child_rev["id"], rule, depth + 1, t, [*path, child["id"]]) if child_rev else [],
            ))
        return out

    def get_bom(self, s: Session, revision_id: int, rule: BomRule) -> list[BomNode]:
        r = self._find_revision(s, revision_id)
        return self._explode(s, r["id"], rule, 1, 1, [r["item_id"]])

    def get_product_bom(self, s: Session, code: str, rule: BomRule) -> ProductBom:
        p = next((x for x in self.db["products"] if x["code"] == code), None)
        if p is None:
            raise not_found("PRODUCT_NOT_FOUND", f"제품 {code}을(를) 찾을 수 없습니다")
        root = self._find_item(s, p["root_item_no"])
        rev = self._effective_revision(s, root["id"], rule)
        nodes = self._explode(s, rev["id"], rule, 1, 1, [root["id"]]) if rev else []
        return ProductBom(product=Product(**p), root_item=self._summarize(s, root), revision=Revision(**rev) if rev else None,
                          rule=rule, nodes=nodes)

    def _where_used(self, s: Session, item_id: int) -> list[WhereUsedRow]:
        out: list[WhereUsedRow] = []

        def walk(iid: int, depth: int, path: list[int]) -> None:
            for l in [x for x in self.db["bom_lines"] if x["child_item_id"] == iid]:
                pr = next(r for r in self.db["revisions"] if r["id"] == l["parent_revision_id"])
                if pr["status"] == "obsolete" or not self._can_see_revision(s, pr) or pr["item_id"] in path:
                    continue
                out.append(WhereUsedRow(depth=depth, parent=self._summarize(s, self._item(pr["item_id"])),
                                        parent_revision=Revision(**pr), quantity=l["quantity"]))
                walk(pr["item_id"], depth + 1, [*path, pr["item_id"]])

        walk(item_id, 1, [item_id])
        return out

    def get_where_used(self, s: Session, item_id: int) -> list[WhereUsedRow]:
        it = next((i for i in self.db["items"] if i["id"] == item_id), None)
        if it is None or not self._can_see_item(s, it):
            raise not_found("ITEM_NOT_FOUND", "품목을 찾을 수 없습니다")
        return self._where_used(s, item_id)

    def get_documents(self, s: Session, revision_id: int) -> list[DocumentLink]:
        self._find_revision(s, revision_id)
        docs = {d["id"]: d for d in self.db["documents"]}
        out: list[DocumentLink] = []
        for l in self.db["doc_links"]:
            if l["revision_id"] != revision_id:
                continue
            d = docs[l["document_id"]]
            out.append(DocumentLink(
                document_id=d["id"], doc_no=d["doc_no"], title=d["title"], doc_type=d["doc_type"], link_type=l["link_type"],
                rev=d["rev"], pinned=l["pinned"], file_name=d.get("file_name"), match_method=l["match_method"],
                confidence=l.get("confidence"), status=l["status"],
            ))
        return out

    # ---------- 매칭 · 규칙 ----------

    def _catalog(self, s: Session) -> Catalog:
        return Catalog(items=[it for it in self.db["items"] if self._can_see_item(s, it)],
                       identifiers={k: [{"scheme": a["scheme"], "value": a["value"]} for a in v] for k, v in self._aliases_by_item().items()},
                       classes=self.db["classes"])

    def match_cad_parts(self, s: Session, names: list[str]) -> list[CadPartMatch]:
        cat = self._catalog(s)
        return [CadPartMatch(**match_cad_part(cat, n)) for n in names]

    def match_bom_sheet(self, s: Session, rows: list[BomSheetRowInput]) -> list[BomSheetMatch]:
        cat = self._catalog(s)
        return [BomSheetMatch(**match_bom_sheet_row(cat, r.model_dump())) for r in rows]

    def get_assembly_guides(self, parts: list[AssemblyPartInput]) -> list[AssemblyGuide]:
        return [g for p in parts if (g := rules.guide_for(p)) is not None]

    def list_assembly_rules(self) -> list[AssemblyRuleSummary]:
        return rules.summarize_rules()

    def get_assembly_rule(self, s: Session, rule_id: str) -> AssemblyRuleDetail:
        used = [(it["item_no"], it.get("name_ko") or it["name"]) for it in self.db["items"]
                if self._can_see_item(s, it) and rules.rule_matches(rule_id, it.get("name_ko") or it["name"])]
        detail = rules.describe_rule(rule_id, used)
        if detail is None:
            raise not_found("RULE_NOT_FOUND", "규칙을 찾을 수 없습니다")
        return detail

    def validate_assembly_rules(self) -> list[RuleIssue]:
        return rules.validate_rules()

    # ---------- 그래프 발행 ----------

    def export_publication(self, code: str) -> dict[str, Any]:
        p = next((x for x in self.db["products"] if x["code"] == code), None)
        if p is None:
            raise not_found("PRODUCT_NOT_FOUND", f"제품 {code}을(를) 찾을 수 없습니다")
        root = next((i for i in self.db["items"] if i["item_no"] == p["root_item_no"]), None)
        if root is None:
            raise not_found("ITEM_NOT_FOUND", f"제품 {code}의 최상위 품목을 찾을 수 없습니다")

        items: dict[int, dict[str, Any]] = {}
        revisions: list[dict[str, Any]] = []
        lines: list[dict[str, Any]] = []
        stack = [root["id"]]
        while stack:  # 승인본 BOM 을 따라 닫힌 집합: 발행한 리비전이 담은 자식도 PdmItem 이어야 CONTAINS 를 이을 수 있다
            item_id = stack.pop()
            if item_id in items:
                continue
            items[item_id] = self._item(item_id)
            for r in self.db["revisions"]:
                if r["item_id"] != item_id or r["status"] not in ("released", "obsolete"):
                    continue
                revisions.append(r)
                for l in self.db["bom_lines"]:
                    if l["parent_revision_id"] == r["id"]:
                        lines.append({"revision_id": r["id"], "child_item_id": l["child_item_id"], "quantity": l["quantity"],
                                      "find_no": l.get("find_no")})
                        stack.append(l["child_item_id"])

        current = []
        for item_id in items:
            released = [r for r in revisions if r["item_id"] == item_id and r["status"] == "released"]
            if released:
                current.append({"item_id": item_id, "revision_id": max(released, key=lambda r: r["rev_seq"])["id"]})
        materials = {m["iri"]: m for m in self.db["materials"]}
        used = {materials[i["material_iri"]]["name"]: materials[i["material_iri"]]["density"]
                for i in items.values() if i.get("material_iri") in materials}
        return {
            "product": {"id": p["id"], "code": p["code"], "name": p["name"], "root_item_id": root["id"]},
            "items": sorted(items.values(), key=lambda i: i["id"]),
            "revisions": sorted(revisions, key=lambda r: r["id"]),
            "lines": lines,
            "current": current,
            "identifiers": [{"item_id": x["item_id"], "scheme": x["scheme"], "value": x["value"]}
                            for x in self.db["identifiers"] if x["item_id"] in items],
            "materials": [{"concept_code": name, "density": d} for name, d in sorted(used.items())],
        }

    # ---------- 등록 요청 ----------

    def _find_request(self, s: Session, request_id: int) -> dict[str, Any]:
        r = next((x for x in self.db["part_requests"] if x["id"] == request_id), None)
        if r is None or (r["requested_by"] != s.user.id and not s.is_admin):
            raise not_found("REQUEST_NOT_FOUND", "등록 요청을 찾을 수 없습니다")
        return r

    def list_part_requests(self, s: Session, scope: str) -> list[PartRequest]:
        if scope == "all" and not s.is_admin:
            raise forbidden("ADMIN_MODE_REQUIRED", "관리자 모드에서만 할 수 있습니다")
        rows = [r for r in self.db["part_requests"] if scope == "all" or r["requested_by"] == s.user.id]
        return [PartRequest(**r) for r in sorted(rows, key=lambda r: r["updated_at"], reverse=True)]

    def get_part_request(self, s: Session, request_id: int) -> PartRequest:
        return PartRequest(**self._find_request(s, request_id))

    def save_part_request(self, s: Session, request_id: int | None, payload: PartRequestPayload) -> PartRequest:
        body = payload.model_dump(exclude_none=True)
        with self._lock:
            if request_id is None:
                r: dict[str, Any] = {
                    "id": max([0, *[x["id"] for x in self.db["part_requests"]]]) + 1, "source_system": "PDM", "status": "draft",
                    "payload": body, "requested_by": s.user.id, "created_at": _now(), "updated_at": _now(),
                }
                self.db["part_requests"].append(r)
                return PartRequest(**r)
            r = self._find_request(s, request_id)
            if r["requested_by"] != s.user.id:
                raise forbidden("NOT_REQUEST_OWNER", "다른 사람의 요청은 고칠 수 없습니다")
            if r["status"] != "draft":
                raise conflict("REQUEST_NOT_DRAFT", "임시저장 상태에서만 고칠 수 있습니다")
            r["payload"] = body
            r["updated_at"] = _now()
            return PartRequest(**r)

    def submit_part_request(self, s: Session, request_id: int) -> PartRequest:
        with self._lock:
            r = self._find_request(s, request_id)
            if r["requested_by"] != s.user.id:
                raise forbidden("NOT_REQUEST_OWNER", "다른 사람의 요청은 제출할 수 없습니다")
            if r["status"] != "draft":
                raise conflict("REQUEST_NOT_DRAFT", "임시저장 상태에서만 제출할 수 있습니다")
            name = (r["payload"].get("name") or "").strip()
            if not name:
                raise bad_request("NAME_REQUIRED", "제출하려면 이름이 필요합니다")
            r["status"] = "submitted"
            r["duplicate_check"] = duplicate_candidates(
                self.db["items"], self.db["identifiers"], r["payload"]["name"],
                [a["value"] for a in r["payload"].get("aliases", [])])
            r["updated_at"] = _now()
            return PartRequest(**r)
