import { Link } from 'react-router-dom';
import type { RulebookCaution, SelectedRule } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { Badge } from '../../components/ui';
import { DraftChip, ValueCell, paramLabel, roleShort, unitOfKey } from '../rules/rulebookUi';
import type { RuleHudView } from './useRuleSelection';
import '../rules/rules.css';

const CAPTION_MAX = 110;
const clip = (s: string) => (s.length > CAPTION_MAX ? `${s.slice(0, CAPTION_MAX - 1)}…` : s);
const isWarning = (c: RulebookCaution) => c.level === '경고' || c.level === '주의';

/** 아래 자막 한 줄: 적용되는 규칙의 경고 문구(없으면 규칙 이름). 추정 기준이면 추정이라고 밝힌다 */
export function ruleCaption(view: RuleHudView | undefined, partName: string): string | undefined {
  if (!view || view.status === 'loading') return undefined;
  if (view.status === 'idle') return `${partName}: 종류를 알 수 없어 규칙을 고를 수 없어요. 볼트는 형상으로 종류를 확정하면 규칙이 떠요.`;
  if (view.status === 'off') return `${partName}: ${view.kind === 'backend_down' ? 'PDM 백엔드가 꺼져 있어 조립 규칙을 읽지 못했어요.' : '조립 규칙(rules/)을 읽지 못했어요.'}`;
  const first = view.applied[0];
  const prefix = view.basis === 'estimated' ? '(CAD 추정) ' : '';
  if (first) {
    const cautions = view.applied.flatMap(r => r.rule.cautions);
    const c = cautions.find(isWarning) ?? cautions[0];
    return clip(`${prefix}${c ? c.text : `${first.rule.name} 규칙이 적용돼요.`}`);
  }
  if (view.pending.length > 0) return `${partName}: 역할 · 규격을 확정하면 적용되는 규칙이 정해져요. (후보 ${view.pending.length}개)`;
  return `${partName}: 이 분류에 연결된 조립 규칙이 아직 없어요.`;
}

/** 규칙 하나의 값: 파라미터 + 모델로 정해진 표의 행. 비어 있거나 확정값이 아닌 것은 값 자리에서 구분된다 */
function RuleBlock({ s, toolName }: { s: SelectedRule; toolName(id: string): string }) {
  const { rule } = s;
  const row = s.lookup?.status === 'selected' ? s.lookup.rows[0] : undefined;
  const choices = s.lookup?.status === 'candidates' ? s.lookup.rows : [];
  const cautions = [...rule.cautions].sort((a, b) => Number(isWarning(b)) - Number(isWarning(a))).slice(0, 2);
  return (
    <li className="hud-rule">
      <p className="hud-rule-head">
        <Link to={`/rules/${rule.id}`} className="mono hud-rule-id" title="규칙 상세 보기">{rule.id}</Link>
        <span className="hud-rule-name">{rule.name}</span>
      </p>
      <dl className="hud-params">
        {rule.parameters.slice(0, 4).map(p => (
          <div key={p.name}><dt>{paramLabel(p.name)}</dt><dd><ValueCell item={p} value={p.value} {...(p.unit ? { unit: p.unit } : {})} /></dd></div>
        ))}
        {row && Object.entries(row.values).map(([k, v]) => (
          <div key={k}><dt>{paramLabel(k)}</dt><dd><ValueCell item={row} value={v} {...(unitOfKey(k) ? { unit: unitOfKey(k)! } : {})} /></dd></div>
        ))}
      </dl>
      {s.lookup?.status === 'all' && <p className="hud-hint">로봇 모델을 알면 값이 하나로 정해져요 ({s.lookup.rows.map(r => r.key).join(' · ')})</p>}
      {choices.length > 1 && <p className="hud-hint">값이 모델마다 달라요 ({choices.map(r => r.key).join(' · ')})</p>}
      {cautions.length > 0 && (
        <ul className="hud-cautions" aria-label={`${rule.id} 주의사항`}>
          {cautions.map(c => (
            <li key={c.text}>
              <Icon name={isWarning(c) ? 'warning' : 'info'} size={14} />
              <span><Badge tone={isWarning(c) ? 'warning' : 'info'}>{c.level}</Badge> {c.text}{c.refs[0] && <small className="hud-ref"> {c.refs[0].label}</small>}</span>
            </li>
          ))}
        </ul>
      )}
      {rule.tools.length > 0 && <p className="hud-tools"><Icon name="build" size={14} />{rule.tools.map(toolName).join(' · ')}</p>}
    </li>
  );
}

/** 무엇을 확정하면 규칙이 정해지는가: 역할 · 나사 규격 · 로봇 모델 */
function needText(s: SelectedRule): string {
  const parts = s.unknownConditions.map(c => (c.kind === 'role' ? '이 볼트의 역할' : c.kind === 'model' ? '로봇 모델' : c.kind === 'attribute' ? paramLabel(c.key) : c.key));
  return `알아야 확정돼요: ${[...new Set(parts)].join(' · ')}`;
}

/** HUD 카드 본문(규칙집 기준). 적용되는 규칙과 조건을 몰라 확정 못 하는 규칙을 구분하고, 모두 초안(검토 전)임을 밝힌다 */
export function RuleCardBody({ view, partName, toolName, onPickRole }: {
  view: RuleHudView; partName: string; toolName(id: string): string; onPickRole?(role: string | undefined): void;
}) {
  if (view.status === 'loading') return <div className="hud-card-body"><h3 className="hud-title">{partName}</h3><p className="hud-none">규칙을 찾는 중…</p></div>;
  if (view.status === 'idle') {
    return <div className="hud-card-body"><h3 className="hud-title">{partName}</h3><p className="hud-none">종류를 알 수 없어 규칙을 고를 수 없어요. 볼트는 형상으로 종류를 확정하면 규칙이 떠요.</p></div>;
  }
  if (view.status === 'off') {
    return (
      <div className="hud-card-body">
        <h3 className="hud-title">{partName}</h3>
        <p className="hud-none" role="status">{view.kind === 'backend_down' ? 'PDM 백엔드가 꺼져 있어 조립 규칙을 읽지 못했어요.' : view.kind === 'invalid' ? '규칙집(rules/)에 오류가 있어 규칙을 보여 드릴 수 없어요.' : '규칙집(rules/)을 읽지 못했어요.'}</p>
      </div>
    );
  }
  const { applied, pending } = view;
  return (
    <div className="hud-card-body">
      <h3 className="hud-title">{partName}</h3>
      <p className="hud-basis">
        {view.basis === 'estimated'
          ? <Badge tone="warning" title="CAD 형상이 추정한 분류 · 규격이에요. 사람이 확정하면 더 정확해져요.">CAD 추정 기준</Badge>
          : <Badge tone="success" title="사람이 확정한 분류 · 규격 기준이에요.">확정 기준</Badge>}
        <span className="chip">{view.classCode}</span>
        {view.model ? <span className="chip" title="파일 · 부품 이름에서 읽었어요">{view.model}</span> : <span className="chip faint" title="파일 · 부품 이름에서 모델을 읽지 못했어요">모델 미확인</span>}
        <DraftChip status="unreviewed" />
      </p>

      {applied.length > 0 && (
        <section aria-label="적용되는 규칙">
          <h4 className="hud-sub-h">{view.basis === 'estimated' ? '적용될 것으로 보는 규칙' : '적용되는 규칙'} {applied.length}</h4>
          <ul className="hud-rules">{applied.slice(0, 3).map(s => <RuleBlock key={s.rule.id} s={s} toolName={toolName} />)}</ul>
          {applied.length > 3 && <p className="hud-hint">나머지 {applied.length - 3}개는 <Link to="/rules">조립 규칙</Link>에서 볼 수 있어요.</p>}
        </section>
      )}

      {pending.length > 0 && (
        <section aria-label="확정하면 적용되는 규칙">
          <h4 className="hud-sub-h">확정하면 적용되는 규칙 {pending.length}</h4>
          <ul className="hud-pending">
            {pending.map(s => (
              <li key={s.rule.id}>
                <Link to={`/rules/${s.rule.id}`} className="mono hud-rule-id">{s.rule.id}</Link> {s.rule.name}
                <small className="hud-hint">{needText(s)}</small>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.roleChoices.length > 0 && onPickRole && (
        <section aria-label="이 부품의 역할">
          <h4 className="hud-sub-h">이 볼트의 역할은?</h4>
          <div className="hud-roles" role="group" aria-label="역할 고르기">
            {view.roleChoices.map(r => (
              <button key={r.role} type="button" className="rule-chip" aria-pressed={view.role === r.role} title={r.label}
                onClick={() => onPickRole(view.role === r.role ? undefined : r.role)}>{roleShort(r.label, r.role)}</button>
            ))}
          </div>
          <p className="hud-hint">역할은 사람이 정해요. 고르면 그 역할의 규칙이 정해져요.</p>
        </section>
      )}

      {applied.length === 0 && pending.length === 0 && <p className="hud-none">이 분류에 연결된 조립 규칙이 아직 없어요.</p>}
    </div>
  );
}
