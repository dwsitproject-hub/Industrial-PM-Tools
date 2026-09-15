/**
 * EngPro legacy ETL — Tech Doc v1.0 Section 7.
 * Migrates production workspace 73e3be57 from the /db CSV export into the new schema:
 *  - identity mapping (members + site_admins + seeded manager)
 *  - duplicate ticket_no repair (DQ-1) with legacy_ticket_no preservation
 *  - notes and KPI ledger mapping, "Manager" author absorption
 *  - validation gate (7.5) printed at the end; non-zero exit on failure
 * Idempotent: wipes and reloads the target workspace on each run.
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';

const PROD_WS = '73e3be57-c404-4463-b336-8d429e022477';
const LEGACY_DIR = process.env.LEGACY_DIR || path.join(__dirname, '..', '..', 'db');
const MANAGER_PASSWORD = process.env.SEED_MANAGER_PASSWORD || 'Manager@2026!';
const MEMBER_PASSWORD = process.env.SEED_MEMBER_PASSWORD || 'ChangeMe123!';
// Login is by email; the legacy export has none, so synthesise one per account.
// Override with SEED_EMAIL_DOMAIN=yourcompany.com to generate real-looking addresses.
const EMAIL_DOMAIN = process.env.SEED_EMAIL_DOMAIN || 'engpro.local';
const emailFor = (username: string) => `${username.toLowerCase()}@${EMAIL_DOMAIN}`;

const prisma = new PrismaClient();

const STATUS_MAP: Record<string, string> = {
  'New': 'NEW',
  'In Progress Estimation': 'IN_PROGRESS_ESTIMATION',
  'In Progress Tender': 'IN_PROGRESS_TENDER',
  'Done': 'DONE',
  'Hold': 'HOLD',
};
const TYPE_MAP: Record<string, string> = {
  'Project Tender': 'PROJECT_TENDER',
  'Ops Tender': 'OPS_TENDER',
  'Site Instruction / Site Memo': 'SITE_INSTRUCTION',
  'Budgeting Internal': 'BUDGETING_INTERNAL',
};
const SOURCE_MAP: Record<string, string | null> = {
  'WhatsApp': 'WHATSAPP', 'Email': 'EMAIL', 'Verbal / meeting': 'VERBAL', '': null,
};

function readCsv(name: string): any[] {
  const file = path.join(LEGACY_DIR, name);
  const raw = fs.readFileSync(file, 'utf8');
  return parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true });
}

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function main() {
  console.log(`ETL source: ${LEGACY_DIR}`);
  const lWorkspaces = readCsv('workspaces_rows.csv').filter((w) => w.id === PROD_WS);
  const lMembers = readCsv('members_rows.csv').filter((m) => m.workspace_id === PROD_WS);
  const lSites = readCsv('site_admins_rows.csv').filter((s) => s.workspace_id === PROD_WS);
  const lTickets = readCsv('tickets_rows.csv').filter((t) => t.workspace_id === PROD_WS);
  const lSettings = readCsv('kpi_settings_rows.csv').filter((s) => s.workspace_id === PROD_WS);
  const lKpi = readCsv('kpi_entries_rows.csv').filter((k) => k.workspace_id === PROD_WS);
  const ticketIds = new Set(lTickets.map((t) => t.id));
  const lNotes = readCsv('notes_rows.csv').filter((n) => ticketIds.has(n.ticket_id));
  if (!lWorkspaces.length) throw new Error('Production workspace not found in export');

  // ---- wipe target workspace (idempotent re-run) ----
  await prisma.$transaction([
    prisma.auditLog.deleteMany({ where: { workspaceId: PROD_WS } }),
    prisma.kpiEntry.deleteMany({ where: { workspaceId: PROD_WS } }),
    prisma.ticketNote.deleteMany({ where: { ticket: { workspaceId: PROD_WS } } }),
    prisma.ticket.deleteMany({ where: { workspaceId: PROD_WS } }),
    prisma.refreshToken.deleteMany({ where: { user: { workspaceId: PROD_WS } } }),
    prisma.kpiSettings.deleteMany({ where: { workspaceId: PROD_WS } }),
    prisma.user.deleteMany({ where: { workspaceId: PROD_WS } }),
    prisma.site.deleteMany({ where: { workspaceId: PROD_WS } }),
    prisma.workspace.deleteMany({ where: { id: PROD_WS } }),
  ]);

  // ---- workspace ----
  const lw = lWorkspaces[0];
  await prisma.workspace.create({
    data: {
      id: PROD_WS, company: lw.company, subtitle: lw.subtitle || null,
      ticketPrefix: 'EST', timezone: 'Asia/Jakarta', createdAt: new Date(lw.created_at),
    },
  });

  // ---- kpi settings ----
  const ls = lSettings[0];
  await prisma.kpiSettings.create({
    data: {
      workspaceId: PROD_WS,
      pointOnTarget: ls ? parseInt(ls.point_on_target, 10) : 3,
      pointMissTarget: ls ? parseInt(ls.point_miss_target, 10) : -2,
      pointOpening: ls ? parseInt(ls.point_opening, 10) : 10,
    },
  });

  // ---- users ----
  const managerHash = await argon2.hash(MANAGER_PASSWORD, { type: argon2.argon2id });
  const memberHash = await argon2.hash(MEMBER_PASSWORD, { type: argon2.argon2id });

  const manager = await prisma.user.create({
    data: {
      workspaceId: PROD_WS, username: 'manager', email: emailFor('manager'),
      fullName: 'Estimation Manager',
      role: 'MANAGER', passwordHash: managerHash, avatarColor: 0, mustChangePassword: false,
    },
  });

  const nameToUserId = new Map<string, string>();
  for (const m of lMembers) {
    const role = m.role === 'admin' ? 'ADMIN' : 'ESTIMATOR';
    const user = await prisma.user.create({
      data: {
        id: m.id, workspaceId: PROD_WS,
        username: m.name.toLowerCase().replace(/\s+/g, '_'),
        email: emailFor(m.name.replace(/\s+/g, '_')),
        fullName: m.name, role: role as any,
        avatarColor: parseInt(m.color, 10) || 0,
        passwordHash: memberHash, mustChangePassword: false,
        createdAt: new Date(m.created_at),
      },
    });
    nameToUserId.set(m.name, user.id);
  }

  // ---- sites + site-admin users ----
  const siteNameToId = new Map<string, string>();
  const siteNameToUserId = new Map<string, string>();
  for (const s of lSites) {
    const site = await prisma.site.create({
      data: {
        id: s.id, workspaceId: PROD_WS, name: s.site_name,
        color: parseInt(s.color, 10) || 3, createdAt: new Date(s.created_at),
      },
    });
    siteNameToId.set(s.site_name, site.id);
    const su = await prisma.user.create({
      data: {
        workspaceId: PROD_WS, username: `site.${slug(s.site_name)}`,
        email: emailFor(`site.${slug(s.site_name)}`),
        fullName: `${s.site_name} Site Admin`, role: 'SITE_ADMIN', siteId: site.id,
        avatarColor: parseInt(s.color, 10) || 3,
        passwordHash: memberHash, mustChangePassword: false,
      },
    });
    siteNameToUserId.set(s.site_name, su.id);
  }

  // ---- duplicate ticket_no repair (7.4) ----
  const byNo = new Map<string, any[]>();
  for (const t of lTickets) {
    if (!byNo.has(t.ticket_no)) byNo.set(t.ticket_no, []);
    byNo.get(t.ticket_no)!.push(t);
  }
  let maxSuffix = 0;
  for (const no of byNo.keys()) {
    const m = no.match(/(\d+)$/);
    if (m) maxSuffix = Math.max(maxSuffix, parseInt(m[1], 10));
  }
  const renumbered: { id: string; from: string; to: string; name: string }[] = [];
  const toRenumber: any[] = [];
  for (const [, group] of byNo) {
    if (group.length <= 1) continue;
    group.sort((a, b) => a.created_at.localeCompare(b.created_at));
    toRenumber.push(...group.slice(1)); // earliest keeps the number
  }
  toRenumber.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const finalNo = new Map<string, { no: string; legacy: string | null }>();
  for (const t of lTickets) finalNo.set(t.id, { no: t.ticket_no, legacy: null });
  for (const t of toRenumber) {
    maxSuffix += 1;
    const newNo = `EST-${String(maxSuffix).padStart(3, '0')}`;
    finalNo.set(t.id, { no: newNo, legacy: t.ticket_no });
    renumbered.push({ id: t.id, from: t.ticket_no, to: newNo, name: t.name });
  }

  // ---- tickets ----
  for (const t of lTickets) {
    const fn = finalNo.get(t.id)!;
    const status = STATUS_MAP[t.status];
    const assigneeId = t.assignee ? nameToUserId.get(t.assignee) || null : null;
    const siteId = t.site_name ? siteNameToId.get(t.site_name) || null : null;
    const submittedById = t.submitted_by
      ? nameToUserId.get(t.submitted_by) || siteNameToUserId.get(t.submitted_by) || null
      : null;
    await prisma.ticket.create({
      data: {
        id: t.id, workspaceId: PROD_WS,
        ticketNo: fn.no, legacyTicketNo: fn.legacy,
        name: t.name.length < 3 ? t.name.padEnd(3, '.') : t.name.slice(0, 200),
        type: TYPE_MAP[t.type] as any,
        priority: t.priority.toUpperCase() as any,
        status: status as any,
        requestor: t.requestor || null,
        source: (SOURCE_MAP[t.source] ?? null) as any,
        description: t.description ? t.description.slice(0, 5000) : null,
        deadline: new Date(t.deadline + 'T00:00:00Z'),
        assigneeId, siteId, submittedById,
        createdAt: new Date(t.created_at),
        updatedAt: new Date(t.updated_at),
        completedAt: status === 'DONE' ? new Date(t.updated_at) : null,
      },
    });
    if (fn.legacy) {
      await prisma.ticketNote.create({
        data: {
          ticketId: t.id, authorId: null, authorLabel: 'System',
          content: `Ticket renumbered from ${fn.legacy} to ${fn.no} during migration (duplicate repair).`,
          statusAtTime: status as any,
          createdAt: new Date(),
        },
      });
    }
  }
  // sequence continues after the highest assigned number
  await prisma.workspace.update({ where: { id: PROD_WS }, data: { ticketSeq: BigInt(maxSuffix) } });

  // ---- notes ----
  for (const n of lNotes) {
    const authorId = n.author === 'Manager'
      ? manager.id
      : nameToUserId.get(n.author) || siteNameToUserId.get(n.author) || null;
    await prisma.ticketNote.create({
      data: {
        id: n.id, ticketId: n.ticket_id,
        authorId, authorLabel: n.author || 'Unknown',
        content: n.content.slice(0, 2000) || '-',
        statusAtTime: (STATUS_MAP[n.status_at_time] || 'NEW') as any,
        createdAt: new Date(n.created_at),
      },
    });
  }

  // ---- kpi entries ----
  let kpiSkipped = 0;
  for (const k of lKpi) {
    const userId = nameToUserId.get(k.member_name);
    if (!userId) { kpiSkipped++; continue; }
    const tExists = k.ticket_id && ticketIds.has(k.ticket_id);
    const legacyRef = k.ticket_id ? finalNo.get(k.ticket_id) : null;
    await prisma.kpiEntry.create({
      data: {
        id: k.id, workspaceId: PROD_WS, userId,
        month: parseInt(k.month, 10), year: parseInt(k.year, 10),
        points: parseInt(k.points, 10),
        type: (k.type === 'auto' ? 'AUTO' : k.type === 'opening' ? 'OPENING' : 'MANUAL') as any,
        description: k.description || null,
        ticketId: tExists ? k.ticket_id : null,
        ticketNo: legacyRef ? legacyRef.no : (k.ticket_no || null),
        createdById: k.created_by === 'Manager' ? manager.id : null,
        createdBy: k.created_by || 'System',
        createdAt: new Date(k.created_at),
      },
    });
  }

  // ---- validation gate (7.5) ----
  const counts = {
    users: await prisma.user.count({ where: { workspaceId: PROD_WS } }),
    sites: await prisma.site.count({ where: { workspaceId: PROD_WS } }),
    tickets: await prisma.ticket.count({ where: { workspaceId: PROD_WS } }),
    notes: await prisma.ticketNote.count({ where: { ticket: { workspaceId: PROD_WS } } }),
    kpi: await prisma.kpiEntry.count({ where: { workspaceId: PROD_WS } }),
  };
  const expected = {
    users: lMembers.length + lSites.length + 1,
    sites: lSites.length,
    tickets: lTickets.length,
    notes: lNotes.length + renumbered.length,
    kpi: lKpi.length - kpiSkipped,
  };
  const dupCheck: any[] = await prisma.$queryRaw`
    SELECT ticket_no, count(*) c FROM tickets WHERE workspace_id = ${PROD_WS}::uuid
    GROUP BY ticket_no HAVING count(*) > 1`;
  // KPI per-member/month reconciliation vs legacy
  let kpiMismatch = 0;
  const legacySums = new Map<string, number>();
  for (const k of lKpi) {
    if (!nameToUserId.get(k.member_name)) continue;
    const key = `${k.member_name}|${k.year}|${k.month}`;
    legacySums.set(key, (legacySums.get(key) || 0) + parseInt(k.points, 10));
  }
  for (const [key, sum] of legacySums) {
    const [name, y, m] = key.split('|');
    const agg = await prisma.kpiEntry.aggregate({
      where: { workspaceId: PROD_WS, userId: nameToUserId.get(name)!, year: parseInt(y, 10), month: parseInt(m, 10) },
      _sum: { points: true },
    });
    if ((agg._sum.points ?? 0) !== sum) kpiMismatch++;
  }

  console.log('--- ETL validation gate ---');
  console.log('counts     :', counts);
  console.log('expected   :', expected);
  console.log('renumbered :', renumbered.length, 'tickets (duplicate repair)');
  console.log('dup ticket_no remaining:', dupCheck.length);
  console.log('kpi member-month mismatches:', kpiMismatch, `(skipped ${kpiSkipped})`);
  fs.writeFileSync(
    path.join(__dirname, 'renumbered_tickets_report.csv'),
    'old_no,new_no,name\n' + renumbered.map((r) => `${r.from},${r.to},"${r.name.replace(/"/g, '""')}"`).join('\n'),
  );
  console.log('report     : prisma/renumbered_tickets_report.csv');
  console.log(`logins     : ${emailFor('manager')} / ${MANAGER_PASSWORD}`);
  console.log(`             members e.g. ${emailFor('rully')}, ${emailFor('site.dumai')} / ${MEMBER_PASSWORD}`);

  const pass = counts.users === expected.users && counts.sites === expected.sites
    && counts.tickets === expected.tickets && counts.notes === expected.notes
    && counts.kpi === expected.kpi && dupCheck.length === 0 && kpiMismatch === 0;
  if (!pass) {
    console.error('VALIDATION GATE FAILED');
    process.exit(1);
  }
  console.log('VALIDATION GATE PASSED');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
