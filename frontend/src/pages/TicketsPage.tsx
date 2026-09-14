import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../api';
import { PRIORITIES, PRIORITY_LABELS, STATUSES, STATUS_LABELS, TYPES, TYPE_LABELS } from '../labels';
import { Avatar, DueDate, EmptyState, PriorityBadge, Spinner, StatusBadge, TypeBadge } from '../ui';

export default function TicketsPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [member, setMember] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [priority, setPriority] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('-createdAt');

  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => api.get('/api/v1/users') });
  const query = qs({ page, pageSize: 25, search, assigneeId: member, status, type, priority, sort });
  const { data, isLoading } = useQuery({
    queryKey: ['tickets', 'list', query],
    queryFn: () => api.get(`/api/v1/tickets${query}`),
    placeholderData: keepPreviousData,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const toggleSort = (f: string) => { setSort(sort === f ? `-${f}` : f); setPage(1); };
  const arrow = (f: string) => (sort === f ? ' ↑' : sort === `-${f}` ? ' ↓' : '');

  return (
    <div className="page" style={{ maxWidth: 1300 }}>
      <div className="page-title">All tickets</div>
      <div className="page-sub">Search, filter and open any ticket.</div>
      <div className="filter-bar">
        <input
          placeholder="Search name, number, requestor…" value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          style={{ minWidth: 220 }}
        />
        <select value={member} onChange={(e) => { setMember(e.target.value); setPage(1); }}>
          <option value="">All members</option>
          <option value="unassigned">Unassigned</option>
          {(users || []).filter((u: any) => u.role === 'ESTIMATOR' || u.role === 'ADMIN').map((u: any) => (
            <option key={u.id} value={u.id}>{u.fullName}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        <select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
          <option value="">All types</option>
          {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
        </select>
        <select value={priority} onChange={(e) => { setPriority(e.target.value); setPage(1); }}>
          <option value="">All priority</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
        </select>
        <span className="filter-count">{data ? `${data.total} tickets` : ''}</span>
      </div>
      <div className="card">
        {isLoading ? <Spinner /> : !data?.items?.length ? <EmptyState text="No tickets match the filter" /> : (
          <table className="tbl">
            <thead>
              <tr>
                <th>ID</th><th>Name</th><th>Type</th><th>Priority</th><th>Status</th><th>Assignee</th>
                <th className="sortable" onClick={() => toggleSort('deadline')}>Due{arrow('deadline')}</th>
                <th>Notes</th>
                <th className="sortable" onClick={() => toggleSort('createdAt')}>Created{arrow('createdAt')}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((t: any) => (
                <tr key={t.id} className="rowlink" onClick={() => nav(`/tickets/${t.id}`)}>
                  <td className="c-hint mono fs11">{t.ticketNo}</td>
                  <td className="fw5">{t.name}</td>
                  <td><TypeBadge t={t.type} /></td>
                  <td><PriorityBadge p={t.priority} /></td>
                  <td><StatusBadge s={t.status} /></td>
                  <td>
                    {t.assignee
                      ? <span className="flex gap8"><Avatar name={t.assignee.fullName} color={t.assignee.avatarColor} size={20} />{t.assignee.fullName}</span>
                      : <span className="c-red fs12">Unassigned</span>}
                  </td>
                  <td><DueDate deadline={t.deadline} isOverdue={t.isOverdue} /></td>
                  <td><span className="badge b-NORMAL">{t.noteCount || 0}</span></td>
                  <td className="c-hint fs12">{new Date(t.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="pagination">
          <button className="btn btn-outline btn-xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button>
          <span>Page {page} of {totalPages}</span>
          <button className="btn btn-outline btn-xs" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next ›</button>
        </div>
      </div>
    </div>
  );
}
