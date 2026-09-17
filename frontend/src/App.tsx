import { Navigate, Route, Routes } from 'react-router-dom';
import { Perms, useAuth } from './auth';
import { Spinner } from './ui';
import LoginPage from './pages/LoginPage';
import Layout from './pages/Layout';
import DashboardPage from './pages/DashboardPage';
import BoardPage from './pages/BoardPage';
import TicketsPage from './pages/TicketsPage';
import TicketDetailPage from './pages/TicketDetailPage';
import NewTicketPage from './pages/NewTicketPage';
import MyTicketsPage from './pages/MyTicketsPage';
import KpiPage from './pages/KpiPage';
import MyKpiPage from './pages/MyKpiPage';
import SettingsPage from './pages/SettingsPage';
import { ForgotPasswordPage, TokenPasswordPage } from './pages/TokenPages';

const SETTINGS_KEYS = ['stUsers', 'stSites', 'stWorkspace', 'stRoles', 'stAudit'];
export const anySettings = (perms: Perms | null) =>
  SETTINGS_KEYS.some((k) => perms?.pages?.[k]?.view === true);

export function homeFor(perms: Perms | null, role: string): string {
  const has = (r: string) => perms?.pages?.[r]?.view === true;
  if (has('dashboard')) return '/dashboard';
  if (has('ticketsMy')) return role === 'SITE_ADMIN' ? '/site/my-tickets' : '/my-tickets';
  if (has('board')) return '/board';
  if (has('ticketsAll')) return '/tickets';
  if (has('kpi')) return '/kpi';
  if (has('kpiMe')) return '/kpi/me';
  if (anySettings(perms)) return '/settings';
  if (perms?.pages?.tickets?.create) return '/tickets/new';
  return '/no-access';
}

function Guard({ ok, children }: { ok: boolean; children: JSX.Element }) {
  const { perms, profile } = useAuth();
  if (!ok) return <Navigate to={homeFor(perms, profile!.user.role)} replace />;
  return children;
}

function NoAccess() {
  const { logout } = useAuth();
  return (
    <div className="center-wrap">
      <div className="auth-box" style={{ textAlign: 'center' }}>
        <div className="auth-title">No pages enabled for your role</div>
        <div className="auth-sub">Ask a manager to enable access in Settings → Roles.</div>
        <button className="btn btn-outline btn-full" onClick={logout}>Back to login</button>
      </div>
    </div>
  );
}

export default function App() {
  const { profile, perms, loading } = useAuth();
  if (loading) return <Spinner />;
  // Activation and reset links must work while signed out — and must win over the
  // logged-in shell too, so an existing session cannot swallow the link.
  const publicRoutes = (
    <>
      <Route path="/activate" element={<TokenPasswordPage mode="activate" />} />
      <Route path="/reset-password" element={<TokenPasswordPage mode="reset" />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
    </>
  );

  if (!profile || profile.user.mustChangePassword || !perms) {
    return (
      <Routes>
        {publicRoutes}
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  const p = (r: string, a: string = 'view') => perms.pages?.[r]?.[a as 'view'] === true;
  const home = homeFor(perms, profile.user.role);
  return (
    <Routes>
      {publicRoutes}
      <Route path="/login" element={<Navigate to={home} replace />} />
      <Route path="/no-access" element={<NoAccess />} />
      <Route element={<Layout />}>
        <Route path="/dashboard" element={<Guard ok={p('dashboard')}><DashboardPage /></Guard>} />
        <Route path="/board" element={<Guard ok={p('board')}><BoardPage /></Guard>} />
        <Route path="/tickets" element={<Guard ok={p('ticketsAll')}><TicketsPage /></Guard>} />
        <Route path="/tickets/new" element={<Guard ok={p('tickets', 'create')}><NewTicketPage /></Guard>} />
        <Route path="/tickets/:id" element={<TicketDetailPage />} />
        <Route path="/my-tickets" element={<Guard ok={p('ticketsMy')}><MyTicketsPage /></Guard>} />
        <Route path="/site/my-tickets" element={<Guard ok={p('ticketsMy')}><MyTicketsPage /></Guard>} />
        <Route path="/kpi" element={<Guard ok={p('kpi')}><KpiPage /></Guard>} />
        <Route path="/kpi/me" element={<Guard ok={p('kpiMe')}><MyKpiPage /></Guard>} />
        <Route path="/settings" element={<Guard ok={anySettings(perms)}><SettingsPage /></Guard>} />
        <Route path="*" element={<Navigate to={home} replace />} />
      </Route>
    </Routes>
  );
}
