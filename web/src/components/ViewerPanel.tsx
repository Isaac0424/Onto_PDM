import { useEffect, useRef, useState } from 'react';
import type { StudioApi } from 'explode-studio';

/**
 * explode-studio(분해도 뷰어)를 붙인다. three.js 가 커서 이 탭을 열 때만 불러온다.
 * fileUrl 이 있으면 그 CAD 파일을, 없으면 예시 모델을 연다 (목 데이터에는 실제 CAD 파일이 없다).
 */
export function ViewerPanel({ fileUrl, title }: { fileUrl?: string; title: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let studio: StudioApi | undefined;
    let cancelled = false;
    import('explode-studio')
      .then(({ mountExplodeStudio }) => {
        if (cancelled || !host.current) return;
        studio = mountExplodeStudio(host.current, { assetsBase: '/occt/', initial: null, title });
        if (fileUrl) studio.loadUrl(fileUrl).catch(e => setError(String(e?.message ?? e)));
        else studio.loadExample('box');
      })
      .catch(e => setError(`뷰어를 불러오지 못했습니다: ${e?.message ?? e}`));
    return () => {
      cancelled = true;
      studio?.destroy();
    };
  }, [fileUrl, title]);

  return (
    <>
      {error && <div className="banner banner-danger" role="alert">{error}</div>}
      <div ref={host} className="viewer-host" />
    </>
  );
}
