import { Link, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ProductGraphPage } from './pages/graph/ProductGraphPage';
import { MesPage } from './pages/mes/MesPage';
import { ProductListPage } from './pages/ProductListPage';
import { RulesPage } from './pages/rules/RulesPage';
import { StudioPage } from './pages/studio/StudioPage';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<StudioPage />} />
        <Route path="/products" element={<ProductListPage />} />
        <Route path="/products/:code" element={<ProductGraphPage />} />
        <Route path="/mes" element={<MesPage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/rules/:ruleId" element={<RulesPage />} />
        <Route path="*" element={<div className="empty">없는 화면입니다. <Link to="/">CAD 스튜디오로</Link></div>} />
      </Routes>
    </AppShell>
  );
}
