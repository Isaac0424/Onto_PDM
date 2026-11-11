import { useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ChangeDetailPage } from './pages/changes/ChangeDetailPage';
import { ChangesPage } from './pages/changes/ChangesPage';
import { ProductGraphPage } from './pages/graph/ProductGraphPage';
import { MesPage } from './pages/mes/MesPage';
import { ProductListPage } from './pages/ProductListPage';
import { RulesPage } from './pages/rules/RulesPage';
import { StudioPage } from './pages/studio/StudioPage';

/**
 * CAD 스튜디오는 한 번 열면 창을 닫을 때까지 살려 둔다. 다른 화면(조립 규칙 · 작업 표준 …)에 갔다 와도
 * 뷰어와 열린 CAD 를 새로 만들지 않는다(라우트가 바뀔 때마다 파일을 다시 불러오던 것을 없앴다).
 * 처음 "/" 를 열 때 만들고(three.js 는 그때 불러온다), 다른 화면에서는 숨기기만 한다.
 */
export function App() {
  const { pathname } = useLocation();
  const onStudio = pathname === '/';
  const [studioOpened, setStudioOpened] = useState(onStudio);
  if (onStudio && !studioOpened) setStudioOpened(true);

  // 숨겨 둔 사이 크기를 못 재던 3D 무대가 다시 보일 때 크기를 맞춘다
  useEffect(() => {
    if (onStudio && studioOpened) window.dispatchEvent(new Event('resize'));
  }, [onStudio, studioOpened]);

  return (
    <AppShell>
      {studioOpened && <div hidden={!onStudio} data-testid="studio-keepalive"><StudioPage /></div>}
      <Routes>
        <Route path="/" element={null} />
        <Route path="/products" element={<ProductListPage />} />
        <Route path="/products/:code" element={<ProductGraphPage />} />
        <Route path="/mes" element={<MesPage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/rules/:ruleId" element={<RulesPage />} />
        <Route path="/changes" element={<ChangesPage />} />
        <Route path="/changes/:id" element={<ChangeDetailPage />} />
        <Route path="*" element={<div className="empty">없는 화면입니다. <Link to="/">CAD 스튜디오로</Link></div>} />
      </Routes>
    </AppShell>
  );
}
