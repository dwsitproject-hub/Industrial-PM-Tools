import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Perms, useAuth, usePerm } from '../auth';
import { AV_PALETTE, fmtDateTime } from '../labels';
import { Avatar, Badge, EmptyState, Modal, Spinner, useToast } from '../ui';

type Tab = 'workspace' | 'users' | 'sites' | 'roles' | 'audit';
const TAB_META: { key: Tab; label: string; perm: string }[] = [
  { key: 'users', label: 'Users', perm: 'stUsers' },
  { key: 'sites', label: 'Sites', perm: 'stSites' },
  { key: 'roles', label: 'Roles', perm: 'stRoles' },
  { key: 'workspace', label: 'Workspace', perm: 'stWorkspace' },
  { key: 'audit', label: 'Audit trail', perm: 'stAudit' },
];

export default function SettingsPage() {
  const can = usePerm();
  const visible = TAB_META.filter((t) => can(t.perm));
  const [tab, setTab] = useState<Tab>(visible[0]?.key ?? 'users');
  useEffect(() => {
    if (!visible.some((t) => t.key === tab) && visible.length) setTab(visible[0].key);
  }, [visible.map((t) => t.key).join(',')]);
  if (!visible.length) return <div className="page"><EmptyState text="No settings sections enabled for your role" /></div>;
  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <div className="page-title">Settings</div>
      <div className="page-sub">Workspace, people, sites, role permissions and the audit trail.</div>
      <div className="tabs">
        {visible.map((t) => (
          <div key={t.key} className={`tab${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </div>
        ))}
      </div>
      {tab === 'users' && <UsersTab />}
      {tab === 'sites' && <SitesTab />}
      {tab === 'roles' && <RolesTab />}
      {tab === 'workspace' && <WorkspaceTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}

// ── roles ──
const ROLE_INFO: Record<string, { label: string; desc: string }> = {
  MANAGER: { label: 'Manager', desc: 'Locked to full access so the Roles page can never lock everyone out.' },
  ADMIN: { label: 'Admin', desc: 'Office intake & coordination. Edit grants the full field set on any visible ticket.' },
  SITE_ADMIN: { label: 'Site Admin', desc: 'Always limited to their own site. Edit = required-by date; Delete = own new tickets only.' },
  ESTIMATOR: { label: 'Estimator', desc: 'Edit = status of tickets assigned to them; Delete = own new tickets only.' },
};
const RES_META: { key: string; label: string; actions: string[]; hint?: string }[] = [
  { key: 'dashboard', label: 'Dashboard', actions: ['view'] },
  { key: 'board', label: 'Kanban board', actions: ['view'] },
  { key: 'ticketsAll', label: 'All tickets (list page)', actions: ['view'] },
  { key: 'ticketsMy', label: 'My tickets / My site tickets', actions: ['view'] },
  { key: 'tickets', label: 'Ticket actions', actions: ['create', 'edit', 'delete'], hint: 'Applies on every page where tickets appear' },
  { key: 'kpi', label: 'KPI dashboard (team)', actions: ['view', 'create', 'edit'], hint: 'Create = opening & bonus entries · Edit = KPI settings' },
  { key: 'kpiMe', label: 'My KPI (personal)', actions: ['view'] },
  { key: 'stWorkspace', label: 'Settings · Workspace', actions: ['view', 'edit'] },
  { key: 'stUsers', label: 'Settings · Users', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'stSites', label: 'Settings · Sites', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'stRoles', label: 'Settings · Roles', actions: ['view', 'edit'] },
  { key: 'stAudit', label: 'Settings · Audit trail', actions: ['view'] },
];
const ACTIONS = ['view', 'create', 'edit', 'delete'];
const ACTION_LABEL: Record<string, string> = { view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete' };

function RolesTab() {
  const { toast } = useToast();
  const { profile, refreshPerms } = useAuth();
  const can = usePerm();
  const qc = useQueryClient();
  const [selected, setSelected] = useState('ESTIMATOR');
  const [draft, setDraft] = useState<Perms | null>(null);

  const { data: roles, isLoading } = useQuery({
    queryKey: ['roles', 'all'],
    queryFn: () => api.get('/api/v1/roles'),
  });
  const current = roles?.find((r: any) => r.role === selected);
  useEffect(() => {
    setDraft(current ? JSON.parse(JSON.stringify(current)) : null);
  }, [selected, roles]);

  const canEditRoles = can('stRoles', 'edit');
  const locked = selected === 'MANAGER' || !canEditRoles;
  const dirty = draft && current && JSON.stringify(draft) !== JSON.stringify(current);

  const save = useMutation({
    mutationFn: () => api.put(`/api/v1/roles/${selected}`, { ticketScope: draft!.ticketScope, pages: draft!.pages }),
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      if (selected === profile!.user.role) await refreshPerms();
      toast(`${ROLE_INFO[selected].label} permissions saved — applies live to signed-in users`);
    },
    onError: (e: any) => toast(e.message, true),
  });
  const reset = useMutation({
    mutationFn: () => api.put(`/api/v1/roles/${selected}/reset`, {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['roles'] }); toast('Restored to defaults'); },
    onError: (e: any) => toast(e.message, true),
  });

  if (isLoading || !roles) return <Spinner />;

  const toggle = (res: string, action: string) => {
    if (locked || !draft) return;
    setDraft({
      ...draft,
      pages: { ...draft.pages, [res]: { ...draft.pages[res], [action]: !draft.pages[res]?.[action as 'view'] } },
    });
  };

  return (
    <>
      <div className="setting-section">
        <div className="setting-hd"><span>Role to configure</span></div>
        <div className="setting-body">
          <div className="flex gap8" style={{ flexWrap: 'wrap' }}>
            {roles.map((r: any) => (
              <button key={r.role}
                className={`btn btn-sm ${selected === r.role ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setSelected(r.role)}>
                {ROLE_INFO[r.role]?.label || r.role}{r.locked ? ' 🔒' : ''}
              </button>
            ))}
          </div>
          <div className="field-hint mt8">{ROLE_INFO[selected]?.desc}</div>
        </div>
      </div>

      {draft && (
        <>
          <div className="setting-section">
            <div className="setting-hd"><span>Task (ticket) access scope</span></div>
            <div className="setting-body">
              <label className="flex gap8 fs13 mb8" style={{ cursor: locked ? 'default' : 'pointer' }}>
                <input type="radio" style={{ width: 'auto' }} disabled={locked}
                  checked={draft.ticketScope === 'ALL'}
                  onChange={() => !locked && setDraft({ ...draft, ticketScope: 'ALL' })} />
                <span><b>All tickets</b> — the role sees every ticket in the workspace{selected === 'SITE_ADMIN' ? ' (Site Admins are still limited to their own site)' : ''}</span>
              </label>
              <label className="flex gap8 fs13" style={{ cursor: locked ? 'default' : 'pointer' }}>
                <input type="radio" style={{ width: 'auto' }} disabled={locked}
                  checked={draft.ticketScope === 'OWN'}
                  onChange={() => !locked && setDraft({ ...draft, ticketScope: 'OWN' })} />
                <span><b>Only their own</b> — tickets assigned to them or created by them</span>
              </label>
            </div>
          </div>

          <div className="setting-section">
            <div className="setting-hd"><span>Pages, tabs & actions</span></div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Page / tab</th>
                  {ACTIONS.map((a) => <th key={a} style={{ textAlign: 'center', width: 80 }}>{ACTION_LABEL[a]}</th>)}
                </tr>
              </thead>
              <tbody>
                {RES_META.map((r) => (
                  <tr key={r.key}>
                    <td>
                      <div className="fs13 fw5">{r.label}</div>
                      {r.hint && <div className="fs11 c-hint">{r.hint}</div>}
                    </td>
                    {ACTIONS.map((a) => (
                      <td key={a} style={{ textAlign: 'center' }}>
                        {r.actions.includes(a) ? (
                          <input type="checkbox" style={{ width: 16, height: 16 }}
                            checked={draft.pages[r.key]?.[a as 'view'] === true}
                            disabled={locked}
                            onChange={() => toggle(r.key, a)} />
                        ) : <span className="c-hint">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="setting-body flex gap8">
              {selected === 'MANAGER' ? (
                <span className="fs12 c-muted">The Manager role is locked to full access and cannot be edited.</span>
              ) : (
                <>
                  <button className="btn btn-primary btn-sm" disabled={!dirty || !canEditRoles || save.isPending}
                    onClick={() => save.mutate()}>
                    {save.isPending ? 'Saving…' : 'Save permissions'}
                  </button>
                  {dirty && <button className="btn btn-outline btn-sm" onClick={() => setDraft(JSON.parse(JSON.stringify(current)))}>Discard</button>}
                  <button className="btn btn-outline btn-sm" style={{ marginLeft: 'auto' }} disabled={!canEditRoles || reset.isPending}
                    onClick={() => { if (window.confirm(`Restore ${ROLE_INFO[selected].label} to the shipped defaults?`)) reset.mutate(); }}>
                    Restore defaults
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ── users ──
function UsersTab() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [modal, setModal] = useState<null | { mode: 'add' } | { mode: 'edit'; user: any }>(null);
  const [tempPw, setTempPw] = useState<{ name: string; pw: string } | null>(null);
  const { data: users, isLoading } = useQuery({ queryKey: ['users', 'admin'], queryFn: () => api.get('/api/v1/users') });

  const resetPw = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/users/${id}/reset-password`),
    onSuccess: (res: any, id) => {
      const u = users.find((x: any) => x.id === id);
      setTempPw({ name: u?.fullName || '', pw: res.tempPassword });
    },
    onError: (e: any) => toast(e.message, true),
  });
  const deactivate = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/users/${id}`),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast(res.openTicketsStillAssigned
        ? `Deactivated. ${res.openTicketsStillAssigned} open ticket(s) still carry this assignee.`
        : 'User deactivated');
    },
    onError: (e: any) => toast(e.message, true),
  });

  if (isLoading) return <Spinner />;
  const roleBadge: Record<string, string> = { MANAGER: 'DONE', ADMIN: 'IN_PROGRESS_ESTIMATION', SITE_ADMIN: 'SITE_INSTRUCTION', ESTIMATOR: 'NEW' };

  return (
    <div className="setting-section">
      <div className="setting-hd">
        <span>Accounts ({users.length})</span>
        <button className="btn btn-outline btn-sm" onClick={() => setModal({ mode: 'add' })}>+ Add user</button>
      </div>
      {users.map((u: any) => (
        <div key={u.id} className="member-row" style={{ opacity: u.isActive ? 1 : 0.5 }}>
          <Avatar name={u.fullName} color={u.avatarColor} size={32} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="fs13 fw5">
              {u.fullName} <Badge kind={roleBadge[u.role]} label={u.role.replace('_', ' ')} />
              {u.site && <span className="fs11 c-hint"> · {u.site.name}</span>}
              {!u.isActive && <span className="fs11 c-red"> · inactive</span>}
              {u.mustChangePassword && <span className="fs11" style={{ color: '#854F0B' }}> · temp password</span>}
            </div>
            <div className="fs11 c-hint mono">{u.username}{u.email ? ` · ${u.email}` : ''}</div>
          </div>
          <button className="btn btn-outline btn-xs" onClick={() => setModal({ mode: 'edit', user: u })}>Edit</button>
          <button className="btn btn-outline btn-xs" onClick={() => resetPw.mutate(u.id)}>Reset password</button>
          {u.id !== profile!.user.id && u.isActive && (
            <button className="btn btn-danger btn-xs" onClick={() => { if (window.confirm(`Deactivate ${u.fullName}? Their sessions end and they can no longer log in.`)) deactivate.mutate(u.id); }}>
              Deactivate
            </button>
          )}
        </div>
      ))}
      {modal && (
        <UserModal
          existing={modal.mode === 'edit' ? modal.user : null}
          onClose={() => setModal(null)}
          onSaved={(temp?: { name: string; pw: string }) => {
            setModal(null);
            qc.invalidateQueries({ queryKey: ['users'] });
            if (temp) setTempPw(temp);
            else toast('Saved');
          }}
        />
      )}
      {tempPw && (
        <Modal title={`Temporary password for ${tempPw.name}`} onClose={() => setTempPw(null)}>
          <p className="fs13 c-muted mb12">Share this once — it is not stored readable and cannot be shown again. The user must change it at first login.</p>
          <div className="mono" style={{ fontSize: 20, textAlign: 'center', padding: '12px', background: 'var(--surface2)', borderRadius: 8, userSelect: 'all' }}>
            {tempPw.pw}
          </div>
          <button className="btn btn-primary btn-full mt12" onClick={() => { navigator.clipboard?.writeText(tempPw.pw); setTempPw(null); }}>
            Copy & close
          </button>
        </Modal>
      )}
    </div>
  );
}

function UserModal({ existing, onClose, onSaved }: any) {
  const { toast } = useToast();
  const [f, setF] = useState<any>(existing
    ? { username: existing.username, fullName: existing.fullName, email: existing.email || '', role: existing.role, siteId: existing.site?.id || existing.siteId || '', avatarColor: existing.avatarColor, isActive: existing.isActive }
    : { username: '', fullName: '', email: '', role: 'ESTIMATOR', siteId: '', avatarColor: 0, isActive: true });
  const { data: sites } = useQuery({ queryKey: ['sites'], queryFn: () => api.get('/api/v1/sites') });
  const save = useMutation({
    mutationFn: () => existing
      ? api.patch(`/api/v1/users/${existing.id}`, {
          fullName: f.fullName, email: f.email || undefined, role: f.role,
          siteId: f.role === 'SITE_ADMIN' ? f.siteId : undefined, avatarColor: f.avatarColor, isActive: f.isActive,
        })
      : api.post('/api/v1/users', {
          username: f.username.trim(), fullName: f.fullName, email: f.email || undefined, role: f.role,
          siteId: f.role === 'SITE_ADMIN' ? f.siteId : undefined, avatarColor: f.avatarColor,
        }),
    onSuccess: (res: any) => onSaved(res.tempPassword ? { name: res.fullName, pw: res.tempPassword } : undefined),
    onError: (e: any) => toast(e.message, true),
  });
  return (
    <Modal title={existing ? `Edit ${existing.fullName}` : 'Add user'} onClose={onClose}>
      {!existing && (
        <div className="field"><label>Username (login)</label>
          <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} placeholder="e.g. andi" /></div>
      )}
      <div className="field"><label>Full name</label>
        <input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></div>
      <div className="field"><label>Email (optional)</label>
        <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
      <div className="field"><label>Role</label>
        <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          <option value="ESTIMATOR">Estimator — works assigned tickets</option>
          <option value="ADMIN">Admin — intake & manage tickets</option>
          <option value="SITE_ADMIN">Site Admin — submits for one site</option>
          <option value="MANAGER">Manager — full access</option>
        </select></div>
      {f.role === 'SITE_ADMIN' && (
        <div className="field"><label>Site</label>
          <select value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value })}>
            <option value="">-- Select site --</option>
            {(sites || []).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></div>
      )}
      <div className="field"><label>Avatar colour</label>
        <div className="color-dots">
          {AV_PALETTE.map((c, i) => (
            <div key={c} className={`color-dot${f.avatarColor === i ? ' sel' : ''}`} style={{ background: c }}
              onClick={() => setF({ ...f, avatarColor: i })}>{f.avatarColor === i ? '✓' : ''}</div>
          ))}
        </div></div>
      <button className="btn btn-primary btn-full mt8" onClick={() => save.mutate()}
        disabled={save.isPending || !f.fullName || (!existing && f.username.trim().length < 3) || (f.role === 'SITE_ADMIN' && !f.siteId)}>
        {existing ? 'Save changes' : 'Create user & generate password'}
      </button>
    </Modal>
  );
}

// ── sites ──
function SitesTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [modal, setModal] = useState<null | { site?: any }>(null);
  const { data: sites, isLoading } = useQuery({ queryKey: ['sites'], queryFn: () => api.get('/api/v1/sites') });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/sites/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sites'] }); toast('Site removed'); },
    onError: (e: any) => toast(e.body?.message || e.message, true),
  });
  if (isLoading) return <Spinner />;
  return (
    <div className="setting-section">
      <div className="setting-hd">
        <span>Sites ({sites.length})</span>
        <button className="btn btn-outline btn-sm" onClick={() => setModal({})}>+ Add site</button>
      </div>
      {sites.map((s: any) => (
        <div key={s.id} className="member-row" style={{ opacity: s.isActive ? 1 : 0.5 }}>
          <Avatar name={s.name} color={s.color} size={32} />
          <div style={{ flex: 1 }}>
            <div className="fs13 fw5">{s.name}{!s.isActive && <span className="fs11 c-red"> · inactive</span>}</div>
          </div>
          <button className="btn btn-outline btn-xs" onClick={() => setModal({ site: s })}>Edit</button>
          <button className="btn btn-danger btn-xs" onClick={() => { if (window.confirm(`Remove ${s.name}? Blocked if the site still has active tickets or users.`)) remove.mutate(s.id); }}>Remove</button>
        </div>
      ))}
      {sites.length === 0 && <EmptyState text="No sites yet" />}
      {modal && (
        <SiteModal site={modal.site} onClose={() => setModal(null)}
          onSaved={() => { setModal(null); qc.invalidateQueries({ queryKey: ['sites'] }); toast('Saved'); }} />
      )}
    </div>
  );
}

function SiteModal({ site, onClose, onSaved }: any) {
  const { toast } = useToast();
  const [name, setName] = useState(site?.name || '');
  const [color, setColor] = useState(site?.color ?? 3);
  const save = useMutation({
    mutationFn: () => site
      ? api.patch(`/api/v1/sites/${site.id}`, { name, color })
      : api.post('/api/v1/sites', { name, color }),
    onSuccess: onSaved,
    onError: (e: any) => toast(e.message, true),
  });
  return (
    <Modal title={site ? `Edit ${site.name}` : 'Add site'} onClose={onClose}>
      <div className="field"><label>Site name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bontang" /></div>
      <div className="field"><label>Colour</label>
        <div className="color-dots">
          {AV_PALETTE.map((c, i) => (
            <div key={c} className={`color-dot${color === i ? ' sel' : ''}`} style={{ background: c }}
              onClick={() => setColor(i)}>{color === i ? '✓' : ''}</div>
          ))}
        </div></div>
      <button className="btn btn-primary btn-full mt8" onClick={() => save.mutate()} disabled={save.isPending || name.trim().length < 2}>
        {site ? 'Save' : 'Add site'}
      </button>
    </Modal>
  );
}

// ── workspace ──
function WorkspaceTab() {
  const { profile, refreshProfile } = useAuth();
  const { toast } = useToast();
  const [company, setCompany] = useState(profile!.workspace.company);
  const [subtitle, setSubtitle] = useState(profile!.workspace.subtitle || '');
  const [prefix, setPrefix] = useState(profile!.workspace.ticketPrefix);
  const save = useMutation({
    mutationFn: () => api.patch('/api/v1/workspace', { company, subtitle, ticketPrefix: prefix }),
    onSuccess: async () => { await refreshProfile(); toast('Workspace saved'); },
    onError: (e: any) => toast(e.message, true),
  });
  return (
    <div className="setting-section">
      <div className="setting-hd"><span>Workspace identity</span></div>
      <div className="setting-body">
        <div className="field-row">
          <div className="field"><label>Company name</label>
            <input value={company} onChange={(e) => setCompany(e.target.value)} /></div>
          <div className="field"><label>Subtitle</label>
            <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} /></div>
        </div>
        <div className="field" style={{ maxWidth: 200 }}><label>Ticket prefix (new tickets only)</label>
          <input value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} maxLength={6} /></div>
        <button className="btn btn-outline btn-sm" onClick={() => save.mutate()} disabled={save.isPending || company.trim().length < 2}>
          Save
        </button>
      </div>
    </div>
  );
}

// ── audit ──
function AuditTab() {
  const [entityType, setEntityType] = useState('');
  const [page, setPage] = useState(1);
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['audit', entityType, page],
    queryFn: () => api.get(`/api/v1/audit?page=${page}${entityType ? `&entityType=${entityType}` : ''}`),
  });
  const restore = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/tickets/${id}/restore`),
    onSuccess: () => { qc.invalidateQueries(); toast('Ticket restored'); },
    onError: (e: any) => toast(e.message, true),
  });
  if (isLoading || !data) return <Spinner />;
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <div className="setting-section">
      <div className="setting-hd">
        <span>Audit trail ({data.total})</span>
        <select style={{ width: 'auto' }} value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(1); }}>
          <option value="">All entities</option>
          <option value="ticket">Tickets</option>
          <option value="user">Users</option>
          <option value="site">Sites</option>
          <option value="auth">Auth</option>
          <option value="kpi_entry">KPI</option>
          <option value="workspace">Workspace</option>
        </select>
      </div>
      <table className="tbl">
        <thead><tr><th>When</th><th>Actor</th><th>Entity</th><th>Action</th><th></th></tr></thead>
        <tbody>
          {data.items.map((a: any) => (
            <tr key={a.id}>
              <td className="c-hint fs12">{fmtDateTime(a.createdAt)}</td>
              <td className="fw5">{a.actor?.fullName || 'System'}</td>
              <td className="c-muted fs12">{a.entityType}{a.before?.ticketNo ? ` ${a.before.ticketNo}` : a.after?.ticketNo ? ` ${a.after.ticketNo}` : ''}</td>
              <td><span className="badge b-NORMAL">{a.action}</span></td>
              <td>
                {a.entityType === 'ticket' && a.action === 'delete' && (
                  <button className="btn btn-outline btn-xs" onClick={() => restore.mutate(a.entityId)}>Restore</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pagination">
        <button className="btn btn-outline btn-xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button>
        <span>Page {page} of {totalPages}</span>
        <button className="btn btn-outline btn-xs" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next ›</button>
      </div>
    </div>
  );
}
