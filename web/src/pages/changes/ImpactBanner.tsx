// 영향 분석 머리의 안내 띠: 임시 판정 · 낡음 · 일부만 분석. 오류가 아니라 상태이므로 role=status 이고 빨강을 쓰지 않는다(호박색 · 파랑).
import type { ImpactRunView } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { formatDateTime } from '../../labels';

export function ImpactBanner({ run }: { run: ImpactRunView }) {
  return (
    <div className="chg-banners">
      {run.stale && (
        <div className="banner banner-warning" role="status" aria-label="낡은 분석">
          <Icon name="update" size={18} />
          <div>
            <b>외부 데이터가 바뀌었어요 — 다시 분석하세요.</b> 승인 버튼은 다시 분석하기 전까지 잠겨 있어요.
            {run.stale_reasons.length > 0 && <ul className="chg-reasons">{run.stale_reasons.map(r => <li key={r}>{r}</li>)}</ul>}
          </div>
        </div>
      )}
      {run.partial && (
        <div className="banner banner-warning" role="status" aria-label="일부만 분석">
          <Icon name="cloud_off" size={18} />
          <div>
            <b>OPMS 를 읽지 못해 체결 적합성을 판정하지 못했어요.</b> &quot;문제 없음&quot;이 아니에요. OPMS 에 연결되면 다시 분석하세요. 이 분석으로는 승인할 수 없어요.
            {run.warnings.length > 0 && <ul className="chg-reasons">{run.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
          </div>
        </div>
      )}
      {run.temporary && (
        <div className="banner banner-info" role="status" aria-label="임시 판정">
          <Icon name="science" size={18} />
          <div>
            <b>임시 판정 · PDM 참고 판정 · 기준 미지정.</b> OPMS 가 판정 API 를 열기 전에 PDM 이 OPMS 규칙(온톨로지 {run.ontology_version})으로 계산했어요.
            그립 길이 공식은 시연용 가정이에요. OPMS 판정이 나오면 그것으로 바뀌어요.
          </div>
        </div>
      )}
      <p className="chg-asof faint">분석 {formatDateTime(run.computed_at)} · {run.computed_by} · 온톨로지 {run.ontology_version}</p>
    </div>
  );
}
