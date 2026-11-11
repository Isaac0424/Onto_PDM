import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayerInfo, PartInfo, StudioApi } from 'explode-studio';

export interface Selection { id: number; name: string; layer: number }

/**
 * explode-studio(분해도 뷰어)를 3D 무대만(chrome: false) 마운트하고, 모델 · 부품 · 단계 · 선택을 React 상태로 돌려준다.
 * three.js 가 커서 이 화면을 열 때만 불러온다. 처음에 무엇을 열지는 호스트가 정한다(restore): 마지막에 작업하던 CAD, 없으면 가장 최근에 올린 CAD.
 * 열 CAD 가 없으면 빈 무대다 (예시 모델은 없다).
 */
export function useStudio(options: { restore?: (s: StudioApi) => Promise<boolean> } = {}) {
  // 처음에 열 CAD 를 호스트가 정한다. true 면 열었다는 뜻이고, false 면 열 CAD 가 없어 빈 무대로 둔다
  const restoreRef = useRef(options.restore);
  restoreRef.current = options.restore;
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
  /** 뷰어를 새로 만든다 (열려 있던 모델을 비울 때) */
  const [epoch, setEpoch] = useState(0);

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
    setModel(''); setParts([]); setLayers([]); setStep(0); setSelected(null); setBusy(true);
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
        const restore = restoreRef.current;
        (restore ? restore(s).catch(() => false) : Promise.resolve(false)).then(restored => { if (!restored && !cancelled) setBusy(false); });
      })
      .catch(e => { setError(`뷰어를 불러오지 못했습니다: ${e?.message ?? e}`); setBusy(false); });
    return () => {
      cancelled = true;
      offs.forEach(off => off());
      studio.current?.destroy();
      studio.current = undefined;
      setStage(null);
    };
  }, [refresh, epoch]);

  const run = useCallback(async (job: (s: StudioApi) => Promise<unknown> | unknown) => {
    const s = studio.current;
    if (!s) return;
    setBusy(true);
    setError(undefined);
    try { await job(s); } catch (e) { setError(String((e as Error)?.message ?? e)); } finally { setBusy(false); }
  }, []);

  return {
    host, stage, model, parts, layers, step, selected, busy, error,
    remount: () => setEpoch(e => e + 1),
    // CAD 를 올리면 분석이 끝나는 대로 처음부터 재생하고 자동 회전을 켠다 (끄려면 하단의 '멈추기' · '자동 회전')
    loadCad: (file: File) => run(async s => { await s.loadFile(file); s.setSpin(true); s.replay(); }),
    goStep: (n: number) => studio.current?.go(n),
    /** 뷰어가 부품 메시를 읽어 줄 수 있는가 (형상 분석용. 옛 뷰어나 시험의 가짜 뷰어는 읽지 못한다) */
    canReadGeometry: () => typeof studio.current?.getPartGeometry === 'function',
    /** 부품 하나의 삼각형 메시 (읽기 전용 복사본). 메시가 없으면 null */
    readGeometry: (name: string) => studio.current?.getPartGeometry(name) ?? null,
    selectPart: (name: string) => studio.current?.selectPart(name, true),
  };
}
