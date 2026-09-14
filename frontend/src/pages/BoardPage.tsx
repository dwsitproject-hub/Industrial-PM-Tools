import { useState, DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, qs } from '../api';
import { useAuth, usePerm } from '../auth';
import { PRIORITIES, PRIORITY_LABELS, STATUSES, STATUS_LABELS, TYPES, TYPE_LABELS } from '../labels';
import { Avatar, DueDate, PriorityBadge, Spinner, TypeBadge, useToast } from '../ui';

export default function BoardPage() {
  const { profile } = useAuth();
  const nav = useNavigate();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [member, setMember] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [priority, setPriority] = useState('');
  const [dragOver, setDragOver] = useState<string | null>(null);

  const can = usePerm();
  const role = profile!.user.role;
  const canEdit = can('tickets', 'edit');
  const canDragAny = canEdit && (role === 'MANAGER' || role === 'ADMIN');

  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => api.get('/api/v1/users') });
  const query = qs({ pageSize: 100, assigneeId: member, status, type, priority, sort: '-createdAt' });
  const { data, isLoading } = useQuery({
    queryKey: ['tickets', 'board', query],
    queryFn: () => api.get(`/api/v1/tickets${query}`),
  });

  const move = useMutation({
    mutationFn: ({ id, version, newStatus }: any) =>
      api.patch(`/api/v1/tickets/${id}`, { version, status: newStatus }),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['tickets'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      if (res.kpiAward) {
        const a = res.kpiAward;
        toast(a.type === 'AUTO'
          ? `KPI: ${a.points > 0 ? '+' : ''}${a.points} pts (${a.reason === 'ON_TARGET' ? 'on target' : 'missed deadline'})`
          : `KPI reversal: ${a.points} pts`);
      }
    },
    onError: (e: any) => {
      qc.invalidateQueries({ queryKey: ['tickets'] });
      if (e instanceof ApiError && e.status === 409) toast('Updated by someone else — board refreshed.', true);
      else if (e instanceof ApiError && e.status === 403) toast('You cannot move this ticket.', true);
      else toast(e.message || 'Move failed', true);
    },
  });

  const columns = status ? [status] : STATUSES;
  const items = data?.items || [];

  function canDrag(t: any) {
    return canDragAny || (canEdit && role === 'ESTIMATOR' && t.assigneeId === profile!.user.id);
  }
  function onDrop(e: DragEvent, col: string) {
    e.preventDefault();
    setDragOver(null);
    const payload = e.dataTransfer.getData('text/plain');
    if (!payload) return;
    const { id, version, status: from } = JSON.parse(payload);
    if (from === col) return;
    move.mutate({ id, version, newStatus: col });
  }

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="page-title">{role === 'ESTIMATOR' ? 'Team board' : 'Estimation board'}</div>
      <div className="page-sub">
        {canDragAny ? 'Drag cards between columns or click to open.' :
          role === 'ESTIMATOR' ? 'Drag your own cards; click any card to view.' : 'Click a card to view.'}
      </div>
      <div className="filter-bar">
        <span className="filter-label">Filter:</span>
        <select value={member} onChange={(e) => setMember(e.target.value)}>
          <option value="">All members</option>
          <option value="unassigned">Unassigned</option>
          {(users || []).filter((u: any) => u.role === 'ESTIMATOR' || u.role === 'ADMIN').map((u: any) => (
            <option key={u.id} value={u.id}>{u.fullName}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="">All priority</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
        </select>
        <span className="filter-count">{data ? `${items.length} of ${data.total} tickets` : ''}</span>
        <button className="btn btn-outline btn-xs" onClick={() => { setMember(''); setStatus(''); setType(''); setPriority(''); }}>Reset</button>
      </div>
      {isLoading ? <Spinner /> : (
        <div className="kanban" style={status ? { gridTemplateColumns: '1fr' } : undefined}>
          {columns.map((col) => {
            const colItems = items.filter((t: any) => t.status === col);
            return (
              <div
                key={col}
                className={`k-col${dragOver === col ? ' drag-over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(col); }}
                onDragLeave={() => setDragOver(null)}
                onDrop={(e) => onDrop(e, col)}
              >
                <div className="k-col-hd">
                  <span className="k-col-title">{STATUS_LABELS[col]}</span>
                  <span className="k-count">{colItems.length}</span>
                </div>
                {colItems.length === 0 && <div className="empty-state" style={{ padding: '1rem' }}>Empty</div>}
                {colItems.map((t: any) => (
                  <div
                    key={t.id}
                    className={`k-card${t.noteCount ? ' has-note' : ''}${t.isOverdue ? ' overdue' : ''}`}
                    draggable={canDrag(t)}
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', JSON.stringify({ id: t.id, version: t.version, status: t.status }))}
                    onClick={() => nav(`/tickets/${t.id}`)}
                  >
                    <div className="k-card-id">{t.ticketNo}</div>
                    <div className="k-card-name">{t.name}</div>
                    <div className="k-card-meta"><TypeBadge t={t.type} /><PriorityBadge p={t.priority} /></div>
                    {t.lastNote && (
                      <div className="fs11 c-muted mb8" style={{ fontStyle: 'italic', lineHeight: 1.4 }}>
                        “{t.lastNote.content.slice(0, 55)}{t.lastNote.content.length > 55 ? '…' : ''}”
                      </div>
                    )}
                    <div className="k-card-ft">
                      <DueDate deadline={t.deadline} isOverdue={t.isOverdue} />
                      {t.assignee
                        ? <span className="flex gap4">{t.assignee.fullName}<Avatar name={t.assignee.fullName} color={t.assignee.avatarColor} size={20} /></span>
                        : <span className="c-red">unassigned</span>}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
