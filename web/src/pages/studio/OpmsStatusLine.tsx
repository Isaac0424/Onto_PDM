import { useCallback, useEffect, useState } from 'react';
import type { OpmsState, OpmsStatus, PdmApi } from '../../api/types';
import { Icon } from '../../components/AppShell';

/** OPMS 를 읽는 길이 없으면(api.opms 가 없음) undefined, 확인 중이면 'loading' */
export type OpmsStatusValue = OpmsStatus | 'loading' | undefined;

/**
 * OPMS 읽기 연결 상태. 화면을 열 때 한 번 확인하고, 사람이 "다시 시도"를 누르면 다시 확인한다.
 * epoch 는 OPMS 를 읽을 수 있게 된 횟수: 연결이 돌아오면 이 값이 바뀌어 보유 품번 매칭을 다시 한다.
 */
export function useOpmsStatus(api: PdmApi) {
  const [status, setStatus] = useState<OpmsStatusValue>(api.opms ? 'loading' : undefined);
  const [epoch, setEpoch] = useState(0);
  const check = useCallback(async () => {
    if (!api.opms) { setStatus(undefined); return; }
    setStatus('loading');
    const s = await api.opms.status();
    setStatus(s);
    if (s.state === 'ok') setEpoch(e => e + 1);
  }, [api]);
  useEffect(() => { void check(); }, [check]);
  return { status, retry: check, epoch };
}

const OFF_TEXT: Record<Exclude<OpmsState, 'ok'>, string> = {
  backend_down: 'PDM 백엔드가 꺼져 있어요',
  opms_down: 'OPMS에 연결하지 못했어요',
  not_configured: '백엔드에 OPMS 읽기 설정이 없어요',
  auth_failed: 'OPMS가 계정을 받아주지 않았어요',
  no_ontology: 'OPMS에 적용된 온톨로지가 아직 없어요',
};

/** OPMS 연결 상태 한 줄. 연결 안 됨은 오류가 아니라 상태라서 빨강을 쓰지 않고, 다시 시도할 수 있다 */
export function OpmsStatusLine({ status, onRetry }: { status: OpmsStatusValue; onRetry(): void }) {
  if (!status) return null;
  if (status === 'loading') return <p className="opms-line opms-line-wait" role="status"><Icon name="sync" size={16} />OPMS 연결을 확인하는 중…</p>;
  if (status.state === 'ok') {
    return (
      <p className="opms-line opms-line-ok" role="status" title="PDM은 OPMS를 읽기만 해요. 온톨로지는 OPMS가 관리해요.">
        <Icon name="database" size={16} />OPMS 연결됨
        {status.ontologyVersion && <span className="opms-line-meta"> · 온톨로지 {status.ontologyVersion}</span>}
        {status.parts !== undefined && <span className="opms-line-meta"> · 부품 {status.parts}개</span>}
      </p>
    );
  }
  return (
    <div className="opms-line opms-line-off" role="status" title={status.message}>
      <Icon name="cloud_off" size={16} />
      <span className="opms-line-text">{OFF_TEXT[status.state]}</span>
      <button type="button" className="btn btn-sm" onClick={onRetry}>다시 시도</button>
    </div>
  );
}
