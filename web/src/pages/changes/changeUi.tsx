// 설계 변경 화면의 공용 조각: 심각도 · 판정 배지(색 + 아이콘 + 글자), 서버 오류를 사람이 읽을 말로, 쓰기 동작 훅.
import { useCallback, useState } from 'react';
import { ApiError, type Severity, type Verdict } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { Badge } from '../../components/ui';
import {
  CHANGE_ERROR, REVIEW_FUNCTION, SEVERITY, SEVERITY_HELP, SEVERITY_ICON, SEVERITY_TONE, VERDICT, VERDICT_ICON, VERDICT_TONE,
} from '../../labels';
import type { ReviewFunction } from '../../api/types';
import { useSession } from '../../session';

/** 영향 심각도. 아이콘 모양과 글자로도 구분한다(색에만 기대지 않는다). 빨강(danger)은 blocked 에만 쓴다 */
export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <Badge tone={SEVERITY_TONE[severity]} title={SEVERITY_HELP[severity]}>
      <Icon name={SEVERITY_ICON[severity]} size={13} />{SEVERITY[severity]}
    </Badge>
  );
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <Badge tone={VERDICT_TONE[verdict]}><Icon name={VERDICT_ICON[verdict]} size={13} />{VERDICT[verdict]}</Badge>;
}

/** 서버가 준 메시지가 먼저다. 없으면 코드로 찾은 문구, 상세(처분 필요한 영향 수 · 필요한 검토)가 있으면 덧붙인다 */
export function describeError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  const base = e.message || (e.code ? CHANGE_ERROR[e.code] : undefined) || '요청을 처리하지 못했습니다';
  const d = e.details ?? {};
  const extra: string[] = [];
  if (Array.isArray(d['finding_ids'])) extra.push(`처분이 필요한 영향 ${d['finding_ids'].length}건.`);
  if (Array.isArray(d['functions'])) extra.push(`필요한 검토: ${(d['functions'] as ReviewFunction[]).map(f => REVIEW_FUNCTION[f] ?? f).join(' · ')}.`);
  return [base, ...extra].join(' ');
}

/** 쓰기 동작(생성 · 제출 · 승인 …): 진행 중 표시, 실패 이유, 성공하면 화면이 다시 읽도록(bump) 한다 */
export function useAction() {
  const { bump } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      const out = await fn();
      bump();
      return out;
    } catch (e) {
      setError(describeError(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [bump]);
  return { run, busy, error, clearError: () => setError(undefined) };
}
