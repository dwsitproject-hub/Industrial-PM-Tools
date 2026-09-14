import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getAccessToken } from '../api';
import { MONTHS, MONTHS_FULL, fmtDate } from '../labels';
import { Avatar, Badge, EmptyState, Modal, Spinner, useToast } from '../ui';

export default function KpiPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [modal, setModal] = useState<'settings' | 'opening' | 'bonus' | null>(null);
  const [bonusFor, setBonusFor] = useState('');
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: summary } = useQuery({
    queryKey: ['kpi', 'summary', year, month],
    queryFn: () => api.get(`/api/v1/kpi/summary?year=${year}&month=${month}`),
  });
  const { data: entries } = useQuery({
    queryKey: ['kpi', 'entries', year, month],
    queryFn: () => api.get(`/api/v1/kpi/entries?year=${year}&month=${month}`),
  });
  const { data: settings } = useQuery({ queryKey: ['kpi', 'settings'], queryFn: () => api.get('/api/v1/kpi/settings') });

  async function exportCsv() {
    const res = await fetch(`/api/v1/kpi/export?year=${year}`, {
      headers: { Authorization: `Bearer ${getAccessToken()}` }, credentials: 'include',
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `engpro-kpi-${year}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const years = [now.getFullYear(), now.getFullYear() - 1];
  if (!summary) return <div className="page"><Spinner /></div>;

  return (
    <div className="page" style={{ maxWidth: 1200 }}>
      <div className="flex" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
        <div>
          <div className="page-title">KPI Dashboard</div>
          <div className="page-sub" style={{ marginBottom: 0 }}>Points per member. Auto from tickets + manual bonus from manager.</div>
        </div>
        <div className="flex gap8" style={{ flexWrap: 'wrap' }}>
          <select style={{ width: 'auto' }} value={year} onChange={(e) => setYear(parseInt(e.target.value, 10))}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <button className="btn btn-outline btn-sm" onClick={() => setModal('settings')}>KPI Settings</button>
          <button className="btn btn-outline btn-sm" onClick={() => setModal('opening')}>Set opening points</button>
          <button className="btn btn-outline btn-sm" onClick={exportCsv}>Export CSV</button>
          <button className="btn btn-accent btn-sm" onClick={() => { setBonusFor(''); setModal('bonus'); }}>+ Bonus / penalty</button>
        </div>
      </div>

      <div className="fs12 fw5 c-muted mb8">Select month</div>
      <div className="kpi-month-grid">
        {MONTHS.map((m, i) => {
          const mo = i + 1;
          const total = summary.monthStrip.find((s: any) => s.month === mo)?.total ?? 0;
          const future = year === now.getFullYear() && mo > now.getMonth() + 1;
          return (
            <button key={m} className={`kpi-month-btn${mo === month ? ' active' : ''}`} style={future ? { opacity: .4 } : undefined}
              onClick={() => setMonth(mo)}>
              <span className="kpi-m-label">{m}</span>
              <span className="kpi-m-pts" style={mo !== month ? { color: total >= 0 ? 'var(--green-text)' : 'var(--red)' } : undefined}>
                {total >= 0 ? '+' : ''}{total}
              </span>
            </button>
          );
        })}
      </div>

      <div className="fs12 fw5 c-muted mb8">{MONTHS_FULL[month - 1]} {year}</div>
      <div className="kpi-member-grid">
        {summary.members.map((m: any, idx: number) => (
          <div key={m.id} className={`kpi-card${idx === 0 && m.total > 0 ? ' top' : ''}`}>
            <div className="flex gap8 mb8">
              <Avatar name={m.fullName} color={m.avatarColor} size={32} />
              <div style={{ flex: 1 }}>
                <div className="fs13 fw5">{m.fullName}{idx === 0 && m.total > 0 ? ' 🏆' : ''}{!m.isActive && <span className="c-hint"> (inactive)</span>}</div>
                <div className="fs11 c-hint">Estimator</div>
              </div>
              <button className="btn btn-outline btn-xs" onClick={() => { setBonusFor(m.id); setModal('bonus'); }}>+ Bonus</button>
            </div>
            <div className={`kpi-total ${m.total >= 0 ? 'positive' : 'negative'}`}>{m.total >= 0 ? '+' : ''}{m.total} pts</div>
            <div className="fs11 c-hint">Total this month</div>
            <div className="kpi-breakdown">
              <div className="kpi-b-item"><div className="kpi-b-val" style={{ color: '#F59E0B' }}>{m.breakdown.opening >= 0 ? '+' : ''}{m.breakdown.opening}</div><div className="kpi-b-label">Opening</div></div>
              <div className="kpi-b-item"><div className="kpi-b-val" style={{ color: 'var(--accent)' }}>{m.breakdown.auto >= 0 ? '+' : ''}{m.breakdown.auto}</div><div className="kpi-b-label">Tickets</div></div>
              <div className="kpi-b-item"><div className="kpi-b-val" style={{ color: '#8B5CF6' }}>{m.breakdown.manual >= 0 ? '+' : ''}{m.breakdown.manual}</div><div className="kpi-b-label">Bonus</div></div>
            </div>
          </div>
        ))}
      </div>

      <div className="fs12 fw5 c-muted mb8">Transaction history — {MONTHS_FULL[month - 1]} {year}</div>
      <div className="card">
        {entries?.length ? (
          <table className="tbl">
            <thead><tr><th>Member</th><th>Type</th><th>Points</th><th>Description</th><th>Ticket</th><th>Date</th></tr></thead>
            <tbody>
              {entries.map((e: any) => (
                <tr key={e.id}>
                  <td className="fw5">{e.user.fullName}</td>
                  <td><Badge kind={e.type} /></td>
                  <td><span className={`kpi-pt-badge ${e.points >= 0 ? 'kpi-pt-pos' : 'kpi-pt-neg'}`}>{e.points > 0 ? '+' : ''}{e.points}</span></td>
                  <td className="c-muted">{e.description || '—'}</td>
                  <td className="c-hint mono fs11">{e.ticketNo || '—'}</td>
                  <td className="c-hint">{fmtDate(e.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <EmptyState text="No entries this month" />}
      </div>

      {modal === 'settings' && settings && (
        <SettingsModal settings={settings} onClose={() => setModal(null)} onSaved={() => { setModal(null); qc.invalidateQueries({ queryKey: ['kpi'] }); toast('KPI settings saved'); }} />
      )}
      {modal === 'opening' && summary && settings && (
        <OpeningModal year={year} month={month} members={summary.members} defaultPts={settings.pointOpening}
          onClose={() => setModal(null)} onSaved={() => { setModal(null); qc.invalidateQueries({ queryKey: ['kpi'] }); toast('Opening points saved'); }} />
      )}
      {modal === 'bonus' && summary && (
        <BonusModal year={year} month={month} members={summary.members} preselect={bonusFor}
          onClose={() => setModal(null)} onSaved={() => { setModal(null); qc.invalidateQueries({ queryKey: ['kpi'] }); toast('Entry added'); }} />
      )}
    </div>
  );
}

function SettingsModal({ settings, onClose, onSaved }: any) {
  const [opening, setOpening] = useState(settings.pointOpening);
  const [onT, setOnT] = useState(settings.pointOnTarget);
  const [miss, setMiss] = useState(settings.pointMissTarget);
  const { toast } = useToast();
  const save = useMutation({
    mutationFn: () => api.put('/api/v1/kpi/settings', { pointOpening: +opening, pointOnTarget: +onT, pointMissTarget: +miss }),
    onSuccess: onSaved,
    onError: (e: any) => toast(e.message, true),
  });
  return (
    <Modal title="KPI Settings" onClose={onClose}>
      <div className="field"><label>Opening points per member per month</label>
        <input type="number" value={opening} onChange={(e) => setOpening(e.target.value)} /></div>
      <div className="field"><label>Points on-target (done ≤ deadline)</label>
        <input type="number" value={onT} onChange={(e) => setOnT(e.target.value)} /></div>
      <div className="field"><label>Points miss-target (done &gt; deadline, negative)</label>
        <input type="number" value={miss} onChange={(e) => setMiss(e.target.value)} /></div>
      <button className="btn btn-primary btn-full mt8" onClick={() => save.mutate()} disabled={save.isPending}>Save settings</button>
    </Modal>
  );
}

function OpeningModal({ year, month, members, defaultPts, onClose, onSaved }: any) {
  const [values, setValues] = useState<Record<string, number>>(
    Object.fromEntries(members.map((m: any) => [m.id, m.breakdown.opening !== 0 ? m.breakdown.opening : defaultPts])),
  );
  const { toast } = useToast();
  const save = useMutation({
    mutationFn: () => api.post('/api/v1/kpi/opening', {
      year, month, items: members.map((m: any) => ({ userId: m.id, points: +values[m.id] || 0 })),
    }),
    onSuccess: onSaved,
    onError: (e: any) => toast(e.message, true),
  });
  return (
    <Modal title={`Set opening points — ${MONTHS_FULL[month - 1]} ${year}`} onClose={onClose}>
      <div className="field-hint mb12">Default {defaultPts} pts. Re-saving replaces the month's opening entry, never duplicates.</div>
      {members.map((m: any) => (
        <div key={m.id} className="flex gap8 mb8">
          <Avatar name={m.fullName} color={m.avatarColor} size={26} />
          <span className="fs13 fw5" style={{ flex: 1 }}>{m.fullName}</span>
          <input type="number" style={{ width: 90, textAlign: 'center' }} value={values[m.id]}
            onChange={(e) => setValues({ ...values, [m.id]: e.target.value as any })} />
        </div>
      ))}
      <button className="btn btn-primary btn-full mt12" onClick={() => save.mutate()} disabled={save.isPending}>Save opening points</button>
    </Modal>
  );
}

function BonusModal({ year, month, members, preselect, onClose, onSaved }: any) {
  const [userId, setUserId] = useState(preselect || '');
  const [points, setPoints] = useState('5');
  const [description, setDescription] = useState('');
  const { toast } = useToast();
  const save = useMutation({
    mutationFn: () => api.post('/api/v1/kpi/entries', { userId, year, month, points: +points, description: description.trim() }),
    onSuccess: onSaved,
    onError: (e: any) => toast(e.message, true),
  });
  return (
    <Modal title={`Add bonus / penalty — ${MONTHS_FULL[month - 1]} ${year}`} onClose={onClose}>
      <div className="field"><label>Member</label>
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">-- Select member --</option>
          {members.map((m: any) => <option key={m.id} value={m.id}>{m.fullName}</option>)}
        </select></div>
      <div className="field"><label>Points (negative = penalty)</label>
        <input type="number" value={points} onChange={(e) => setPoints(e.target.value)} /></div>
      <div className="field"><label>Reason (required)</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Exceptional work on tender" maxLength={200} /></div>
      <button className="btn btn-primary btn-full mt8" onClick={() => save.mutate()}
        disabled={save.isPending || !userId || !points || +points === 0 || description.trim().length < 3}>
        Add entry
      </button>
    </Modal>
  );
}
