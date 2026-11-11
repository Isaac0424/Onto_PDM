import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AssemblyGuide, AssemblyOperation } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { RuleCardBody, ruleCaption } from './RuleHudCard';
import type { RuleHudView } from './useRuleSelection';

const OPERATION_ICON: Record<AssemblyOperation, string> = {
  fasten: 'construction', weld: 'local_fire_department', press_fit: 'compress', mount: 'memory', insert: 'login', cover: 'check_box_outline_blank',
};

/** 자막처럼 한 글자씩 나타나게 한다. 모션을 줄이는 설정이면 바로 보인다 */
export function useTypewriter(text: string): string {
  const [n, setN] = useState(0);
  useEffect(() => {
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !text) { setN(text.length); return; }
    setN(0);
    const stepMs = Math.min(24, 900 / text.length);          // 아무리 길어도 1초 안에 다 나온다
    const id = setInterval(() => setN(v => { if (v + 1 >= text.length) clearInterval(id); return v + 1; }), stepMs);
    return () => clearInterval(id);
  }, [text]);
  return text.slice(0, n);
}

/**
 * 3D 무대 위에 겹쳐 뜨는 조립 안내 (영화 속 시스템 화면처럼): 오른쪽 빈 곳에 카드, 아래에 자막.
 * 카드는 부품에 적용되는 사내 규칙의 값 · 주의사항 · 공구를 보이고, 자막은 지금 할 일을 한 줄로 말한다.
 * 뷰어의 무대(.stage) 안으로 포털을 열어 3D 화면과 같은 자리에 겹친다.
 */
export function AssemblyHud({
  stage, guide, partName, stepNo, total, connected = true, rulesMissing = false, rules, toolName, onPickRole,
}: {
  stage: HTMLElement | null;
  guide?: AssemblyGuide;
  /** 지금 보고 있는 부품 (없으면 안내 문구만) */
  partName?: string;
  stepNo: number;
  total: number;
  /** 조립 규칙을 읽어 올 곳(OPMS)에 연결돼 있는가. 아니면 규칙이 없는 것이 아니라 아직 읽을 수 없다고 말한다 */
  connected?: boolean;
  /** OPMS 는 읽고 있지만(분류 · 부품) 조립 규칙 데이터는 OPMS 에 아직 없다: "연결되면"이 아니라 "아직 데이터가 없다"고 말한다 */
  rulesMissing?: boolean;
  /** 규칙집(rules/)을 읽는 길이 있을 때: 고른 부품에 적용되는 규칙(확정 기준 · CAD 추정 기준 · 확정하면 적용되는 규칙)을 카드에 보인다. 있으면 guide 는 쓰지 않는다 */
  rules?: RuleHudView;
  toolName?(id: string): string;
  /** 규칙이 이 볼트의 역할을 알아야 정해질 때 사람이 역할을 고른다 */
  onPickRole?(role: string | undefined): void;
}) {
  const [open, setOpen] = useState(true);
  const caption = rules ? (partName ? (ruleCaption(rules, partName) ?? `${partName}: 조립 규칙을 찾는 중…`) : '단계나 부품을 고르면 이 부품에 적용되는 조립 규칙이 이 위에 뜹니다. 부품을 더블클릭하면 그 부품으로 시점이 맞춰져요.')
    : guide ? guide.caption
    : partName ? (connected ? `${partName}: 이 부품에 연결된 사내 조립 규칙이 아직 없습니다.`
      : rulesMissing ? `${partName}: 조립 규칙 데이터는 아직 OPMS에 없어요.` : `${partName}: 조립 규칙은 OPMS에 연결되면 이 위에 표시돼요.`)
    : connected ? '단계나 부품을 고르면 조립 규칙이 이 위에 뜹니다. 부품을 더블클릭하면 그 부품으로 시점이 맞춰져요.'
    : rulesMissing ? '부품을 더블클릭하면 그 부품으로 시점이 맞춰져요. 조립 규칙 데이터는 아직 OPMS에 없어요.'
    : '부품을 더블클릭하면 그 부품으로 시점이 맞춰져요. 조립 규칙은 OPMS에 연결되면 이 위에 표시돼요.';
  const typed = useTypewriter(caption);
  if (!stage) return null;

  return createPortal(
    <>
      {(guide || partName) && (
        <aside className={`hud-card ${open ? '' : 'hud-card-min'}`} aria-label="조립 안내" key={guide?.ruleId ?? partName}>
          <header className="hud-card-head">
            <span className="hud-step mono">STEP {stepNo > 0 ? stepNo : '-'} / {total}</span>
            {guide && <span className="hud-op"><Icon name={OPERATION_ICON[guide.operation]} size={14} />{guide.operationLabel}</span>}
            <span className="spacer" />
            <button type="button" className="hud-fold" aria-label={open ? '안내 접기' : '안내 펼치기'} aria-expanded={open} onClick={() => setOpen(o => !o)}>
              <Icon name={open ? 'remove' : 'add'} size={16} />
            </button>
          </header>
          {open && rules && partName && <RuleCardBody view={rules} partName={partName} toolName={toolName ?? (id => id)} {...(onPickRole ? { onPickRole } : {})} />}
          {open && !rules && (guide ? (
            <div className="hud-card-body">
              <h3 className="hud-title">{guide.title}</h3>
              <dl className="hud-params">
                {guide.params.map(p => (
                  <div key={p.label}>
                    <dt>{p.label}</dt>
                    <dd>{p.value}{p.ok !== undefined && <Icon name={p.ok ? 'check_circle' : 'warning'} size={14} className={p.ok ? 'hud-ok' : 'hud-warn'} />}</dd>
                  </div>
                ))}
              </dl>
              {guide.cautions.length > 0 && (
                <ul className="hud-cautions" aria-label="주의사항">
                  {guide.cautions.map(c => <li key={c}><Icon name="warning" size={14} />{c}</li>)}
                </ul>
              )}
              {guide.tools.length > 0 && <p className="hud-tools"><Icon name="build" size={14} />{guide.tools.join(' · ')}</p>}
              <footer className="hud-source mono" title={guide.source}>{guide.ruleId} · {guide.ruleName}</footer>
            </div>
          ) : (
            <div className="hud-card-body"><h3 className="hud-title">{partName}</h3><p className="hud-none">{connected ? '연결된 규칙 없음' : rulesMissing ? '조립 규칙 데이터가 아직 없어요' : 'OPMS에 연결되면 표시돼요'}</p></div>
          ))}
        </aside>
      )}
      <p className="hud-sub" role="status" aria-label={caption}><span aria-hidden>{typed}</span><i className="hud-caret" aria-hidden /></p>
    </>,
    stage,
  );
}
