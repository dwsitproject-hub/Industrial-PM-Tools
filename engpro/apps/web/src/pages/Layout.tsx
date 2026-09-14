import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth, usePerm } from '../auth';
import { anySettings } from '../App';
import { useSyncState } from '../socket';
import { Avatar } from '../ui';

const ROLE_LABEL: Record<string, string> = {
  MANAGER: 'Manager', ADMIN: 'Admin', SITE_ADMIN: 'Site Admin', ESTIMATOR: 'Estimator',
};

export default function Layout() {
  const { profile, perms, logout } = useAuth();
  const can = usePerm();
  const sync = useSyncState();
  const nav = useNavigate();
  if (!profile || !perms) return null;
  const { user, workspace } = profile;
  const isEstimator = user.role === 'ESTIMATOR';

  const items: { to: string; label: string }[] = [];
  if (can('dashboard')) items.push({ to: '/dashboard', label: 'Dashboard' });
  if (can('ticketsMy')) {
    items.push({
      to: user.role === 'SITE_ADMIN' ? '/site/my-tickets' : '/my-tickets',
      label: user.role === 'SITE_ADMIN' ? 'My site tickets' : 'My tickets',
    });
  }
  if (can('board')) items.push({ to: '/board', label: isEstimator ? 'Team board' : 'Board' });
  if (can('ticketsAll')) items.push({ to: '/tickets', label: 'Tickets' });
  if (can('kpi')) items.push({ to: '/kpi', label: 'KPI' });
  if (can('kpiMe')) items.push({ to: '/kpi/me', label: 'My KPI' });
  if (anySettings(perms)) items.push({ to: '/settings', label: 'Settings' });

  return (
    <>
      <div className="topbar">
        <div className="topbar-logo">
          <span className="topbar-logo-dot" />
          <span>{workspace.company}</span>
        </div>
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} end className={({ isActive }) => 'nav-tab' + (isActive ? ' active' : '')}>
            {n.label}
          </NavLink>
        ))}
        <div className="topbar-right">
          {can('tickets', 'create') && (
            <button className="btn btn-accent btn-sm" onClick={() => nav('/tickets/new')}>+ New ticket</button>
          )}
          <span className="fs11 c-hint flex gap4">
            <span className={`sync-dot ${sync}`} />
            {sync === 'online' ? 'Live' : sync === 'syncing' ? 'Syncing…' : 'Offline'}
          </span>
          <span className={`chip chip-${user.role}`}>
            <Avatar name={user.fullName} color={user.avatarColor} size={18} />
            {user.role === 'SITE_ADMIN' ? user.siteName : user.fullName} · {ROLE_LABEL[user.role]}
          </span>
          <button className="btn btn-outline btn-sm" onClick={logout}>Logout</button>
        </div>
      </div>
      <Outlet />
    </>
  );
}
