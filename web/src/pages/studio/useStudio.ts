import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayerInfo, PartInfo, StudioApi } from 'explode-studio';

export interface Selection { id: number; name: string; layer: number }

export type ExampleName = 'box' | 'watch';

/**
 * explode-studio(분해도 뷰어)를 3D 무대만(chrome: false) 마운트하고, 모델 · 부품 · 단계 · 선택을 React 상태로 돌려준다.
 * three.js 가 커서 이 화면을 열 때만 불러온다. 파일 이름은 CAD 파일 이름이고, 실제 CAD 파일이 없으면 예시 모델을 연다.
 */
export function useStudio() {
  const host = useRef<HTMLDivElement>(null);
  const studio = useRef<StudioApi>();
  const [model, setModel] = useState('');
  const [parts, setParts] = useState<PartInfo[]>([]);
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [stage, setStage] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(() => {
    const s = studio.current;
    if (!s) return;
    setModel(s.getState().model);
    setParts(s.getParts());
    setLayers(s.getLayers());
    setStep(s.getState().step);
    setSelected(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const offs: (() => void)[] = [];
    import('explode-studio')
      .then(({ mountExplodeStudio }) => {
        if (cancelled || !host.current) return;
        const s = mountExplodeStudio(host.current, {
          assetsBase: '/occt/', initial: null, chrome: false, title: 'CAD 스튜디오',
          skin: 'glass',      // 밝은 글래스 스킨: 나머지 화면과 같은 톤
          axes: false,        // 빨강 · 초록 · 파랑 기준 축 표시를 그리지 않는다
          // 왼쪽 드래그 = 회전, 오른쪽 드래그 = 시점 이동, 휠 = 확대. 오른쪽 클릭은 부품을 고르지 않는다
        });
        studio.current = s;
        setStage(s.root.querySelector<HTMLElement>('.stage'));      // 안내 카드 · 자막이 3D 무대 위에 겹칠 자리
        offs.push(
          s.on('model', () => { refresh(); setBusy(false); }),
          s.on('layers', refresh),
          s.on('step', d => setStep(d.step)),
          s.on('select', d => setSelected(d.id < 0 ? null : { id: d.id, name: d.name, layer: d.layer })),
        );
        s.loadExample('box');
      })
      .catch(e => { setError(`뷰어를 불러오지 못했습니다: ${e?.message ?? e}`); setBusy(false); });
    return () => {
      cancelled = true;
      offs.forEach(off => off());
      studio.current?.destroy();
      studio.current = undefined;
      setStage(null);
    };
  }, [refresh]);

  const run = useCallback(async (job: (s: StudioApi) => Promise<unknown> | unknown) => {
    const s = studio.current;
    if (!s) return;
    setBusy(true);
    setError(undefined);
    try { await job(s); } catch (e) { setError(String((e as Error)?.message ?? e)); } finally { setBusy(false); }
  }, []);

  return {
    host, stage, model, parts, layers, step, selected, busy, error,
    loadExample: (which: ExampleName) => run(s => s.loadExample(which)),
    // CAD 를 올리면 분석이 끝나는 대로 처음부터 재생하고 자동 회전을 켠다 (끄려면 하단의 '멈추기' · '자동 회전')
    loadCad: (file: File) => run(async s => { await s.loadFile(file); s.setSpin(true); s.replay(); }),
    loadSpec: (file: File) => run(s => s.loadSpec(file)),
    goStep: (n: number) => studio.current?.go(n),
    selectPart: (name: string) => studio.current?.selectPart(name, true),
  };
}
