import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { usePerm } from '../auth';
import { EmptyState, Modal, Spinner, useToast } from '../ui';

/**
 * AR-03: companies are the tenancy boundary. The host organisation is fixed — it is
 * established by migration and cannot be created, renamed away or removed here, because
 * "which company is us" decides who is unscoped.
 */
export default function CompaniesTab() {
  const { toast } = useToast();
  const can = usePerm();
  const qc = useQueryClient();
  const [modal, setModal] = useState<null | { company?: any }>(null);

  const { data: companies, isLoading } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<any[]>('/api/v1/companies'),
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/companies/${id}`),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ['companies'] });
      qc.invalidateQueries({ queryKey: ['users'] });
      toast(`Company deactivated · ${r?.usersDeactivated ?? 0} user(s) signed out`);
    },
    onError: (e: any) => toast(e.body?.message || e.message, true),
  });

  if (isLoading) return <Spinner />;

  return (
    <div className="setting-section">
      <div className="setting-hd">
        <span>Companies ({companies?.length ?? 0})</span>
        {can('stCompanies', 'create') && (
          <button className="btn btn-outline btn-sm" onClick={() => setModal({})}>+ Add company</button>
        )}
      </div>
      <div className="fs12 c-muted mb12">
        External companies see only their own tickets, people and KPI — never yours, and never
        each other&apos;s. Add a company first, then create its users in the Users tab and pick
        the company there.
      </div>

      {(companies ?? []).map((c: any) => (
        <div key={c.id} className="member-row" style={{ opacity: c.isActive ? 1 : 0.5 }}>
          <div style={{ flex: 1 }}>
            <div className="fs13 fw5">
              {c.name}
              {c.isInternal && <span className="fs11 c-hint"> · your organisation</span>}
              {!c.isActive && <span className="fs11 c-red"> · deactivated</span>}
            </div>
            <div className="fs11 c-muted">
              {c.users} user{c.users === 1 ? '' : 's'} · {c.tickets} ticket{c.tickets === 1 ? '' : 's'}
            </div>
          </div>
          {can('stCompanies', 'edit') && !c.isInternal && (
            <button className="btn btn-outline btn-xs" onClick={() => setModal({ company: c })}>Edit</button>
          )}
          {can('stCompanies', 'delete') && !c.isInternal && c.isActive && (
            <button className="btn btn-danger btn-xs" onClick={() => {
              if (window.confirm(
                `Deactivate ${c.name}?\n\nIts ${c.users} user(s) will be signed out and unable to `
                + 'sign in again. Their tickets are kept.',
              )) deactivate.mutate(c.id);
            }}>Deactivate</button>
          )}
        </div>
      ))}

      {(companies?.length ?? 0) === 0 && <EmptyState text="No companies yet" />}

      {modal && (
        <CompanyModal
          company={modal.company}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            qc.invalidateQueries({ queryKey: ['companies'] });
            toast('Saved');
          }}
        />
      )}
    </div>
  );
}

function CompanyModal({ company, onClose, onSaved }: { company?: any; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(company?.name ?? '');
  const [isActive, setActive] = useState(company?.isActive ?? true);
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () => (company
      ? api.patch(`/api/v1/companies/${company.id}`, { name: name.trim(), isActive })
      : api.post('/api/v1/companies', { name: name.trim() })),
    onSuccess: onSaved,
    onError: (e: any) => setError(e.body?.message || e.message || 'Could not save.'),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    save.mutate();
  }

  return (
    <Modal title={company ? 'Edit company' : 'Add company'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label>Company name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
            placeholder="Acme Contractors" maxLength={120} />
        </div>
        {company && (
          <label className="flex items-center gap8 fs12 mb8">
            <input type="checkbox" checked={isActive} onChange={(e) => setActive(e.target.checked)} />
            Active — unticking blocks sign-in for everyone in this company
          </label>
        )}
        {!company && (
          <div className="fs11 c-hint mb8">
            Users are added afterwards in the Users tab. Anyone you place in this company will
            see only records belonging to it.
          </div>
        )}
        {error && <div className="field-hint c-red mb8">{error}</div>}
        <div className="flex gap8">
          <button className="btn btn-primary" disabled={name.trim().length < 2 || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
