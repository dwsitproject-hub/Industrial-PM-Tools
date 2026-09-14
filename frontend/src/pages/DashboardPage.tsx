import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { AV_PALETTE, STATUS_LABELS, TYPE_LABELS } from '../labels';
import { Avatar, EmptyState, Spinner, StatusBadge, TypeBadge } from '../ui';

export default function DashboardPage() {
  const nav = useNavigate();
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: () => api.get('/api/v1/tickets/stats') });
  const { data: recent } = useQuery({
    queryKey: ['tickets', { recent: true }],
    queryFn: () => api.get('/api/v1/tickets?pageSize=6&sort=-createdAt'),
  });

  if (!stats) return <Spinner />;
  const rate = Math.round((stats.completionRate || 0) * 100);

  return (
    <div className="page">
      <div className="page-title">Dashboard</div>
      <div className="page-sub">Live workload — updates in realtime.</div>

      <div className="stat-grid">
        <div className="stat"><div className="stat-label">Total tickets</div><div className="stat-val">{stats.total}</div><div className="stat-sub">All statuses</div></div>
        <div className="stat"><div className="stat-label">Completed</div><div className="stat-val">{stats.done}</div><div className="stat-sub">{rate}% rate</div></div>
        <div className="stat"><div className="stat-label c-red">Overdue</div><div className="stat-val" style={{ color: 'var(--red)' }}>{stats.overdue}</div><div className="stat-sub">Past due date</div></div>
        <div className="stat"><div className="stat-label" style={{ color: '#854F0B' }}>Unassigned</div><div className="stat-val" style={{ color: '#854F0B' }}>{stats.unassigned}</div><div className="stat-sub">Assign now</div></div>
      </div>

      <div className="fs12 fw5 c-muted mb8">Tickets by status</div>
      <div className="status-grid">
        {Object.keys(STATUS_LABELS).map((s) => (
          <div key={s} className={`mini-stat b-${s}`}>
            <div className="mini-stat-label">{STATUS_LABELS[s]}</div>
            <div className="mini-stat-val">{stats.byStatus?.[s] || 0}</div>
          </div>
        ))}
      </div>

      <div className="fs12 fw5 c-muted mb8">Tickets by type</div>
      <div className="type-grid">
        {Object.keys(TYPE_LABELS).map((t) => (
          <div key={t} className={`mini-stat b-${t}`}>
            <div className="mini-stat-label">{TYPE_LABELS[t]}</div>
            <div className="mini-stat-val">{stats.byType?.[t] || 0}</div>
          </div>
        ))}
      </div>

      <div className="fs12 fw5 c-muted mb8">Workload per estimator</div>
      <div className="team-grid">
        {stats.workload.map((w: any) => {
          const total = w.active + w.done;
          const pct = total ? Math.round((w.active / total) * 100) : 0;
          return (
            <div key={w.userId} className="member-card">
              <div className="flex gap8 mb12">
                <Avatar name={w.fullName} color={w.avatarColor} size={38} />
                <div>
                  <div className="fs13 fw5">{w.fullName}{!w.isActive && <span className="c-hint"> (inactive)</span>}</div>
                  <div className="fs12 c-hint">Estimator</div>
                </div>
              </div>
              <div className="flex fs12 c-muted" style={{ justifyContent: 'space-between' }}>
                <span>Active load</span><span>{w.active} ticket{w.active !== 1 ? 's' : ''}</span>
              </div>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${Math.min(pct, 100)}%`, background: AV_PALETTE[w.avatarColor ?? 0] }} />
              </div>
              <div className="flex mt12" style={{ gap: 24 }}>
                <div><div className="fs11 c-hint">Done</div><div className="fs15 fw5">{w.done}</div></div>
                <div><div className="fs11 c-hint">Active</div><div className="fs15 fw5">{w.active}</div></div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="fs12 fw5 c-muted mb8">Recent tickets</div>
      <div className="card">
        {recent?.items?.length ? (
          <table className="tbl">
            <tbody>
              {recent.items.map((t: any) => (
                <tr key={t.id} className="rowlink" onClick={() => nav(`/tickets/${t.id}`)}>
                  <td className="c-hint mono fs11">{t.ticketNo}</td>
                  <td className="fw5">{t.name}</td>
                  <td><TypeBadge t={t.type} /></td>
                  <td><StatusBadge s={t.status} /></td>
                  <td>
                    {t.assignee
                      ? <span className="flex gap8"><Avatar name={t.assignee.fullName} color={t.assignee.avatarColor} size={20} />{t.assignee.fullName}</span>
                      : <span className="c-red fs12">Unassigned</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <EmptyState text="No tickets yet" />}
      </div>
    </div>
  );
}
