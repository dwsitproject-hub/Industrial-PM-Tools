import { FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import {
  PRIORITIES, PRIORITY_LABELS, SOURCES, SOURCE_LABELS, STATUSES, STATUS_LABELS,
  TENDER_STATUS_LABELS, TYPES, TYPE_LABELS, fmtDate, fmtDateTime,
} from '../labels';
import { Avatar, DueDate, Modal, PriorityBadge, Spinner, StatusBadge, TypeBadge, useToast } from '../ui';

export default function TicketDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { profile } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<any>({});
  const [note, setNote] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: t, isLoading, refetch } = useQuery({
    queryKey: ['ticket', id],
    queryFn: () => api.get(`/api/v1/tickets/${id}`),
  });
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => api.get('/api/v1/users') });

  useEffect(() => { setForm({}); }, [t?.version]);

  const fields: string[] = t?.permissions?.editableFields || [];
  const can = (f: string) => fields.includes(f);
  const val = (f: string, fallback: any) => (form[f] !== undefined ? form[f] : fallback);
  const dirty = Object.keys(form).length > 0;
  const isTender = ['PROJECT_TENDER', 'OPS_TENDER'].includes(val('type', t?.type));

  const save = useMutation({
    mutationFn: () => api.patch(`/api/v1/tickets/${id}`, { version: t.version, ...form }),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['tickets'] });
      qc.invalidateQueries({ queryKey: ['ticket', id] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      setForm({});
      if (res.kpiAward) {
        toast(res.kpiAward.type === 'AUTO'
          ? `Saved. KPI ${res.kpiAward.points > 0 ? '+' : ''}${res.kpiAward.points} pts to assignee.`
          : `Saved. KPI reversal ${res.kpiAward.points} pts.`);
      } else toast('Saved');
    },
    onError: (e: any) => {
      if (e instanceof ApiError && e.status === 409) { toast('Modified by someone else — reloaded latest.', true); refetch(); }
      else toast(e.message || 'Save failed', true);
    },
  });

  const addNote = useMutation({
    mutationFn: () => api.post(`/api/v1/tickets/${id}/notes`, { content: note.trim() }),
    onSuccess: () => {
      setNote('');
      qc.invalidateQueries({ queryKey: ['ticket', id] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
      toast('Note added');
    },
    onError: (e: any) => toast(e.message || 'Note failed', true),
  });

  const doDelete = useMutation({
    mutationFn: () => api.del(`/api/v1/tickets/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tickets'] });
      toast('Ticket deleted');
      nav(-1);
    },
    onError: (e: any) => { setConfirmDelete(false); toast(e.body?.message || e.message, true); },
  });

  if (isLoading || !t) return <div className="page"><Spinner /></div>;

  return (
    <div className="page">
      <div className="flex gap8 mb16" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          <div className="fs11 c-hint mono">
            {t.ticketNo}{t.legacyTicketNo ? ` (was ${t.legacyTicketNo})` : ''} · created {fmtDateTime(t.createdAt)}
            {t.submittedBy ? ` by ${t.submittedBy.fullName}` : ''}
          </div>
          <div className="page-title" style={{ fontSize: 18 }}>{t.name}</div>
          <div className="flex gap8 mt8">
            <StatusBadge s={t.status} /><TypeBadge t={t.type} /><PriorityBadge p={t.priority} />
            {t.site && <span className="badge b-SITE_INSTRUCTION">{t.site.name}</span>}
          </div>
        </div>
        <div className="flex gap8">
          <button className="btn btn-outline btn-sm" onClick={() => nav(-1)}>← Back</button>
          {t.permissions.canDelete && (
            <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(true)}>Delete</button>
          )}
        </div>
      </div>

      <div className="detail-grid">
        <div>
          <div className="panel mb16">
            <div className="fs12 fw5 c-muted mb12">Details</div>
            <div className="meta-row"><span className="meta-key">Requested by</span><span>{t.requestor || '—'}</span></div>
            <div className="meta-row"><span className="meta-key">Source</span><span>{t.source ? SOURCE_LABELS[t.source] : '—'}</span></div>
            <div className="meta-row"><span className="meta-key">Required by</span><DueDate deadline={t.deadline} isOverdue={t.isOverdue} /></div>
            <div className="meta-row">
              <span className="meta-key">Assignee</span>
              <span>{t.assignee ? <span className="flex gap8"><Avatar name={t.assignee.fullName} color={t.assignee.avatarColor} size={20} />{t.assignee.fullName}</span> : <span style={{ color: '#854F0B' }}>Waiting for assignment</span>}</span>
            </div>
            {t.completedAt && <div className="meta-row"><span className="meta-key">Completed</span><span>{fmtDateTime(t.completedAt)}</span></div>}
            {t.tenderStatus && <div className="meta-row"><span className="meta-key">Tender status</span><span>{TENDER_STATUS_LABELS[t.tenderStatus]}</span></div>}
            {t.tenderValue != null && <div className="meta-row"><span className="meta-key">Tender value</span><span>{Number(t.tenderValue).toLocaleString()}</span></div>}
            {typeof t.kpiNet === 'number' && t.kpiNet !== 0 && (
              <div className="meta-row"><span className="meta-key">KPI awarded</span>
                <span className={`kpi-pt-badge ${t.kpiNet > 0 ? 'kpi-pt-pos' : 'kpi-pt-neg'}`}>{t.kpiNet > 0 ? '+' : ''}{t.kpiNet}</span></div>
            )}
            <div className="meta-row" style={{ alignItems: 'flex-start' }}>
              <span className="meta-key">Description</span>
              <span style={{ textAlign: 'right', maxWidth: 380, lineHeight: 1.5, color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>{t.description || '—'}</span>
            </div>
          </div>

          <div className="panel">
            <div className="fs12 fw5 c-muted mb12">Progress notes ({t.notes?.length || 0})</div>
            {t.permissions.canAddNote && (
              <form className="mb12" onSubmit={(e: FormEvent) => { e.preventDefault(); if (note.trim()) addNote.mutate(); }}>
                <textarea placeholder="Describe progress, blockers, or next steps…" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
                <button className="btn btn-primary btn-sm mt8" disabled={!note.trim() || addNote.isPending}>Add note</button>
              </form>
            )}
            {(t.notes || []).map((n: any) => (
              <div key={n.id} className="note-item">
                <div className="note-item-text">{n.content}</div>
                <div className="note-item-meta">{n.authorLabel} · {fmtDateTime(n.createdAt)} · Status: {STATUS_LABELS[n.statusAtTime]}</div>
              </div>
            ))}
            {!t.notes?.length && <div className="empty-state" style={{ padding: '1rem' }}>No notes yet</div>}
          </div>
        </div>

        <div className="panel">
          <div className="fs12 fw5 c-muted mb12">
            {fields.length ? 'Update ticket' : `Read-only — only ${t.assignee?.fullName || 'the estimation team'} can update this ticket`}
          </div>
          {can('name') && (
            <div className="field"><label>Name</label>
              <input value={val('name', t.name)} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={200} /></div>
          )}
          {can('status') && (
            <div className="field"><label>Status</label>
              <select value={val('status', t.status)} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
              </select></div>
          )}
          {can('assigneeId') && (
            <div className="field"><label>Assign to</label>
              <select value={val('assigneeId', t.assigneeId ?? '')} onChange={(e) => setForm({ ...form, assigneeId: e.target.value || null })}>
                <option value="">Unassigned</option>
                {(users || []).filter((u: any) => (u.role === 'ESTIMATOR' || u.role === 'ADMIN') && u.isActive).map((u: any) => (
                  <option key={u.id} value={u.id}>{u.fullName}</option>
                ))}
              </select></div>
          )}
          {can('priority') && (
            <div className="field"><label>Priority</label>
              <select value={val('priority', t.priority)} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
              </select></div>
          )}
          {can('type') && (
            <div className="field"><label>Work type</label>
              <select value={val('type', t.type)} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {TYPES.map((ty) => <option key={ty} value={ty}>{TYPE_LABELS[ty]}</option>)}
              </select></div>
          )}
          {can('deadline') && (
            <div className="field"><label>Required by date</label>
              <input type="date" value={val('deadline', t.deadline)} onChange={(e) => setForm({ ...form, deadline: e.target.value })} /></div>
          )}
          {can('requestor') && (
            <div className="field"><label>Requested by</label>
              <input value={val('requestor', t.requestor || '')} onChange={(e) => setForm({ ...form, requestor: e.target.value })} maxLength={120} /></div>
          )}
          {can('source') && (
            <div className="field"><label>Source</label>
              <select value={val('source', t.source ?? '')} onChange={(e) => setForm({ ...form, source: e.target.value || null })}>
                <option value="">—</option>
                {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
              </select></div>
          )}
          {can('description') && (
            <div className="field"><label>Description</label>
              <textarea value={val('description', t.description || '')} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={5000} /></div>
          )}
          {can('tenderStatus') && isTender && (
            <div className="field-row">
              <div className="field"><label>Tender status</label>
                <select value={val('tenderStatus', t.tenderStatus ?? '')} onChange={(e) => setForm({ ...form, tenderStatus: e.target.value || null })}>
                  <option value="">—</option>
                  {Object.entries(TENDER_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></div>
              <div className="field"><label>Tender value</label>
                <input type="number" min={0} step="0.01" value={val('tenderValue', t.tenderValue ?? '')}
                  onChange={(e) => setForm({ ...form, tenderValue: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            </div>
          )}
          {fields.length > 0 && (
            <div className="flex gap8 mt12">
              <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? 'Saving…' : 'Save changes'}
              </button>
              {dirty && <button className="btn btn-outline" onClick={() => setForm({})}>Discard</button>}
            </div>
          )}
        </div>
      </div>

      {confirmDelete && (
        <Modal title={`Delete ticket ${t.ticketNo}?`} onClose={() => setConfirmDelete(false)}>
          <p className="fs13 c-muted mb16" style={{ lineHeight: 1.6 }}>
            The ticket is removed from all boards and lists. A manager can restore it from the audit trail — nothing is permanently destroyed.
          </p>
          <div className="flex gap8" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-outline" onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => doDelete.mutate()} disabled={doDelete.isPending}>Delete ticket</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
