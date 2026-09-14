import { FormEvent, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { PRIORITIES, PRIORITY_LABELS, SOURCES, SOURCE_LABELS, TYPES, TYPE_LABELS } from '../labels';
import { useToast } from '../ui';

const empty = { name: '', type: '', priority: '', deadline: '', requestor: '', source: '', description: '', assigneeId: '' };

export default function NewTicketPage() {
  const { profile } = useAuth();
  const nav = useNavigate();
  const { toast } = useToast();
  const [f, setF] = useState({ ...empty });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isSite = profile!.user.role === 'SITE_ADMIN';

  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get('/api/v1/users'),
    enabled: !isSite,
  });

  const set = (k: string, v: string) => setF({ ...f, [k]: v });

  async function submit(e: FormEvent, allowPast = false) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const body: any = {
        name: f.name.trim(), type: f.type, priority: f.priority, deadline: f.deadline,
        requestor: f.requestor || undefined, source: f.source || undefined,
        description: f.description || undefined,
        assigneeId: !isSite && f.assigneeId ? f.assigneeId : undefined,
        allowPast: allowPast || undefined,
      };
      const t = await api.post('/api/v1/tickets', body);
      toast(`Ticket ${t.ticketNo} created`);
      setF({ ...empty });
      nav(`/tickets/${t.id}`);
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 400 && /allowPast/.test(err.message)) {
        if (window.confirm('The deadline is in the past. Register as a backdated request?')) {
          await submit(e, true);
          return;
        }
        setError('Deadline is in the past.');
      } else setError(err.message || 'Could not create the ticket.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="page-title">New estimation request</div>
      <div className="page-sub">
        {isSite ? `Submit a ticket from ${profile!.user.siteName}. The estimation team will assign it.`
          : 'Ticket number is generated automatically on submit.'}
      </div>
      <form className="panel" onSubmit={(e) => submit(e)}>
        <div className="field-row">
          <div className="field"><label>Project / work name *</label>
            <input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Office Building Phase 2" maxLength={200} /></div>
          <div className="field"><label>Requested by</label>
            <input value={f.requestor} onChange={(e) => set('requestor', e.target.value)} placeholder="Name or department" maxLength={120} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>Work type *</label>
            <select value={f.type} onChange={(e) => set('type', e.target.value)}>
              <option value="">-- Select type --</option>
              {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select></div>
          <div className="field"><label>Priority *</label>
            <select value={f.priority} onChange={(e) => set('priority', e.target.value)}>
              <option value="">-- Select --</option>
              {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
            </select></div>
        </div>
        <div className="field-row">
          <div className="field"><label>Required by date *</label>
            <input type="date" value={f.deadline} onChange={(e) => set('deadline', e.target.value)} /></div>
          {!isSite ? (
            <div className="field"><label>Assign to</label>
              <select value={f.assigneeId} onChange={(e) => set('assigneeId', e.target.value)}>
                <option value="">Unassigned</option>
                {(users || []).filter((u: any) => (u.role === 'ESTIMATOR' || u.role === 'ADMIN') && u.isActive).map((u: any) => (
                  <option key={u.id} value={u.id}>{u.fullName}</option>
                ))}
              </select></div>
          ) : (
            <div className="field"><label>Request source</label>
              <select value={f.source} onChange={(e) => set('source', e.target.value)}>
                <option value="">-- How it came in --</option>
                {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
              </select></div>
          )}
        </div>
        {!isSite && (
          <div className="field" style={{ maxWidth: 340 }}><label>Request source</label>
            <select value={f.source} onChange={(e) => set('source', e.target.value)}>
              <option value="">-- How it came in --</option>
              {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
            </select></div>
        )}
        <div className="field"><label>Brief description</label>
          <textarea value={f.description} onChange={(e) => set('description', e.target.value)}
            placeholder="Scope, location, or key details for the estimator…" maxLength={5000} /></div>
        {error && <div className="field-hint c-red mb8">{error}</div>}
        <div className="flex gap8 mt8">
          <button className="btn btn-primary" disabled={busy || !f.name.trim() || f.name.trim().length < 3 || !f.type || !f.priority || !f.deadline}>
            {busy ? 'Creating…' : 'Submit request'}
          </button>
          <button type="button" className="btn btn-outline" onClick={() => setF({ ...empty })}>Clear</button>
        </div>
      </form>
    </div>
  );
}
