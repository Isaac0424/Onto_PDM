import { Suspense, lazy } from 'react';
import './graph.css';
import { type Graph3DProps } from './graphStyle';

export { KIND_COLOR, TONE_COLOR, graphKey, type Graph3DProps } from './graphStyle';

// three.js 는 크다. 그래프 화면을 열 때만 내려받는다 (CAD 스튜디오의 뷰어와 같은 방식).
const Scene = lazy(() => import('./Graph3DScene'));

export function Graph3D(props: Graph3DProps) {
  return (
    <Suspense fallback={<div className="graph3d graph3d-loading" role="img" aria-label={props.label}><p>3D를 불러오는 중…</p></div>}>
      <Scene {...props} />
    </Suspense>
  );
}
