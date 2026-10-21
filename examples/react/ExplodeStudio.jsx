import { useEffect, useRef } from 'react';
import { mountExplodeStudio } from 'explode-studio';

/**
 * <ExplodeStudio options={{ assetsBase: '/occt/', aiEndpoint: '/api/explode-ai' }} onReady={api => ...} />
 * occt 파일(assets/occt/*)은 public/occt/ 에 복사해 두세요.
 */
export default function ExplodeStudio({ options, onReady, className }) {
  const ref = useRef(null);
  useEffect(() => {
    const api = mountExplodeStudio(ref.current, options);
    onReady && onReady(api);
    return () => api.destroy();
    // options는 처음 한 번만 읽어요. 바꾸려면 key를 바꿔 다시 마운트하세요.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={ref} className={className} />;
}
