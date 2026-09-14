import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Avatar, DueDate, EmptyState, PriorityBadge, Spinner, StatusBadge, TypeBadge } from '../ui';

/** Personal queue for estimators; site-scoped queue for site admins (same layout). */
export default function MyTicketsPage() {
  const { profile } = useAuth();
  const nav = useNavigate();
  const isSite = profile!.user.role === 'SITE_ADMIN';
  const query = isSite ? '?pageSize=100&sort=-createdAt' : '?assigneeId=me&pageSize=100&sort=deadline';
  const { data, isLoading } = useQuery({
    queryKey: ['tickets', 'mine', query],
    queryFn: () => api.get(`/api/v1/tickets${query}`),
  });

  if (isLoading || !data) return <div className="page"><Spinner /></div>;
  const items = data.items || [];
  const active = items.filter((t: any) => t.status !== 'DONE');
  const overdue = items.filter((t: any) => t.isOverdue);
  const urgent = active.filter((t: any) => t.priority === 'URGENT');
  const others = items.filter((t: any) => !(t.priority === 'URGENT' && t.status !== 'DONE'));

  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <div className="page-title">{isSite ? `${profile!.user.siteName} — site tickets` : `${profile!.user.fullName}'s tickets`}</div>
      <div className="page-sub">
        {isSite ? 'Requests submitted from your site. Click one to follow progress or move the required-by date.'
          : 'Click a ticket to update status or add a progress note.'}
      </div>
      <div className="stat-grid cols3">
        <div className="stat"><div className="stat-label">{isSite ? 'Total submitted' : 'Assigned to me'}</div><div className="stat-val">{data.total}</div></div>
        <div className="stat"><div className="stat-label">Active</div><div className="stat-val">{active.length}</div></div>
        <div className="stat"><div className="stat-label c-red">Overdue</div><div className="stat-val" style={{ color: 'var(--red)' }}>{overdue.length}</div></div>
      </div>

      {overdue.length > 0 && (
        <div className="overdue-banner">
          <div className="overdue-banner-text">⚠ {overdue.length} overdue ticket{overdue.length > 1 ? 's' : ''}</div>
          <div className="fs12 mt8" style={{ color: 'var(--red-text)', opacity: .85 }}>
            {overdue.map((t: any) => `${t.ticketNo} · ${t.name}`).join('  |  ')}
          </div>
        </div>
      )}

      {urgent.length > 0 && (
        <>
          <div className="fs12 fw5 mb8" style={{ color: 'var(--red)' }}>Urgent — action needed</div>
          {urgent.map((t: any) => <Card key={t.id} t={t} onClick={() => nav(`/tickets/${t.id}`)} showAssignee={isSite} />)}
          <div className="fs12 fw5 c-muted mt16 mb8">Other tickets</div>
        </>
      )}
      {others.map((t: any) => <Card key={t.id} t={t} onClick={() => nav(`/tickets/${t.id}`)} showAssignee={isSite} />)}
      {items.length === 0 && <EmptyState text={isSite ? 'No tickets submitted yet' : 'No tickets assigned to you yet'} />}
    </div>
  );
}

function Card({ t, onClick, showAssignee }: { t: any; onClick: () => void; showAssignee: boolean }) {
  return (
    <div className={`ticket-card${t.priority === 'URGENT' && t.status !== 'DONE' ? ' urg' : ''}${t.isOverdue ? ' overdue' : ''}`} onClick={onClick}>
      <div className="flex gap8" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <div>
          <div className="fs11 c-hint mono" style={{ marginBottom: 2 }}>{t.ticketNo}</div>
          <div className="fs13 fw5" style={{ lineHeight: 1.4 }}>{t.name}</div>
        </div>
        <StatusBadge s={t.status} />
      </div>
      <div className="flex gap8 mb8"><TypeBadge t={t.type} /><PriorityBadge p={t.priority} /></div>
      {t.lastNote && (
        <div className="fs11 c-muted mb8" style={{ fontStyle: 'italic' }}>
          “{t.lastNote.content.slice(0, 80)}{t.lastNote.content.length > 80 ? '…' : ''}” — {t.lastNote.authorLabel}
        </div>
      )}
      <div className="flex fs12 c-muted" style={{ justifyContent: 'space-between' }}>
        <DueDate deadline={t.deadline} isOverdue={t.isOverdue} />
        {showAssignee ? (
          t.assignee
            ? <span className="flex gap4"><Avatar name={t.assignee.fullName} color={t.assignee.avatarColor} size={18} />{t.assignee.fullName}</span>
            : <span style={{ color: '#854F0B' }}>Waiting for assignment</span>
        ) : <span>{t.noteCount || 0} note{t.noteCount !== 1 ? 's' : ''}</span>}
      </div>
    </div>
  );
}
