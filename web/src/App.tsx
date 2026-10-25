import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AdminProposalsPage } from './pages/admin/AdminProposalsPage';
import { AdminPublishPage } from './pages/admin/AdminPublishPage';
import { AdminRequestsPage } from './pages/admin/AdminRequestsPage';
import { ItemDetailPage } from './pages/ItemDetailPage';
import { ItemListPage } from './pages/ItemListPage';
import { ProductListPage } from './pages/ProductListPage';
import { RequestEditPage } from './pages/requests/RequestEditPage';
import { RequestListPage } from './pages/requests/RequestListPage';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/items" replace />} />
        <Route path="/items" element={<ItemListPage />} />
        <Route path="/items/:itemNo" element={<ItemDetailPage />} />
        <Route path="/products" element={<ProductListPage />} />
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
