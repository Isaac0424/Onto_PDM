// 조립 규칙 · 작업표준 화면이 같이 쓰는 조각: 출처 배지, 값 표시, 규칙집 상태 안내.
// 규칙 값은 이 파일에 없다 — 값 · 출처 · 근거 문구는 모두 백엔드(rules/)가 준다. 여기에는 기계 키의 한글 이름 같은 '표시 이름'만 있다.
import { useCallback, useEffect, useState } from 'react';
import type { RulebookGrade, RulebookParam, RulebookSource, RulebookSourced, RulebookStatus, RulebookValue } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { Badge } from '../../components/ui';
import type { Tone } from '../../labels';

/** 파라미터 · 표 열 키 → 화면 이름. 모르는 키는 키를 읽기 좋게 바꿔 보인다(값을 지어내지 않는다) */
const PARAM_LABEL: Record<string, string> = {
  quantity: '수량', torque_nm: '체결 토크', torque_policy: '토크 기준', threadSize: '나사 규격', length_mm: '길이', length_min_mm: '최소 길이',
  pin_diameter_mm: '위치 결정 핀 지름', washer: '와셔', plug: '플러그', conditions: '조건', reference_standards: '참고 표준', items_ref: '항목 참조',
  flange_standard: '툴 플랜지 규격', input_voltage_vac: '입력 전압', input_frequency_hz: '입력 주파수', external_fuse_a: '외부 퓨즈',
  hcr12a_tilt_limit_deg: 'HCR-12A 기울기 한계', speed_threshold_deg_s: '속도 기준', min_cycle_months: '최소 점검 주기', sequence: '체결 순서',
  allowed_mounting: '허용 설치 방식', arm_weight_kg: '로봇 암 무게', controller_weight_kg: '컨트롤러 무게', angle_deg: '설치 각도', torque_range: '토크 범위',
};
export function paramLabel(name: string): string {
  return PARAM_LABEL[name] ?? name.replace(/_(mm|nm|deg|kg|vac|hz|a|s)$/i, '').replace(/_/g, ' ');
}

/** 표(lookup)의 열 키 끝에 붙은 단위: length_mm → mm, torque_nm → N·m … (값마다 단위가 따로 오지 않는다) */
export function unitOfKey(key: string): string | undefined {
  const m = /_(mm|nm|kg|deg|hz|vac)$/i.exec(key)?.[1]?.toLowerCase();
  return m === 'mm' ? 'mm' : m === 'nm' ? 'N·m' : m === 'kg' ? 'kg' : m === 'deg' ? '°' : m === 'hz' ? 'Hz' : m === 'vac' ? 'VAC' : undefined;
}

/** 값 표시: 목록은 ' · '로 잇고, 단위가 있으면 붙인다. 값이 비어 있으면 undefined */
export function formatValue(value: RulebookValue | undefined, unit?: string): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const text = Array.isArray(value) ? value.join(' · ') : typeof value === 'boolean' ? (value ? '예' : '아니오') : String(value);
  return unit && !Array.isArray(value) ? `${text} ${unit}` : text;
}

const GRADE_TONE: Record<RulebookGrade, Tone> = { manual: 'success', standard: 'info', cad: 'warning', unknown: 'neutral' };
export const GRADE_TEXT: Record<RulebookGrade, string> = { manual: '사용설명서', standard: '표준 참고', cad: 'CAD 추정', unknown: '근거 없음' };

/**
 * 출처 배지. manual 은 근거 위치(쪽 번호)를, cad 는 'CAD 추정'(호박색), unknown 은 '근거 없음 · 작성 필요 G-0xx'(회색)를 말한다.
 * 확정값처럼 보여도 되는 것(confirmed)은 초록 하나뿐이다.
 */
export function SourceBadge({ item, compact = false }: { item: Pick<RulebookSourced, 'source' | 'refs' | 'gapId' | 'estimated' | 'approvalRequired'>; compact?: boolean }) {
  const { source, refs, gapId } = item;
  const first = refs[0]?.label;
  const text = source === 'manual' ? (first ?? GRADE_TEXT.manual)
    : source === 'unknown' ? (gapId ? `근거 없음 · 작성 필요 ${gapId}` : GRADE_TEXT.unknown)
    : source === 'standard' ? `${GRADE_TEXT.standard} · 승인 전`
    : GRADE_TEXT.cad;
  const title = [refs.map(r => r.label).join(' / '), item.estimated ? '추정' : '', item.approvalRequired ? '설계 승인 전 사용 금지' : ''].filter(Boolean).join(' · ')
    || (source === 'unknown' ? '근거가 없어 값을 비워 뒀어요' : undefined);
  return <Badge tone={GRADE_TONE[source]} {...(title ? { title } : {})}>{compact && source === 'manual' ? '설명서' : text}</Badge>;
}

/** 값 한 칸. 비어 있으면 '작성 필요', 확정값이 아니면(CAD 추정 · 표준 참고 · 추정) 점선으로 구분한다 */
export function ValueCell({ item, value, unit }: { item: RulebookSourced; value: RulebookValue | undefined; unit?: string }) {
  const text = formatValue(value, unit);
  if (text === undefined) return <span className="rb-empty" title="근거가 없어 값을 비워 뒀어요">{item.gapId ? `작성 필요 ${item.gapId}` : '작성 필요'}</span>;
  if (!item.confirmed) return <span className="rb-unconfirmed" title="확정값이 아니에요. 사용설명서 근거가 없거나 추정이에요.">{text}</span>;
  return <span className="rb-value">{text}</span>;
}

export function ParamRow({ p }: { p: RulebookParam }) {
  return (
    <tr>
      <th scope="row">{paramLabel(p.name)}</th>
      <td>
        <ValueCell item={p} value={p.value} {...(p.unit ? { unit: p.unit } : {})} />
        {p.condition && <small className="rb-note">조건: {p.condition}</small>}
        {p.note && <small className="rb-note">{p.note}</small>}
      </td>
      <td><SourceBadge item={p} /></td>
    </tr>
  );
}

/** 초안 표시: 모든 규칙 · 작업표준서는 사람 검토 전이다 */
export function DraftChip({ status }: { status: string }) {
  return status === 'unreviewed'
    ? <Badge tone="warning" title="사람 검토 전의 초안이에요. 설계 · 공정 담당의 검토 뒤에 실제 작업에 쓰세요.">초안 · 검토 전</Badge>
    : <Badge tone="success">{status}</Badge>;
}

/** 역할 이름: '… (사용설명서 3.3)' 처럼 뒤에 붙은 근거 괄호를 뗀다 */
export const roleShort = (label: string | undefined, role?: string) => (label ? label.replace(/\s*\([^)]*\)\s*$/, '') : (role ?? ''));

/** 규칙집 상태. api.rulebook 이 없으면 undefined, 확인 중이면 'loading' */
export type RulebookStatusValue = RulebookStatus | 'loading' | undefined;

export function useRulebookStatus(rb: RulebookSource | undefined) {
  const [status, setStatus] = useState<RulebookStatusValue>(rb ? 'loading' : undefined);
  const check = useCallback(async () => {
    if (!rb) { setStatus(undefined); return; }
    setStatus('loading');
    setStatus(await rb.status());
  }, [rb]);
  useEffect(() => { void check(); }, [check]);
  return { status, retry: check };
}

/** 규칙집을 읽지 못할 때의 안내. 연결 안 됨은 오류가 아니라 상태이고, rules/ 검증 오류는 목록을 펼쳐 보인다(빨강 대신 호박색) */
export function RulebookNotice({ status, onRetry }: { status: RulebookStatus; onRetry(): void }) {
  const down = status.state === 'backend_down';
  const title = down ? 'PDM 백엔드가 꺼져 있어요'
    : status.state === 'invalid' ? '조립 규칙 · 작업표준(rules/)에 오류가 있어 보여 드릴 수 없어요'
    : '조립 규칙 · 작업표준(rules/)을 읽지 못했어요';
  return (
    <section className={`not-connected rb-notice ${down ? '' : 'rb-notice-warn'}`} role="status" aria-label="규칙집 연결 안내">
      <Icon name={down ? 'cloud_off' : 'rule_folder'} size={36} />
      <h3>{title}</h3>
      <p>{down ? '조립 규칙과 작업표준은 PDM 백엔드가 rules/ 폴더에서 읽어 줘요. `onto-pdm serve`로 백엔드를 켜 주세요.' : (status.message ?? '')}</p>
      {status.state === 'invalid' && status.errors && status.errors.length > 0 && (
        <details className="rb-errors">
          <summary>오류 {status.errors.length}건 보기</summary>
          <ul aria-label="규칙집 오류 목록">{status.errors.map((e, i) => <li key={i}><span className="mono">{e.where}</span> {e.message}</li>)}</ul>
        </details>
      )}
      <button type="button" className="btn btn-sm" onClick={onRetry}>다시 시도</button>
    </section>
  );
}
