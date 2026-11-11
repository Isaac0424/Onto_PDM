import { Link, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AdminProposalsPage } from './pages/admin/AdminProposalsPage';
import { AdminPublishPage } from './pages/admin/AdminPublishPage';
import { AdminRequestsPage } from './pages/admin/AdminRequestsPage';
import { ItemDetailPage } from './pages/ItemDetailPage';
import { ItemListPage } from './pages/ItemListPage';
import { BomImportPage } from './pages/documents/BomImportPage';
import { ProductGraphPage } from './pages/graph/ProductGraphPage';
import { MesPage } from './pages/mes/MesPage';
import { ProductListPage } from './pages/ProductListPage';
import { RequestEditPage } from './pages/requests/RequestEditPage';
import { RulesPage } from './pages/rules/RulesPage';
import { RequestListPage } from './pages/requests/RequestListPage';
import { StudioPage } from './pages/studio/StudioPage';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<StudioPage />} />
        <Route path="/items" element={<ItemListPage />} />
        <Route path="/items/:itemNo" element={<ItemDetailPage />} />
        <Route path="/products" element={<ProductListPage />} />
        <Route path="/products/:code" element={<ProductGraphPage />} />
        <Route path="/bom-import" element={<BomImportPage />} />
        <Route path="/mes" element={<MesPage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/rules/:ruleId" element={<RulesPage />} />
        <Route path="/requests" element={<RequestListPage />} />
        <Route path="/requests/new" element={<RequestEditPage />} />
        <Route path="/requests/:id" element={<RequestEditPage />} />
        <Route path="/admin/requests" element={<AdminRequestsPage />} />
        <Route path="/admin/proposals" element={<AdminProposalsPage />} />
        <Route path="/admin/publish" element={<AdminPublishPage />} />
        <Route path="*" element={<div className="empty">없는 화면입니다. <Link to="/items">품목으로</Link></div>} />
      </Routes>
    </AppShell>
  );
}
