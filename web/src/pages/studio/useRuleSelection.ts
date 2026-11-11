import { useEffect, useMemo, useState } from 'react';
import { RulebookError, type PdmApi, type RuleSelectResponse, type SelectedRule, type TaxonomyClass } from '../../api/types';

/** 고른 부품에 규칙집(rules/)을 적용하려고 보내는 것. 분류 · 속성은 사람이 확정한 것이거나(confirmed), CAD 형상이 충분히 확실하게 추정한 것(estimated)이다 */
export interface RuleSelectionInput {
  classCode: string;
  /** confirmed: 사람이 확정한 분류 + 확정한 속성만 보낸다 · estimated: 형상이 추정한 분류와 속성 — 규칙이 적용된다고 단정하지 않는다 */
  basis: 'confirmed' | 'estimated';
  attributes: Record<string, string | number>;
  role?: string;
  model?: string;
  /** OPMS 에 아직 없는 분류(제안)의 상위 분류. 상위 분류의 규칙(볼트 전반)이 적용되게 한다 */
  parentCode?: string;
}

export interface RoleChoice { role: string; label: string }

/** HUD 카드가 보이는 규칙 적용 결과 */
export type RuleHudView =
  | { status: 'loading' }
  | { status: 'idle' }                                                           // 분류를 알 수 없는 부품: 규칙을 고를 수 없다
  | { status: 'off'; kind: 'backend_down' | 'invalid' | 'unavailable'; message: string }
  | {
      status: 'ready'; basis: 'confirmed' | 'estimated'; classCode: string; model?: string; role?: string;
      /** 조건이 모두 확인돼 적용되는 규칙 */
      applied: SelectedRule[];
      /** 값(역할 · 나사 규격 …)을 몰라 적용 여부를 단정할 수 없는 규칙 */
      pending: SelectedRule[];
      /** 사람이 고르면 규칙이 정해지는 역할 */
      roleChoices: RoleChoice[];
    };

/** 응답 → 카드 모양. 역할 선택지는 '역할을 몰라서' 확정 못 한 규칙의 역할이다 */
export function buildRuleView(res: RuleSelectResponse, basis: 'confirmed' | 'estimated', input: RuleSelectionInput): RuleHudView {
  const applied = res.rules.filter(r => r.applicable === 'yes');
  const pending = res.rules.filter(r => r.applicable === 'unknown');
  const choices = new Map<string, string>();
  for (const r of pending) {
    if (r.unknownConditions.some(c => c.kind === 'role') && r.rule.appliesTo.role) choices.set(r.rule.appliesTo.role, r.rule.appliesTo.roleLabel ?? r.rule.appliesTo.role);
  }
  // 이미 고른 역할은 선택지에 남겨 둔다: 그 역할의 규칙은 이제 '적용'으로 옮겨 가므로, 남기지 않으면 다시 눌러 해제할 수 없다
  if (input.role && !choices.has(input.role)) {
    const owner = res.rules.find(r => r.rule.appliesTo.role === input.role);
    choices.set(input.role, owner?.rule.appliesTo.roleLabel ?? input.role);
  }
  return {
    status: 'ready', basis, classCode: input.classCode, ...(input.model ? { model: input.model } : {}), ...(input.role ? { role: input.role } : {}),
    applied, pending, roleChoices: [...choices].map(([role, label]) => ({ role, label })),
  };
}

/** 분류 코드 → 루트부터 그 분류까지의 코드 목록. OPMS 에 없는 분류(제안)는 상위 분류의 경로 뒤에 붙인다 */
export function classPathOf(classes: readonly TaxonomyClass[], code: string, parentCode?: string): string[] {
  const byCode = new Map(classes.map(c => [c.code, c] as const));
  const up = (c: string): string[] => {
    const out: string[] = [];
    for (let cur: string | undefined = c, guard = 0; cur && guard < 32; guard++) {
      out.unshift(cur);
      const parentIri: string | undefined = byCode.get(cur)?.parentIri;
      cur = parentIri?.replace(/^cls:/, '');
    }
    return out;
  };
  if (byCode.has(code)) return up(code);
  return parentCode && byCode.has(parentCode) ? [...up(parentCode), code] : [code];
}

/**
 * 고른 부품에 적용되는 규칙(규칙집, 백엔드 /rulebook/select). 같은 요청은 API 가 한 번만 보낸다(기억). 입력이 없으면(분류를 모르는 부품) 아무것도 묻지 않는다.
 * 규칙집을 읽을 수 없으면(백엔드 꺼짐 · rules/ 오류) 이유를 구분해 돌려주고, 부품을 바꿀 때마다 다시 시도한다.
 */
export function useRuleSelection(api: PdmApi, input: RuleSelectionInput | undefined): { view: RuleHudView | undefined; toolName(id: string): string } {
  const rb = api.rulebook;
  const [classes, setClasses] = useState<TaxonomyClass[] | undefined>();
  const [tools, setTools] = useState<Map<string, string>>();
  useEffect(() => {
    let alive = true;
    if (!rb || !input) return;
    api.listClasses().then(c => { if (alive) setClasses(c); }, () => { if (alive) setClasses([]); });
    if (!tools) rb.listTools().then(t => { if (alive) setTools(new Map(t.map(x => [x.id, x.nameKo] as const))); }, () => { if (alive) setTools(new Map()); });
    return () => { alive = false; };
    // 분류 목록은 API 가 기억하므로 입력이 처음 생길 때 한 번이면 된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, rb, !!input]);

  const key = useMemo(() => (input ? JSON.stringify([input.classCode, input.basis, Object.entries(input.attributes).sort(([a], [b]) => a.localeCompare(b)), input.role ?? null, input.model ?? null]) : ''), [input]);
  const [view, setView] = useState<{ key: string; view: RuleHudView } | undefined>();

  useEffect(() => {
    let alive = true;
    if (!rb || !input || classes === undefined) return;                           // 분류 목록이 읽힌 뒤에 묻는다: 경로가 정해져야 같은 요청을 한 번만 보낸다
    const path = classPathOf(classes, input.classCode, input.parentCode);
    setView(v => (v?.key === key ? v : { key, view: { status: 'loading' } }));
    rb.selectRules({
      classCode: input.classCode, classPath: path, attributes: input.attributes,
      ...(input.role ? { role: input.role } : {}), ...(input.model ? { model: input.model } : {}),
    }).then(
      res => { if (alive) setView({ key, view: buildRuleView(res, input.basis, input) }); },
      e => {
        if (!alive) return;
        const kind = e instanceof RulebookError ? e.kind : 'unavailable';
        setView({ key, view: { status: 'off', kind, message: e instanceof Error ? e.message : '규칙집을 읽지 못했어요.' } });
      },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rb, key, classes]);

  const toolName = (id: string) => tools?.get(id) ?? id;
  if (!rb) return { view: undefined, toolName };
  if (!input) return { view: { status: 'idle' }, toolName };
  return { view: view?.key === key ? view.view : { status: 'loading' }, toolName };
}
