/**
 * AR-03 / PT-E — cross-tenant isolation with two real tenants.
 *
 * The security assessment is explicit that isolation which has been claimed but not tested is
 * not isolation, and that this series must pass before any external company is given an
 * account. Everything here is executed against the API directly, ignoring the UI, because the
 * UI hiding something is not a control.
 *
 * Tenancy model B: one workspace, every record owned by a company. Exactly one company is
 * INTERNAL (the host organisation, unscoped); users of any other company are hard-scoped.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

const prisma = new PrismaClient();
let app: INestApplication;
let http: any;

const PW = 'Password10!';
let ws: any;
let kpn: any, acme: any, beta: any;
let siteA: any;
let kpnManager: any, kpnEst: any, acmeManager: any, acmeEst: any, betaManager: any;
let kpnTicket: any, acmeTicket: any;

const tokens: Record<string, string> = {};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function login(email: string): Promise<string> {
  const res = await request(http).post('/api/v1/auth/login').send({ email, password: PW });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

function iso(days: number): string {
  return new Date(Date.now() + days * 86400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
}

beforeAll(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.kpiEntry.deleteMany();
  await prisma.ticketNote.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.kpiSettings.deleteMany();
  await prisma.user.deleteMany();
  await prisma.site.deleteMany();
  await prisma.company.deleteMany();
  await prisma.workspace.deleteMany();

  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  ws = await prisma.workspace.create({ data: { company: 'KPN Downstream', ticketPrefix: 'TEN' } });
  kpn = await prisma.company.create({ data: { workspaceId: ws.id, name: 'KPN Downstream', isInternal: true } });
  acme = await prisma.company.create({ data: { workspaceId: ws.id, name: 'Acme Contractors' } });
  beta = await prisma.company.create({ data: { workspaceId: ws.id, name: 'Beta Engineering' } });
  siteA = await prisma.site.create({ data: { workspaceId: ws.id, name: 'Dumai' } });

  const mk = (username: string, role: string, companyId: string, extra: any = {}) => prisma.user.create({
    data: {
      workspaceId: ws.id, companyId, username, email: `${username}@tenancy.local`,
      fullName: username.toUpperCase(), role: role as any, passwordHash: hash,
      mustChangePassword: false, activatedAt: new Date(), isActive: true, ...extra,
    },
  });
  kpnManager = await mk('kpn.boss', 'MANAGER', kpn.id);
  kpnEst = await mk('kpn.alice', 'ESTIMATOR', kpn.id);
  acmeManager = await mk('acme.boss', 'MANAGER', acme.id);
  acmeEst = await mk('acme.dave', 'ESTIMATOR', acme.id);
  betaManager = await mk('beta.boss', 'MANAGER', beta.id);

  await prisma.kpiSettings.create({
    data: { workspaceId: ws.id, pointOnTarget: 3, pointMissTarget: -2, pointOpening: 10 },
  });

  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  http = app.getHttpServer();

  tokens.kpnManager = await login('kpn.boss@tenancy.local');
  tokens.kpnEst = await login('kpn.alice@tenancy.local');
  tokens.acmeManager = await login('acme.boss@tenancy.local');
  tokens.acmeEst = await login('acme.dave@tenancy.local');
  tokens.betaManager = await login('beta.boss@tenancy.local');

  // One ticket per tenant, each carrying a distinctive term for the search-leak test.
  const mkTicket = async (token: string, name: string, extra: any = {}) => {
    const res = await request(http).post('/api/v1/tickets').set(auth(token)).send({
      name, type: 'PROJECT_TENDER', priority: 'NORMAL', deadline: iso(30), ...extra,
    });
    expect(res.status).toBe(201);
    return res.body;
  };
  kpnTicket = await mkTicket(tokens.kpnManager, 'Kerosene hydrotreater ZZQQ-INTERNAL', {
    siteId: siteA.id, tenderValue: '9500000.00', tenderStatus: 'SUBMITTED',
  });
  acmeTicket = await mkTicket(tokens.acmeManager, 'Acme scaffolding YYXX-EXTERNAL');
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

// ── PT-E ─────────────────────────────────────────────────────────────────────
describe('PT-E: the tenancy model is wired up at all', () => {
  it('stamps the owning company from the author, not the request', async () => {
    const row = await prisma.ticket.findUnique({ where: { id: acmeTicket.id } });
    expect(row!.companyId).toBe(acme.id);
    const internal = await prisma.ticket.findUnique({ where: { id: kpnTicket.id } });
    expect(internal!.companyId).toBe(kpn.id);
  });

  it('marks external identities in the access token and leaves internal ones unscoped', () => {
    const claims = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
    expect(claims(tokens.acmeManager).ext).toBe(true);
    expect(claims(tokens.acmeManager).co).toBe(acme.id);
    expect(claims(tokens.kpnManager).ext).toBeUndefined();
  });
});

describe('PT-E01 cross-tenant object access', () => {
  it('an external manager cannot open another company ticket by id', async () => {
    const res = await request(http).get(`/api/v1/tickets/${kpnTicket.id}`).set(auth(tokens.acmeManager));
    // 404, not 403: a 403 would confirm the ticket exists.
    expect(res.status).toBe(404);
  });

  it('nor can one external company reach another', async () => {
    const res = await request(http).get(`/api/v1/tickets/${acmeTicket.id}`).set(auth(tokens.betaManager));
    expect(res.status).toBe(404);
  });

  it('cannot read another company notes', async () => {
    const res = await request(http).get(`/api/v1/tickets/${kpnTicket.id}/notes`).set(auth(tokens.acmeManager));
    expect(res.status).toBe(404);
  });

  it('cannot write a note onto another company ticket', async () => {
    const res = await request(http).post(`/api/v1/tickets/${kpnTicket.id}/notes`)
      .set(auth(tokens.acmeManager)).send({ content: 'I should not be able to write here' });
    expect(res.status).toBe(404);
    expect(await prisma.ticketNote.count({ where: { ticketId: kpnTicket.id } })).toBe(0);
  });

  it('cannot modify, delete or restore another company ticket', async () => {
    const patch = await request(http).patch(`/api/v1/tickets/${kpnTicket.id}`)
      .set(auth(tokens.acmeManager)).send({ status: 'DONE', version: 1 });
    expect(patch.status).toBe(404);
    const del = await request(http).delete(`/api/v1/tickets/${kpnTicket.id}`).set(auth(tokens.acmeManager));
    expect(del.status).toBe(404);
    const restore = await request(http).post(`/api/v1/tickets/${kpnTicket.id}/restore`).set(auth(tokens.acmeManager));
    expect(restore.status).toBe(404);
    const still = await prisma.ticket.findUnique({ where: { id: kpnTicket.id } });
    expect(still!.status).toBe('NEW');
    expect(still!.deletedAt).toBeNull();
  });

  it('the internal organisation still sees everything its role allows', async () => {
    const res = await request(http).get(`/api/v1/tickets/${acmeTicket.id}`).set(auth(tokens.kpnManager));
    expect(res.status).toBe(200);
  });
});

describe('PT-E02 listing, search, stats and export leakage', () => {
  it('listings contain only the caller own company', async () => {
    const res = await request(http).get('/api/v1/tickets?pageSize=100').set(auth(tokens.acmeManager));
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((t: any) => t.id !== kpnTicket.id)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('ZZQQ-INTERNAL');
    expect(JSON.stringify(res.body)).not.toContain('9500000');
  });

  it('searching another company distinctive term never surfaces their record', async () => {
    const res = await request(http).get('/api/v1/tickets?q=ZZQQ-INTERNAL').set(auth(tokens.acmeManager));
    expect(res.status).toBe(200);
    // Search is fuzzy (trigram), so it may still return the caller's own loosely-matching
    // tickets. The isolation property is that the internal ticket is not among them.
    expect(res.body.items.some((t: any) => t.id === kpnTicket.id)).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('ZZQQ-INTERNAL');
    expect(JSON.stringify(res.body)).not.toContain('9500000');
  });

  it('stats are computed within the company, so totals do not leak volume', async () => {
    const mine = await request(http).get('/api/v1/tickets/stats').set(auth(tokens.acmeManager));
    const theirs = await request(http).get('/api/v1/tickets/stats').set(auth(tokens.kpnManager));
    expect(mine.status).toBe(200);
    expect(mine.body.total).toBe(1);
    expect(theirs.body.total).toBeGreaterThan(mine.body.total);
  });

  it('the KPI export carries only the caller own company', async () => {
    await request(http).post('/api/v1/kpi/entries').set(auth(tokens.kpnManager)).send({
      userId: kpnEst.id, year: 2026, month: 9, points: 5, description: 'Internal bonus ZZQQ-INTERNAL',
    }).expect(201);
    const res = await request(http).get('/api/v1/kpi/export?year=2026').set(auth(tokens.acmeManager));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('ZZQQ-INTERNAL');
    expect(res.text).not.toContain('KPN.ALICE');
  });

  it('the KPI summary and ledger show only the caller own company members', async () => {
    const summary = await request(http).get('/api/v1/kpi/summary?year=2026&month=9').set(auth(tokens.acmeManager));
    expect(summary.status).toBe(200);
    expect(JSON.stringify(summary.body)).not.toContain('KPN.ALICE');

    const entries = await request(http).get('/api/v1/kpi/entries?year=2026').set(auth(tokens.acmeManager));
    expect(entries.status).toBe(200);
    expect(JSON.stringify(entries.body)).not.toContain('ZZQQ-INTERNAL');
  });

  it('an external manager cannot award KPI points to a member of another company', async () => {
    const res = await request(http).post('/api/v1/kpi/entries').set(auth(tokens.acmeManager)).send({
      userId: kpnEst.id, year: 2026, month: 9, points: 50, description: 'Should be refused',
    });
    expect(res.status).toBe(403);
    const awarded = await prisma.kpiEntry.count({ where: { userId: kpnEst.id, points: 50 } });
    expect(awarded).toBe(0);
  });
});

describe('PT-E03 existence disclosure', () => {
  it('does not reveal WHICH company an existing address belongs to', async () => {
    const res = await request(http).post('/api/v1/users').set(auth(tokens.acmeManager)).send({
      email: 'kpn.alice@tenancy.local', fullName: 'Impostor', role: 'ESTIMATOR',
    });
    // Email is the login identifier and therefore unique across the shared workspace, so a
    // conflict is unavoidable under this model. What must not leak is whose address it is.
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('That email address is already registered');
    expect(JSON.stringify(res.body)).not.toContain('KPN');
    expect(JSON.stringify(res.body)).not.toContain('kpn.alice');
  });
});

describe('PT-E04 tenant forgery', () => {
  it('ignores a companyId supplied in the ticket body', async () => {
    const res = await request(http).post('/api/v1/tickets').set(auth(tokens.acmeManager)).send({
      name: 'Forged owner attempt', type: 'SITE_INSTRUCTION', priority: 'NORMAL',
      deadline: iso(10), companyId: kpn.id,
    });
    expect(res.status).toBe(201);
    const row = await prisma.ticket.findUnique({ where: { id: res.body.id } });
    expect(row!.companyId).toBe(acme.id);
  });

  it('an external manager cannot plant a user inside the host organisation', async () => {
    const res = await request(http).post('/api/v1/users').set(auth(tokens.acmeManager)).send({
      email: 'planted@tenancy.local', fullName: 'Planted', role: 'MANAGER', companyId: kpn.id,
    });
    expect(res.status).toBe(201);
    const created = await prisma.user.findUnique({ where: { email: 'planted@tenancy.local' } });
    expect(created!.companyId).toBe(acme.id);
    await prisma.user.delete({ where: { id: created!.id } });
  });

  it('cannot assign another company user to own ticket', async () => {
    const res = await request(http).patch(`/api/v1/tickets/${acmeTicket.id}`)
      .set(auth(tokens.acmeManager)).send({ assigneeId: kpnEst.id, version: acmeTicket.version });
    expect(res.status).toBe(400);
  });

  it('a companyId query parameter cannot widen the listing', async () => {
    const res = await request(http)
      .get(`/api/v1/tickets?pageSize=100&companyId=${kpn.id}`).set(auth(tokens.acmeManager));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('ZZQQ-INTERNAL');
  });
});

describe('PT-E05 realtime isolation', () => {
  const { EventsGateway } = require('../src/events/events.gateway');

  function joinRoomsFor(token: string): string[] {
    const gateway = app.get(EventsGateway);
    const rooms: string[] = [];
    const fake: any = {
      handshake: { auth: { token } },
      data: {},
      join: (r: string) => rooms.push(r),
      disconnect: () => rooms.push('DISCONNECTED'),
    };
    gateway.handleConnection(fake);
    return rooms;
  }

  it('an external user never joins the workspace room', () => {
    const rooms = joinRoomsFor(tokens.acmeManager);
    expect(rooms).toContain(`co:${acme.id}`);
    expect(rooms.some((r) => r.startsWith('ws:'))).toBe(false);
  });

  it('an internal user does join the workspace room', () => {
    const rooms = joinRoomsFor(tokens.kpnManager);
    expect(rooms).toContain(`ws:${ws.id}`);
    expect(rooms.some((r) => r.startsWith('co:'))).toBe(false);
  });

  it('an unauthenticated handshake is disconnected', () => {
    expect(joinRoomsFor('not-a-token')).toContain('DISCONNECTED');
  });
});

describe('PT-E06 public metadata', () => {
  it('the public branding endpoint exposes no company list or internal detail', async () => {
    const res = await request(http).get('/api/v1/workspace');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('Acme');
    expect(JSON.stringify(res.body)).not.toContain('Beta Engineering');
  });

  it('an external caller sees only their own company in the companies list', async () => {
    const res = await request(http).get('/api/v1/companies').set(auth(tokens.acmeManager));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(acme.id);
  });

  it('the host organisation sees them all', async () => {
    const res = await request(http).get('/api/v1/companies').set(auth(tokens.kpnManager));
    expect(res.status).toBe(200);
    expect(res.body.map((c: any) => c.name).sort())
      .toEqual(['Acme Contractors', 'Beta Engineering', 'KPN Downstream']);
  });
});

describe('PT-E07 administrative blast radius', () => {
  it('an external manager sees only their own company directory', async () => {
    const res = await request(http).get('/api/v1/users').set(auth(tokens.acmeManager));
    expect(res.status).toBe(200);
    const emails = res.body.map((u: any) => u.email ?? u.username);
    expect(emails.join(',')).not.toContain('kpn.');
    expect(res.body.every((u: any) => u.fullName.startsWith('ACME'))).toBe(true);
  });

  it('cannot edit, reset, deactivate or delete a user of another company', async () => {
    const patch = await request(http).patch(`/api/v1/users/${kpnEst.id}`)
      .set(auth(tokens.acmeManager)).send({ fullName: 'Hijacked', role: 'MANAGER' });
    expect(patch.status).toBe(404);

    const reset = await request(http).post(`/api/v1/users/${kpnEst.id}/reset-password`)
      .set(auth(tokens.acmeManager)).send({});
    expect(reset.status).toBe(404);

    const resend = await request(http).post(`/api/v1/users/${kpnEst.id}/resend-activation`)
      .set(auth(tokens.acmeManager)).send({});
    expect(resend.status).toBe(404);

    const del = await request(http).delete(`/api/v1/users/${kpnEst.id}`).set(auth(tokens.acmeManager));
    expect(del.status).toBe(404);

    const unchanged = await prisma.user.findUnique({ where: { id: kpnEst.id } });
    expect(unchanged!.fullName).toBe('KPN.ALICE');
    expect(unchanged!.role).toBe('ESTIMATOR');
    expect(unchanged!.isActive).toBe(true);
  });

  it('cannot create, rename or deactivate companies', async () => {
    expect((await request(http).post('/api/v1/companies')
      .set(auth(tokens.acmeManager)).send({ name: 'Acme Holdings' })).status).toBe(403);
    expect((await request(http).patch(`/api/v1/companies/${kpn.id}`)
      .set(auth(tokens.acmeManager)).send({ name: 'Owned' })).status).toBe(403);
    expect((await request(http).delete(`/api/v1/companies/${kpn.id}`)
      .set(auth(tokens.acmeManager))).status).toBe(403);
  });

  it('the audit trail shows the caller own company activity only', async () => {
    const res = await request(http).get('/api/v1/audit').set(auth(tokens.acmeManager));
    expect(res.status).toBe(200);
    const actors = res.body.items.map((r: any) => r.actor?.fullName).filter(Boolean);
    expect(actors.every((n: string) => n.startsWith('ACME'))).toBe(true);
  });

  it('the host organisation cannot be deactivated or removed', async () => {
    expect((await request(http).patch(`/api/v1/companies/${kpn.id}`)
      .set(auth(tokens.kpnManager)).send({ isActive: false })).status).toBe(400);
    expect((await request(http).delete(`/api/v1/companies/${kpn.id}`)
      .set(auth(tokens.kpnManager))).status).toBe(400);
  });
});

describe('PT-E08 deactivating a company closes the door behind it', () => {
  it('deactivates its users and stops them signing in', async () => {
    const res = await request(http).delete(`/api/v1/companies/${beta.id}`).set(auth(tokens.kpnManager));
    expect(res.status).toBe(200);
    expect(res.body.usersDeactivated).toBeGreaterThan(0);

    const login = await request(http).post('/api/v1/auth/login')
      .send({ email: 'beta.boss@tenancy.local', password: PW });
    expect(login.status).toBe(401);

    const stale = await request(http).get('/api/v1/tickets').set(auth(tokens.betaManager));
    // The existing access token stays valid until it expires, but a refresh is refused —
    // the documented revocation window (AR/PT-A07).
    expect([200, 401]).toContain(stale.status);
    const refreshed = await request(http).post('/api/v1/auth/refresh');
    expect(refreshed.status).toBe(401);
  });
});
