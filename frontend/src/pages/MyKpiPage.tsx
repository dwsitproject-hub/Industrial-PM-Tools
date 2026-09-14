import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { MONTHS, fmtDate } from '../labels';
import { Badge, EmptyState, Spinner } from '../ui';

export default function MyKpiPage() {
  const { profile } = useAuth();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const curMonth = now.getMonth() + 1;

  const { data: summary } = useQuery({
    queryKey: ['kpi', 'me', 'summary', year, curMonth],
    queryFn: () => api.get(`/api/v1/kpi/summary?year=${year}&month=${curMonth}`),
  });
  const { data: entries } = useQuery({
    queryKey: ['kpi', 'me', 'entries', year],
    queryFn: () => api.get(`/api/v1/kpi/entries?year=${year}`),
  });

  if (!summary || !entries) return <div className="page"><Spinner /></div>;
  const me = summary.members[0];
  const onTarget = entries.filter((e: any) => e.type === 'AUTO' && e.points > 0 && e.month === curMonth && year === now.getFullYear()).length;
  const missed = entries.filter((e: any) => e.type === 'AUTO' && e.points < 0 && e.month === curMonth && year === now.getFullYear()).length;

  const years: number[] = [];
  for (let y = now.getFullYear(); y >= 2026; y--) years.push(y);

  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="flex" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div className="page-title">{profile!.user.fullName} — My KPI</div>
          <div className="page-sub">Points are credited automatically when your tickets complete.</div>
        </div>
        <select style={{ width: 'auto', alignSelf: 'flex-start' }} value={year} onChange={(e) => setYear(parseInt(e.target.value, 10))}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {year === now.getFullYear() && (
        <div className="stat-grid cols3">
          <div className="stat"><div className="stat-label">This month total</div>
            <div className="stat-val" style={{ color: me.total >= 0 ? undefined : 'var(--red)' }}>{me.total >= 0 ? '+' : ''}{me.total} pts</div></div>
          <div className="stat"><div className="stat-label" style={{ color: 'var(--green-text)' }}>On target</div>
            <div className="stat-val" style={{ color: 'var(--green-text)' }}>{onTarget}</div></div>
          <div className="stat"><div className="stat-label c-red">Missed</div>
            <div className="stat-val" style={{ color: 'var(--red)' }}>{missed}</div></div>
        </div>
      )}

      <div className="fs12 fw5 c-muted mb8">Monthly overview — {year}</div>
      <div className="member-kpi-month">
        {MONTHS.map((m, i) => {
          const mo = i + 1;
          const total = entries.filter((e: any) => e.month === mo).reduce((s: number, e: any) => s + e.points, 0);
          const future = year === now.getFullYear() && mo > curMonth;
          const isCur = year === now.getFullYear() && mo === curMonth;
          return (
            <div key={m} className={`member-kpi-cell${isCur ? ' current' : ''}`} style={future ? { opacity: .35 } : undefined}>
              <div className="fs11 c-muted mb8">{m}</div>
              <div className="fs15 fw5" style={{ color: total < 0 ? 'var(--red)' : undefined }}>
                {future ? '—' : `${total >= 0 ? '+' : ''}${total}`}
              </div>
            </div>
          );
        })}
      </div>

      <div className="fs12 fw5 c-muted mb8">Transaction history — {year}</div>
      <div className="card">
        {entries.length ? (
          <table className="tbl">
            <thead><tr><th>Month</th><th>Type</th><th>Points</th><th>Description</th><th>Ticket</th><th>Date</th></tr></thead>
            <tbody>
              {entries.map((e: any) => (
                <tr key={e.id}>
                  <td className="fw5">{MONTHS[e.month - 1]}</td>
                  <td><Badge kind={e.type} /></td>
                  <td><span className={`kpi-pt-badge ${e.points >= 0 ? 'kpi-pt-pos' : 'kpi-pt-neg'}`}>{e.points > 0 ? '+' : ''}{e.points}</span></td>
                  <td className="c-muted">{e.description || '—'}</td>
                  <td className="c-hint mono fs11">{e.ticketNo || '—'}</td>
                  <td className="c-hint">{fmtDate(e.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <EmptyState text="No KPI entries this year" />}
      </div>
    </div>
  );
}
