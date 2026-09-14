import { createContext, useCallback, useContext, useState, ReactNode } from 'react';
import { AV_PALETTE, STATUS_LABELS, TYPE_SHORT, PRIORITY_LABELS, fmtDate } from './labels';

export function Badge({ kind, label }: { kind: string; label?: string }) {
  return <span className={`badge b-${kind}`}>{label ?? kind}</span>;
}
export const StatusBadge = ({ s }: { s: string }) => <Badge kind={s} label={STATUS_LABELS[s] || s} />;
export const TypeBadge = ({ t }: { t: string }) => <Badge kind={t} label={TYPE_SHORT[t] || t} />;
export const PriorityBadge = ({ p }: { p: string }) => <Badge kind={p} label={PRIORITY_LABELS[p] || p} />;

export function Avatar({ name, color, size = 26 }: { name?: string | null; color?: number; size?: number }) {
  if (!name) {
    return <span className="av av-none" style={{ width: size, height: size, fontSize: size * 0.4 }}>?</span>;
  }
  return (
    <span className="av" style={{ width: size, height: size, fontSize: size * 0.42, background: AV_PALETTE[color ?? 0] }}>
      {name[0]?.toUpperCase()}
    </span>
  );
}

export function DueDate({ deadline, isOverdue }: { deadline: string; isOverdue: boolean }) {
  return (
    <span style={{ color: isOverdue ? 'var(--red)' : 'var(--hint)', fontWeight: isOverdue ? 500 : 400 }}>
      {fmtDate(deadline)}
      {isOverdue && <span className="overdue-badge">Overdue</span>}
    </span>
  );
}

export function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

export function Spinner() {
  return <div className="empty-state">Loading…</div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="flex" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>{title}</div>
          <button className="btn btn-outline btn-xs" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── toast ──
interface ToastCtx { toast: (msg: string, isError?: boolean) => void }
const TCtx = createContext<ToastCtx>({ toast: () => {} });
export const useToast = () => useContext(TCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const toast = useCallback((text: string, isError = false) => {
    setMsg({ text, error: isError });
    window.clearTimeout((toast as any)._t);
    (toast as any)._t = window.setTimeout(() => setMsg(null), 3200);
  }, []);
  return (
    <TCtx.Provider value={{ toast }}>
      {children}
      {msg && <div className={`toast${msg.error ? ' error' : ''}`}>{msg.text}</div>}
    </TCtx.Provider>
  );
}
