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
let ws: any, siteA: any, siteB: any, internalCo: any;
let manager: any, admin: any, est1: any, est2: any, saA: any, saB: any;
const tokens: Record<string, string> = {};

function iso(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
}

const mail = (username: string) => `${username}@test.local`;

async function login(username: string): Promise<string> {
  const res = await request(http).post('/api/v1/auth/login').send({ email: mail(username), password: PW });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function createTicket(token: string, overrides: any = {}) {
  const res = await request(http).post('/api/v1/tickets').set(auth(token)).send({
    name: 'Test ticket ' + Math.random().toString(36).slice(2, 8),
    type: 'PROJECT_TENDER', priority: 'NORMAL', deadline: iso(30), ...overrides,
  });
  return res;
}

beforeAll(async () => {
  // ---- clean test DB ----
  await prisma.auditLog.deleteMany();
  await prisma.kpiEntry.deleteMany();
  await prisma.ticketNote.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.kpiSettings.deleteMany();
  await prisma.user.deleteMany();
  await prisma.site.deleteMany();
  await prisma.company.deleteMany();
  await prisma.workspace.deleteMany();

  // ---- fixtures ----
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  ws = await prisma.workspace.create({ data: { company: 'Test Co', ticketPrefix: 'TST' } });
  // AR-03: the migration guarantees one internal company per workspace, and a user with no
  // company is treated as external (fail closed). Fixtures mirror that.
  internalCo = await prisma.company.create({
    data: { workspaceId: ws.id, name: 'Test Co', isInternal: true },
  });
  siteA = await prisma.site.create({ data: { workspaceId: ws.id, name: 'Site A' } });
  siteB = await prisma.site.create({ data: { workspaceId: ws.id, name: 'Site B' } });
  const mk = (username: string, role: string, extra: any = {}) => prisma.user.create({
    data: {
      workspaceId: ws.id, username, email: mail(username), companyId: internalCo.id,
      fullName: username.toUpperCase(), role: role as any,
      passwordHash: hash, mustChangePassword: false, activatedAt: new Date(), ...extra,
    },
  });
  manager = await mk('boss', 'MANAGER');
  admin = await mk('coord', 'ADMIN');
  est1 = await mk('alice', 'ESTIMATOR');
  est2 = await mk('bob', 'ESTIMATOR');
  saA = await mk('site.a', 'SITE_ADMIN', { siteId: siteA.id });
  saB = await mk('site.b', 'SITE_ADMIN', { siteId: siteB.id });
  await prisma.kpiSettings.create({
    data: { workspaceId: ws.id, pointOnTarget: 3, pointMissTarget: -2, pointOpening: 10 },
  });

  const modRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = modRef.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  http = app.getHttpServer();

  tokens.manager = await login('boss');
  tokens.admin = await login('coord');
  tokens.est1 = await login('alice');
  tokens.est2 = await login('bob');
  tokens.saA = await login('site.a');
  tokens.saB = await login('site.b');
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────
describe('F1 health & bootstrap', () => {
  it('GET /health is public', async () => {
    const res = await request(http).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
  it('GET /ready checks the database', async () => {
    const res = await request(http).get('/api/v1/ready');
    expect(res.body.status).toBe('ready');
  });
  it('GET /workspace is public branding without secrets', async () => {
    const res = await request(http).get('/api/v1/workspace');
    expect(res.status).toBe(200);
    expect(res.body.company).toBe('Test Co');
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
  });
  it('protected endpoints reject missing/invalid tokens', async () => {
    expect((await request(http).get('/api/v1/tickets')).status).toBe(401);
    expect((await request(http).get('/api/v1/tickets').set(auth('garbage'))).status).toBe(401);
  });
});

describe('F3 authentication & sessions', () => {
  it('valid login returns access token, profile and refresh cookie', async () => {
    const res = await request(http).post('/api/v1/auth/login').send({ email: mail('alice'), password: PW });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.role).toBe('ESTIMATOR');
    expect(res.body.workspace.company).toBe('Test Co');
    const cookie = res.headers['set-cookie']?.[0] || '';
    expect(cookie).toContain('engpro_rt=');
    expect(cookie).toContain('HttpOnly');
  });
  it('wrong password and unknown user return the same uniform 401', async () => {
    const bad = await request(http).post('/api/v1/auth/login').send({ email: mail('alice'), password: 'nope-nope' });
    const ghost = await request(http).post('/api/v1/auth/login').send({ email: mail('ghost'), password: 'nope-nope' });
    expect(bad.status).toBe(401);
    expect(ghost.status).toBe(401);
    expect(bad.body.message).toBe(ghost.body.message);
  });
  it('refresh rotates the token; replaying the old one revokes the family', async () => {
    const agent = request.agent(http);
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: mail('bob'), password: PW });
    const oldCookie = loginRes.headers['set-cookie'][0].split(';')[0];
    // rotate
    const r1 = await agent.post('/api/v1/auth/refresh');
    expect(r1.status).toBe(200);
    expect(r1.body.accessToken).toBeTruthy();
    const newCookie = r1.headers['set-cookie'][0].split(';')[0];
    expect(newCookie).not.toBe(oldCookie);
    // replay the OLD token -> 401 + family revoked
    const replay = await request(http).post('/api/v1/auth/refresh').set('Cookie', oldCookie);
    expect(replay.status).toBe(401);
    const afterReplay = await request(http).post('/api/v1/auth/refresh').set('Cookie', newCookie);
    expect(afterReplay.status).toBe(401); // whole family dead
  });
  it('logout revokes the refresh token', async () => {
    const agent = request.agent(http);
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: mail('bob'), password: PW });
    const token = loginRes.body.accessToken;
    await agent.post('/api/v1/auth/logout').set(auth(token)).expect(200);
    const r = await agent.post('/api/v1/auth/refresh');
    expect(r.status).toBe(401);
  });
  it('login throttling returns 429 after the per-username limit', async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const res = await request(http).post('/api/v1/auth/login')
        .send({ email: mail('throttle-target'), password: 'wrong-wrong' });
      last = res.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
  it('email login is case- and whitespace-insensitive', async () => {
    const res = await request(http).post('/api/v1/auth/login')
      .send({ email: '  ALICE@Test.Local  ', password: PW });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('alice@test.local');
  });
  it('a malformed email is rejected as a validation error, not a credential check', async () => {
    const res = await request(http).post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: PW });
    expect(res.status).toBe(400);
  });
  it('the old username is no longer accepted as a login identifier', async () => {
    const res = await request(http).post('/api/v1/auth/login').send({ username: 'alice', password: PW });
    expect(res.status).toBe(400);
  });
  it('GET /auth/me returns the profile', async () => {
    const res = await request(http).get('/api/v1/auth/me').set(auth(tokens.saA));
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('SITE_ADMIN');
    expect(res.body.user.siteName).toBe('Site A');
  });
});

describe('F16 user administration + forced password change', () => {
  let newUserId = '';
  let charlieLink = '';
  const linkToken = (link: string) => new URL(link).searchParams.get('token')!;
  it('manager creates a user and receives an activation link, never a password', async () => {
    const res = await request(http).post('/api/v1/users').set(auth(tokens.manager)).send({
      email: 'charlie@test.local', fullName: 'Charlie New', role: 'ESTIMATOR', avatarColor: 2,
    });
    expect(res.status).toBe(201);
    expect(res.body.tempPassword).toBeUndefined();
    expect(res.body.activation.link).toContain('/activate?token=');
    expect(res.body.activatedAt).toBeNull();
    newUserId = res.body.id;
    charlieLink = res.body.activation.link;
  });
  it('duplicate email is rejected with 409', async () => {
    const res = await request(http).post('/api/v1/users').set(auth(tokens.manager)).send({
      email: 'charlie@test.local', fullName: 'Charlie Dupe', role: 'ESTIMATOR',
    });
    expect(res.status).toBe(409);
  });
  it('a created user logs in with their email, and username is derived from it', async () => {
    const res = await request(http).post('/api/v1/users').set(auth(tokens.manager)).send({
      email: 'Dana.Lee@Test.Local', fullName: 'Dana Lee', role: 'ESTIMATOR',
    });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe('dana.lee@test.local');   // normalised
    expect(res.body.username).toBe('dana.lee');           // derived from the local-part
    await request(http).post('/api/v1/auth/activate')
      .send({ token: linkToken(res.body.activation.link), newPassword: 'DanaLee#2026pw' })
      .expect(200);
    const loginRes = await request(http).post('/api/v1/auth/login')
      .send({ email: 'dana.lee@test.local', password: 'DanaLee#2026pw' });
    expect(loginRes.status).toBe(200);
  });
  it('creating a user without a valid email is rejected', async () => {
    const noEmail = await request(http).post('/api/v1/users').set(auth(tokens.manager))
      .send({ fullName: 'No Email', role: 'ESTIMATOR' });
    expect(noEmail.status).toBe(400);
    const badEmail = await request(http).post('/api/v1/users').set(auth(tokens.manager))
      .send({ email: 'nope', fullName: 'Bad Email', role: 'ESTIMATOR' });
    expect(badEmail.status).toBe(400);
  });
  it('changing a user email to one already in use returns 409', async () => {
    const res = await request(http).patch(`/api/v1/users/${est2.id}`).set(auth(tokens.manager))
      .send({ email: mail('alice') });
    expect(res.status).toBe(409);
  });
  it('non-manager cannot create users', async () => {
    const res = await request(http).post('/api/v1/users').set(auth(tokens.admin)).send({
      email: 'mallory@test.local', fullName: 'Mallory', role: 'ESTIMATOR',
    });
    expect(res.status).toBe(403);
  });
  it('a must-change-password flag forces the change before any other call', async () => {
    // charlie activates with a password of their own
    await request(http).post('/api/v1/auth/activate')
      .send({ token: linkToken(charlieLink), newPassword: 'Charlie#2026tmp' })
      .expect(200);
    // ops can still force a rotation (this is what the staging hardening SQL does)
    await prisma.user.update({ where: { id: newUserId }, data: { mustChangePassword: true } });
    const tempPassword = 'Charlie#2026tmp';
    const loginRes = await request(http).post('/api/v1/auth/login')
      .send({ email: mail('charlie'), password: tempPassword });
    expect(loginRes.status).toBe(200);
    const t = loginRes.body.accessToken;
    const blocked = await request(http).get('/api/v1/tickets').set(auth(t));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('PasswordChangeRequired');
    // weak new password rejected
    const weak = await request(http).post('/api/v1/auth/change-password').set(auth(t))
      .send({ currentPassword: tempPassword, newPassword: 'short1' });
    expect(weak.status).toBe(400);
    // good new password accepted; new token unlocks the API
    const good = await request(http).post('/api/v1/auth/change-password').set(auth(t))
      .send({ currentPassword: tempPassword, newPassword: 'Charlie#2026ok' });
    expect(good.status).toBe(200);
    const t2 = good.body.accessToken;
    const open = await request(http).get('/api/v1/tickets').set(auth(t2));
    expect(open.status).toBe(200);
  });
  it('manager reset sends a link and leaves the old password working until it is used', async () => {
    const res = await request(http).post(`/api/v1/users/${newUserId}/reset-password`).set(auth(tokens.manager));
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('PASSWORD_RESET');
    expect(res.body.link).toContain('/reset-password?token=');
    expect(res.body.tempPassword).toBeUndefined();
    // unchanged until the link is consumed
    const still = await request(http).post('/api/v1/auth/login')
      .send({ email: mail('charlie'), password: 'Charlie#2026ok' });
    expect(still.status).toBe(200);
    await request(http).post('/api/v1/auth/reset-password')
      .send({ token: linkToken(res.body.link), newPassword: 'Charlie#2026new' }).expect(200);
    const relog = await request(http).post('/api/v1/auth/login')
      .send({ email: mail('charlie'), password: 'Charlie#2026new' });
    expect(relog.status).toBe(200);
  });
  it('deactivated users cannot log in; manager cannot deactivate self', async () => {
    const self = await request(http).delete(`/api/v1/users/${manager.id}`).set(auth(tokens.manager));
    expect(self.status).toBe(400);
    const res = await request(http).delete(`/api/v1/users/${newUserId}`).set(auth(tokens.manager));
    expect(res.status).toBe(200);
    const relog = await request(http).post('/api/v1/auth/login')
      .send({ email: mail('charlie'), password: 'Charlie#2026new' });
    expect(relog.status).toBe(401);
  });
  it('estimators get a directory, not the full admin view', async () => {
    const res = await request(http).get('/api/v1/users').set(auth(tokens.est1));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].email).toBeUndefined();
    expect(res.body[0].mustChangePassword).toBeUndefined();
  });
});

describe('F4/F5 ticket creation & race-free numbering', () => {
  it('admin creates a ticket with server-generated number', async () => {
    const res = await createTicket(tokens.admin, { name: 'Sodium storage tank OSBL piping' });
    expect(res.status).toBe(201);
    expect(res.body.ticketNo).toMatch(/^TST-\d{3,}$/);
    expect(res.body.status).toBe('NEW');
    expect(res.body.version).toBe(1);
  });
  it('estimator cannot create tickets', async () => {
    const res = await createTicket(tokens.est1);
    expect(res.status).toBe(403);
  });
  it('validation rejects missing type and short names', async () => {
    const res = await request(http).post('/api/v1/tickets').set(auth(tokens.admin))
      .send({ name: 'ab', priority: 'NORMAL', deadline: iso(5) });
    expect(res.status).toBe(400);
  });
  it('past deadline requires allowPast flag', async () => {
    const rejected = await createTicket(tokens.admin, { deadline: iso(-3) });
    expect(rejected.status).toBe(400);
    const allowed = await createTicket(tokens.admin, { deadline: iso(-3), allowPast: true });
    expect(allowed.status).toBe(201);
  });
  it('site admin submissions are stamped with their own site — client-sent siteId is ignored', async () => {
    const res = await createTicket(tokens.saA, { siteId: siteB.id, assigneeId: est1.id });
    expect(res.status).toBe(201);
    expect(res.body.siteId).toBe(siteA.id);
    expect(res.body.assigneeId).toBeNull();
  });
  it('20 parallel submissions produce 20 unique consecutive numbers (DATA-1 closed)', async () => {
    const before = await prisma.workspace.findUnique({ where: { id: ws.id } });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => createTicket(tokens.admin, { name: 'Concurrency probe ticket' })),
    );
    const numbers = results.map((r) => { expect(r.status).toBe(201); return r.body.ticketNo; });
    expect(new Set(numbers).size).toBe(20);
    const after = await prisma.workspace.findUnique({ where: { id: ws.id } });
    expect(Number(after!.ticketSeq) - Number(before!.ticketSeq)).toBe(20);
  });
});

describe('F7/F8 listing, filtering, search, pagination', () => {
  it('filters by status/type/assignee and paginates', async () => {
    await createTicket(tokens.admin, { name: 'Filterable urgent ops', type: 'OPS_TENDER', priority: 'URGENT', assigneeId: est1.id });
    const res = await request(http).get('/api/v1/tickets?type=OPS_TENDER&priority=URGENT&pageSize=2&page=1')
      .set(auth(tokens.manager));
    expect(res.status).toBe(200);
    expect(res.body.items.every((t: any) => t.type === 'OPS_TENDER' && t.priority === 'URGENT')).toBe(true);
    expect(res.body.pageSize).toBe(2);
  });
  it('search matches name substrings case-insensitively', async () => {
    const res = await request(http).get('/api/v1/tickets?search=sodium').set(auth(tokens.manager));
    expect(res.status).toBe(200);
    expect(res.body.items.some((t: any) => /sodium/i.test(t.name))).toBe(true);
  });
  it('unassigned filter returns only unassigned tickets', async () => {
    const res = await request(http).get('/api/v1/tickets?assigneeId=unassigned').set(auth(tokens.manager));
    expect(res.body.items.every((t: any) => t.assigneeId === null)).toBe(true);
  });
  it('overdue filter returns only overdue tickets with the flag set', async () => {
    const res = await request(http).get('/api/v1/tickets?overdue=true').set(auth(tokens.manager));
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((t: any) => t.isOverdue === true)).toBe(true);
  });
  it('site admins only ever see their own site (server-forced)', async () => {
    const res = await request(http).get('/api/v1/tickets').set(auth(tokens.saA));
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((t: any) => t.siteId === siteA.id)).toBe(true);
    const cross = await request(http).get(`/api/v1/tickets?siteId=${siteB.id}`).set(auth(tokens.saA));
    expect(cross.body.items.every((t: any) => t.siteId === siteA.id)).toBe(true);
  });
});

describe('F9 ticket update: RBAC envelope + optimistic locking', () => {
  let ticketId = '';
  it('setup: admin creates and assigns to alice', async () => {
    const res = await createTicket(tokens.admin, { name: 'RBAC envelope ticket', assigneeId: est1.id });
    ticketId = res.body.id;
    expect(res.body.assigneeId).toBe(est1.id);
  });
  it('detail exposes the permission envelope per role', async () => {
    const mgr = await request(http).get(`/api/v1/tickets/${ticketId}`).set(auth(tokens.manager));
    expect(mgr.body.permissions.editableFields).toContain('assigneeId');
    const mine = await request(http).get(`/api/v1/tickets/${ticketId}`).set(auth(tokens.est1));
    expect(mine.body.permissions.editableFields).toEqual(['status']);
    const other = await request(http).get(`/api/v1/tickets/${ticketId}`).set(auth(tokens.est2));
    expect(other.body.permissions.editableFields).toEqual([]);
    expect(other.body.permissions.canDelete).toBe(false);
  });
  it('assigned estimator can change status; another estimator cannot', async () => {
    const deny = await request(http).patch(`/api/v1/tickets/${ticketId}`).set(auth(tokens.est2))
      .send({ version: 1, status: 'IN_PROGRESS_ESTIMATION' });
    expect(deny.status).toBe(403);
    expect(deny.body.error).toBe('FieldNotPermitted');
    const ok = await request(http).patch(`/api/v1/tickets/${ticketId}`).set(auth(tokens.est1))
      .send({ version: 1, status: 'IN_PROGRESS_ESTIMATION' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('IN_PROGRESS_ESTIMATION');
    expect(ok.body.version).toBe(2);
  });
  it('estimator cannot reassign even their own ticket', async () => {
    const res = await request(http).patch(`/api/v1/tickets/${ticketId}`).set(auth(tokens.est1))
      .send({ version: 2, assigneeId: est2.id });
    expect(res.status).toBe(403);
    expect(res.body.fields).toContain('assigneeId');
  });
  it('stale version returns 409 with the current version', async () => {
    const res = await request(http).patch(`/api/v1/tickets/${ticketId}`).set(auth(tokens.manager))
      .send({ version: 1, priority: 'URGENT' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('VersionConflict');
    expect(res.body.currentVersion).toBe(2);
  });
  it('site admin may only move the deadline of own-site tickets', async () => {
    const site = await createTicket(tokens.saA, {});
    const sid = site.body.id;
    const ok = await request(http).patch(`/api/v1/tickets/${sid}`).set(auth(tokens.saA))
      .send({ version: 1, deadline: iso(45) });
    expect(ok.status).toBe(200);
    expect(ok.body.deadline).toBe(iso(45));
    const denyStatus = await request(http).patch(`/api/v1/tickets/${sid}`).set(auth(tokens.saA))
      .send({ version: 2, status: 'DONE' });
    expect(denyStatus.status).toBe(403);
    const crossSite = await request(http).patch(`/api/v1/tickets/${sid}`).set(auth(tokens.saB))
      .send({ version: 2, deadline: iso(60) });
    expect(crossSite.status).toBe(404); // no existence leak across sites
  });
  it('tender fields are restricted to tender-type tickets', async () => {
    const t = await createTicket(tokens.admin, { type: 'BUDGETING_INTERNAL' });
    const res = await request(http).patch(`/api/v1/tickets/${t.body.id}`).set(auth(tokens.manager))
      .send({ version: 1, tenderStatus: 'WON', tenderValue: 1000 });
    expect(res.status).toBe(400);
    const t2 = await createTicket(tokens.admin, { type: 'PROJECT_TENDER' });
    const ok = await request(http).patch(`/api/v1/tickets/${t2.body.id}`).set(auth(tokens.manager))
      .send({ version: 1, tenderStatus: 'WON', tenderValue: 2500000.5 });
    expect(ok.status).toBe(200);
    expect(ok.body.tenderStatus).toBe('WON');
    expect(ok.body.tenderValue).toBe(2500000.5);
  });
});

describe('F13 KPI engine: award, miss, reversal, race', () => {
  it('on-time completion awards +3 to the assignee in the same transaction', async () => {
    const t = await createTicket(tokens.admin, { assigneeId: est1.id, deadline: iso(10) });
    const done = await request(http).patch(`/api/v1/tickets/${t.body.id}`).set(auth(tokens.manager))
      .send({ version: 1, status: 'DONE' });
    expect(done.status).toBe(200);
    expect(done.body.kpiAward).toEqual({ type: 'AUTO', points: 3, reason: 'ON_TARGET' });
    expect(done.body.completedAt).toBeTruthy();
    const entry = await prisma.kpiEntry.findFirst({ where: { ticketId: t.body.id, type: 'AUTO' } });
    expect(entry!.points).toBe(3);
    expect(entry!.userId).toBe(est1.id);
  });
  it('late completion charges the miss penalty (−2)', async () => {
    const t = await createTicket(tokens.admin, { assigneeId: est2.id, deadline: iso(-5), allowPast: true });
    const done = await request(http).patch(`/api/v1/tickets/${t.body.id}`).set(auth(tokens.manager))
      .send({ version: 1, status: 'DONE' });
    expect(done.body.kpiAward).toEqual({ type: 'AUTO', points: -2, reason: 'MISSED_DEADLINE' });
  });
  it('completion without assignee awards nothing', async () => {
    const t = await createTicket(tokens.admin, {});
    const done = await request(http).patch(`/api/v1/tickets/${t.body.id}`).set(auth(tokens.manager))
      .send({ version: 1, status: 'DONE' });
    expect(done.status).toBe(200);
    expect(done.body.kpiAward).toBeNull();
  });
  it('reopening reverses the award; re-completion re-awards fresh points', async () => {
    const t = await createTicket(tokens.admin, { assigneeId: est1.id, deadline: iso(10) });
    const id = t.body.id;
    await request(http).patch(`/api/v1/tickets/${id}`).set(auth(tokens.manager))
      .send({ version: 1, status: 'DONE' }).expect(200);
    const reopen = await request(http).patch(`/api/v1/tickets/${id}`).set(auth(tokens.manager))
      .send({ version: 2, status: 'IN_PROGRESS_TENDER' });
    expect(reopen.status).toBe(200);
    expect(reopen.body.kpiAward.type).toBe('REVERSAL');
    expect(reopen.body.kpiAward.points).toBe(-3);
    expect(reopen.body.completedAt).toBeNull();
    const redo = await request(http).patch(`/api/v1/tickets/${id}`).set(auth(tokens.manager))
      .send({ version: 3, status: 'DONE' });
    expect(redo.body.kpiAward).toEqual({ type: 'AUTO', points: 3, reason: 'ON_TARGET' });
    const net = await prisma.kpiEntry.aggregate({
      where: { OR: [{ ticketId: id }, { ticketNo: t.body.ticketNo }], type: { in: ['AUTO', 'REVERSAL'] } },
      _sum: { points: true },
    });
    expect(net._sum.points).toBe(3); // +3 −3 +3
  });
  it('parallel double-DONE cannot double-award (optimistic lock + unique index)', async () => {
    const t = await createTicket(tokens.admin, { assigneeId: est2.id, deadline: iso(10) });
    const id = t.body.id;
    const [a, b] = await Promise.all([
      request(http).patch(`/api/v1/tickets/${id}`).set(auth(tokens.manager)).send({ version: 1, status: 'DONE' }),
      request(http).patch(`/api/v1/tickets/${id}`).set(auth(tokens.admin)).send({ version: 1, status: 'DONE' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const autoCount = await prisma.kpiEntry.count({ where: { ticketId: id, type: 'AUTO' } });
    expect(autoCount).toBe(1);
  });
});

describe('F9 notes', () => {
  let ticketId = '';
  beforeAll(async () => {
    const t = await createTicket(tokens.admin, { assigneeId: est1.id });
    ticketId = t.body.id;
  });
  it('assigned estimator adds a note stamped with the current status', async () => {
    const res = await request(http).post(`/api/v1/tickets/${ticketId}/notes`).set(auth(tokens.est1))
      .send({ content: 'Waiting for vendor quote' });
    expect(res.status).toBe(201);
    expect(res.body.statusAtTime).toBe('NEW');
    expect(res.body.authorLabel).toBe('ALICE');
  });
  it('unrelated estimator cannot add a note', async () => {
    const res = await request(http).post(`/api/v1/tickets/${ticketId}/notes`).set(auth(tokens.est2))
      .send({ content: 'sneaky note' });
    expect(res.status).toBe(403);
  });
  it('notes appear newest-first in ticket detail with author info', async () => {
    await request(http).post(`/api/v1/tickets/${ticketId}/notes`).set(auth(tokens.manager))
      .send({ content: 'Second note' });
    const res = await request(http).get(`/api/v1/tickets/${ticketId}`).set(auth(tokens.manager));
    expect(res.body.notes.length).toBe(2);
    expect(res.body.notes[0].content).toBe('Second note');
  });
  it('oversized note content is rejected', async () => {
    const res = await request(http).post(`/api/v1/tickets/${ticketId}/notes`).set(auth(tokens.manager))
      .send({ content: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
  });
});

describe('F10 soft delete & restore', () => {
  it('admin soft-deletes; ticket vanishes from lists; manager restores', async () => {
    const t = await createTicket(tokens.admin, { name: 'Deletable mistake ticket' });
    const id = t.body.id;
    await request(http).delete(`/api/v1/tickets/${id}`).set(auth(tokens.admin)).expect(200);
    const gone = await request(http).get(`/api/v1/tickets/${id}`).set(auth(tokens.admin));
    expect(gone.status).toBe(404);
    const restored = await request(http).post(`/api/v1/tickets/${id}/restore`).set(auth(tokens.manager));
    expect(restored.status).toBe(200);
    const back = await request(http).get(`/api/v1/tickets/${id}`).set(auth(tokens.manager));
    expect(back.status).toBe(200);
    expect(back.body.ticketNo).toBe(t.body.ticketNo); // numbers never reused
  });
  it('estimators cannot delete; site admins can delete only NEW own-site tickets', async () => {
    const t = await createTicket(tokens.saA, {});
    const id = t.body.id;
    const est = await request(http).delete(`/api/v1/tickets/${id}`).set(auth(tokens.est1));
    expect(est.status).toBe(403);
    // move it past NEW, then site admin delete is blocked with guidance
    await request(http).patch(`/api/v1/tickets/${id}`).set(auth(tokens.manager))
      .send({ version: 1, status: 'IN_PROGRESS_ESTIMATION' }).expect(200);
    const blocked = await request(http).delete(`/api/v1/tickets/${id}`).set(auth(tokens.saA));
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toMatch(/started/i);
    // a fresh NEW one deletes fine
    const t2 = await createTicket(tokens.saA, {});
    const ok = await request(http).delete(`/api/v1/tickets/${t2.body.id}`).set(auth(tokens.saA));
    expect(ok.status).toBe(200);
  });
});

describe('F6 dashboard stats', () => {
  it('stats reconcile with the ticket list', async () => {
    const [stats, list] = await Promise.all([
      request(http).get('/api/v1/tickets/stats').set(auth(tokens.manager)),
      request(http).get('/api/v1/tickets?pageSize=100').set(auth(tokens.manager)),
    ]);
    expect(stats.status).toBe(200);
    expect(stats.body.total).toBe(list.body.total);
    const byStatusSum = Object.values(stats.body.byStatus as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(byStatusSum).toBe(stats.body.total);
    expect(stats.body.workload.some((w: any) => w.fullName === 'ALICE')).toBe(true);
  });
  it('site admin stats are scoped to their site', async () => {
    const res = await request(http).get('/api/v1/tickets/stats').set(auth(tokens.saA));
    const list = await request(http).get('/api/v1/tickets?pageSize=100').set(auth(tokens.saA));
    expect(res.body.total).toBe(list.body.total);
  });
});

describe('F14/F15 KPI administration & member view', () => {
  it('settings: estimator reads, only manager writes', async () => {
    const read = await request(http).get('/api/v1/kpi/settings').set(auth(tokens.est1));
    expect(read.status).toBe(200);
    expect(read.body.pointOnTarget).toBe(3);
    const deny = await request(http).put('/api/v1/kpi/settings').set(auth(tokens.admin))
      .send({ pointOpening: 10, pointOnTarget: 5, pointMissTarget: -3 });
    expect(deny.status).toBe(403);
    const ok = await request(http).put('/api/v1/kpi/settings').set(auth(tokens.manager))
      .send({ pointOpening: 10, pointOnTarget: 5, pointMissTarget: -3 });
    expect(ok.status).toBe(200);
    // restore for other tests
    await request(http).put('/api/v1/kpi/settings').set(auth(tokens.manager))
      .send({ pointOpening: 10, pointOnTarget: 3, pointMissTarget: -2 });
  });
  it('opening points are upserted, never duplicated', async () => {
    const now = new Date();
    const y = now.getFullYear(); const m = now.getMonth() + 1;
    const dto = { year: y, month: m, items: [{ userId: est1.id, points: 10 }, { userId: est2.id, points: 8 }] };
    await request(http).post('/api/v1/kpi/opening').set(auth(tokens.manager)).send(dto).expect(200);
    await request(http).post('/api/v1/kpi/opening').set(auth(tokens.manager))
      .send({ ...dto, items: [{ userId: est1.id, points: 12 }] }).expect(200);
    const count = await prisma.kpiEntry.count({ where: { userId: est1.id, year: y, month: m, type: 'OPENING' } });
    expect(count).toBe(1);
    const entry = await prisma.kpiEntry.findFirst({ where: { userId: est1.id, year: y, month: m, type: 'OPENING' } });
    expect(entry!.points).toBe(12);
  });
  it('manual bonus requires description and non-zero points', async () => {
    const now = new Date();
    const zero = await request(http).post('/api/v1/kpi/entries').set(auth(tokens.manager))
      .send({ userId: est1.id, year: now.getFullYear(), month: now.getMonth() + 1, points: 0, description: 'nothing' });
    expect(zero.status).toBe(400);
    const ok = await request(http).post('/api/v1/kpi/entries').set(auth(tokens.manager))
      .send({ userId: est1.id, year: now.getFullYear(), month: now.getMonth() + 1, points: 5, description: 'Exceptional tender work' });
    expect(ok.status).toBe(201);
    expect(ok.body.type).toBe('MANUAL');
  });
  it('summary aggregates breakdown per member and sorts leaders first', async () => {
    const now = new Date();
    const res = await request(http).get(`/api/v1/kpi/summary?year=${now.getFullYear()}&month=${now.getMonth() + 1}`)
      .set(auth(tokens.manager));
    expect(res.status).toBe(200);
    const alice = res.body.members.find((mm: any) => mm.fullName === 'ALICE');
    expect(alice.breakdown.opening).toBe(12);
    expect(alice.breakdown.manual).toBe(5);
    expect(res.body.monthStrip).toHaveLength(12);
    for (let i = 1; i < res.body.members.length; i++) {
      expect(res.body.members[i - 1].total).toBeGreaterThanOrEqual(res.body.members[i].total);
    }
  });
  it('estimators see only their own KPI; admins have no KPI access', async () => {
    const now = new Date();
    const own = await request(http).get(`/api/v1/kpi/summary?year=${now.getFullYear()}&month=${now.getMonth() + 1}`)
      .set(auth(tokens.est1));
    expect(own.status).toBe(200);
    expect(own.body.members).toHaveLength(1);
    expect(own.body.members[0].id).toBe(est1.id);
    const foreign = await request(http).get(`/api/v1/kpi/entries?year=${now.getFullYear()}&userId=${est2.id}`)
      .set(auth(tokens.est1));
    expect(foreign.status).toBe(403);
    const adminDeny = await request(http).get(`/api/v1/kpi/summary?year=${now.getFullYear()}`)
      .set(auth(tokens.admin));
    expect(adminDeny.status).toBe(403);
  });
  it('CSV export is manager-only and well-formed', async () => {
    const y = new Date().getFullYear();
    const deny = await request(http).get(`/api/v1/kpi/export?year=${y}`).set(auth(tokens.est1));
    expect(deny.status).toBe(403);
    const res = await request(http).get(`/api/v1/kpi/export?year=${y}`).set(auth(tokens.manager));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.split('\n')[0]).toBe('member,year,month,type,points,description,ticket_no,created_by,created_at');
    expect(res.text.split('\n').length).toBeGreaterThan(3);
  });
});

describe('F16 sites & workspace administration', () => {
  it('site CRUD with duplicate-name protection', async () => {
    const created = await request(http).post('/api/v1/sites').set(auth(tokens.manager))
      .send({ name: 'Site C', color: 5 });
    expect(created.status).toBe(201);
    const dupe = await request(http).post('/api/v1/sites').set(auth(tokens.manager)).send({ name: 'Site C' });
    expect(dupe.status).toBe(409);
    const patched = await request(http).patch(`/api/v1/sites/${created.body.id}`).set(auth(tokens.manager))
      .send({ name: 'Site C Renamed' });
    expect(patched.status).toBe(200);
    const deleted = await request(http).delete(`/api/v1/sites/${created.body.id}`).set(auth(tokens.manager));
    expect(deleted.status).toBe(200);
  });
  it('deleting a site with active tickets is blocked with 409', async () => {
    const res = await request(http).delete(`/api/v1/sites/${siteA.id}`).set(auth(tokens.manager));
    expect(res.status).toBe(409);
  });
  it('workspace identity updates are manager-only and audited', async () => {
    const deny = await request(http).patch('/api/v1/workspace').set(auth(tokens.admin)).send({ company: 'Hacked' });
    expect(deny.status).toBe(403);
    const ok = await request(http).patch('/api/v1/workspace').set(auth(tokens.manager))
      .send({ company: 'Test Co Renamed', subtitle: 'QA Division' });
    expect(ok.status).toBe(200);
    expect(ok.body.company).toBe('Test Co Renamed');
  });
});

describe('F18 Roles & permissions administration (Settings → Roles)', () => {
  const putRole = (role: string, body: any) =>
    request(http).put(`/api/v1/roles/${role}`).set(auth(tokens.manager)).send(body);
  const resetRole = (role: string) =>
    request(http).put(`/api/v1/roles/${role}/reset`).set(auth(tokens.manager)).send({});

  afterAll(async () => {
    for (const r of ['ADMIN', 'SITE_ADMIN', 'ESTIMATOR']) await resetRole(r);
  });

  it('every user can read their own effective permissions (/roles/me)', async () => {
    const res = await request(http).get('/api/v1/roles/me').set(auth(tokens.est1));
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('ESTIMATOR');
    expect(res.body.locked).toBe(false);
    expect(res.body.ticketScope).toBe('ALL');
    expect(res.body.pages.board.view).toBe(true);
    expect(res.body.pages.kpiMe.view).toBe(true);
    expect(res.body.pages.kpi.view).toBe(false);
    expect(res.body.pages.tickets.create).toBe(false);
  });
  it('only roles with stRoles.view can list configs; manager row is locked', async () => {
    const deny = await request(http).get('/api/v1/roles').set(auth(tokens.admin));
    expect(deny.status).toBe(403);
    const res = await request(http).get('/api/v1/roles').set(auth(tokens.manager));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    const mgr = res.body.find((r: any) => r.role === 'MANAGER');
    expect(mgr.locked).toBe(true);
    expect(mgr.pages.stRoles.edit).toBe(true);
  });
  // AR-06: restore is a write. It used to be gated on stAudit.view, so granting a
  // compliance-style role sight of the audit trail also handed it the power to bring
  // deleted tickets back. Restore now needs the same permission as deleting.
  it('audit visibility alone does not grant the power to restore deleted tickets', async () => {
    const t = await createTicket(tokens.admin, { name: 'Restore permission probe' });
    const id = t.body.id;
    await request(http).delete(`/api/v1/tickets/${id}`).set(auth(tokens.admin)).expect(200);

    await putRole('ESTIMATOR', {
      pages: { stAudit: { view: true }, tickets: { delete: false } },
    }).expect(200);
    const denied = await request(http).post(`/api/v1/tickets/${id}/restore`).set(auth(tokens.est1));
    expect(denied.status).toBe(403);

    // and the audit trail itself is still readable, so the permission still means something
    const audit = await request(http).get('/api/v1/audit').set(auth(tokens.est1));
    expect(audit.status).toBe(200);

    await resetRole('ESTIMATOR');
    await request(http).post(`/api/v1/tickets/${id}/restore`).set(auth(tokens.manager)).expect(200);
  });

  it('the manager role cannot be modified; non-managers cannot modify any role', async () => {
    const locked = await putRole('MANAGER', { ticketScope: 'OWN' });
    expect(locked.status).toBe(400);
    const deny = await request(http).put('/api/v1/roles/ESTIMATOR').set(auth(tokens.admin))
      .send({ ticketScope: 'OWN' });
    expect(deny.status).toBe(403);
  });
  it('ticketScope OWN restricts estimators to tickets assigned to or created by them', async () => {
    const foreign = await createTicket(tokens.admin, { assigneeId: est2.id, name: 'Foreign scope probe' });
    await putRole('ESTIMATOR', { ticketScope: 'OWN' }).expect(200);
    const list = await request(http).get('/api/v1/tickets?pageSize=100').set(auth(tokens.est1));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.body.items.every((t: any) =>
      t.assigneeId === est1.id || t.submittedById === est1.id)).toBe(true);
    const detail = await request(http).get(`/api/v1/tickets/${foreign.body.id}`).set(auth(tokens.est1));
    expect(detail.status).toBe(404); // out of scope: hidden, no existence leak
    await resetRole('ESTIMATOR').expect(200);
    const again = await request(http).get(`/api/v1/tickets/${foreign.body.id}`).set(auth(tokens.est1));
    expect(again.status).toBe(200);
  });
  it('revoking tickets.edit makes the role read-only even on own tickets', async () => {
    const t = await createTicket(tokens.admin, { assigneeId: est1.id });
    await putRole('ESTIMATOR', { pages: { tickets: { edit: false } } }).expect(200);
    const detail = await request(http).get(`/api/v1/tickets/${t.body.id}`).set(auth(tokens.est1));
    expect(detail.body.permissions.editableFields).toEqual([]);
    const patch = await request(http).patch(`/api/v1/tickets/${t.body.id}`).set(auth(tokens.est1))
      .send({ version: 1, status: 'IN_PROGRESS_ESTIMATION' });
    expect(patch.status).toBe(403);
    const note = await request(http).post(`/api/v1/tickets/${t.body.id}/notes`).set(auth(tokens.est1))
      .send({ content: 'should be blocked' });
    expect(note.status).toBe(403);
    await resetRole('ESTIMATOR').expect(200);
    const patch2 = await request(http).patch(`/api/v1/tickets/${t.body.id}`).set(auth(tokens.est1))
      .send({ version: 1, status: 'IN_PROGRESS_ESTIMATION' });
    expect(patch2.status).toBe(200);
  });
  it('granting tickets.create lets estimators submit tickets', async () => {
    const before = await createTicket(tokens.est1);
    expect(before.status).toBe(403);
    await putRole('ESTIMATOR', { pages: { tickets: { create: true } } }).expect(200);
    const after = await createTicket(tokens.est1, { name: 'Estimator-created ticket' });
    expect(after.status).toBe(201);
    expect(after.body.submittedById).toBe(est1.id);
    await resetRole('ESTIMATOR').expect(200);
  });
  it('granting kpi.view gives admins the team KPI dashboard', async () => {
    const y = new Date().getFullYear();
    const before = await request(http).get(`/api/v1/kpi/summary?year=${y}`).set(auth(tokens.admin));
    expect(before.status).toBe(403);
    await putRole('ADMIN', { pages: { kpi: { view: true } } }).expect(200);
    const after = await request(http).get(`/api/v1/kpi/summary?year=${y}`).set(auth(tokens.admin));
    expect(after.status).toBe(200);
    expect(after.body.members.length).toBeGreaterThan(1);
    await resetRole('ADMIN').expect(200);
  });
  it('revoking tickets.delete blocks deletion for that role', async () => {
    const t = await createTicket(tokens.admin, {});
    await putRole('ADMIN', { pages: { tickets: { delete: false } } }).expect(200);
    const res = await request(http).delete(`/api/v1/tickets/${t.body.id}`).set(auth(tokens.admin));
    expect(res.status).toBe(403);
    await resetRole('ADMIN').expect(200);
    const ok = await request(http).delete(`/api/v1/tickets/${t.body.id}`).set(auth(tokens.admin));
    expect(ok.status).toBe(200);
  });
  it('unknown resources/actions in the payload are ignored (sanitised), and changes are audited', async () => {
    const res = await putRole('ESTIMATOR', {
      ticketScope: 'ALL',
      pages: { hackyResource: { delete: true }, tickets: { explode: true, edit: true } },
    });
    expect(res.status).toBe(200);
    expect(res.body.pages.hackyResource).toBeUndefined();
    expect((res.body.pages.tickets as any).explode).toBeUndefined();
    const audit = await request(http).get('/api/v1/audit?entityType=role_config').set(auth(tokens.manager));
    expect(audit.body.total).toBeGreaterThan(0);
  });
});

describe('F19 account activation & self-service password reset', () => {
  const PW_NEW = 'BrandNew#2026pass';
  let inviteId = '';
  let inviteLink = '';
  const tokenOf = (link: string) => new URL(link).searchParams.get('token')!;

  it('a new account is created pending, with an activation link and no usable password', async () => {
    const res = await request(http).post('/api/v1/users').set(auth(tokens.manager)).send({
      email: 'erin@test.local', fullName: 'Erin Invite', role: 'ESTIMATOR',
    });
    expect(res.status).toBe(201);
    expect(res.body.activatedAt).toBeNull();
    expect(res.body.activation.link).toContain('/activate?token=');
    expect(res.body.tempPassword).toBeUndefined();
    inviteId = res.body.id;
    inviteLink = res.body.activation.link;
    const row = await prisma.authToken.findFirst({ where: { userId: inviteId, type: 'ACTIVATION' } });
    expect(row).toBeTruthy();
    expect(row!.tokenHash).not.toBe(tokenOf(inviteLink));
  });

  // AR-05: a pending account used to answer 403 AccountNotActivated, which confirmed to an
  // unauthenticated caller that the address held an account — and that it was new enough to
  // be worth an activation-themed phishing email. All three outcomes now look identical.
  it('a pending account cannot log in and is indistinguishable from an unknown address', async () => {
    const pending = await request(http).post('/api/v1/auth/login')
      .send({ email: 'erin@test.local', password: PW_NEW });
    const unknown = await request(http).post('/api/v1/auth/login')
      .send({ email: 'no.such.person@test.local', password: PW_NEW });
    const wrongPw = await request(http).post('/api/v1/auth/login')
      .send({ email: 'alice@test.local', password: 'definitely-not-the-password' });

    expect(pending.status).toBe(401);
    expect(pending.body).toEqual(unknown.body);
    expect(pending.body).toEqual(wrongPw.body);
    expect(pending.body.message).toBe('Invalid email or password');
  });

  it('the activation link can be inspected before use', async () => {
    const res = await request(http).get('/api/v1/auth/activate/' + tokenOf(inviteLink));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, email: 'erin@test.local', fullName: 'Erin Invite' });
  });

  it('a weak password is rejected and the link stays usable', async () => {
    const weak = await request(http).post('/api/v1/auth/activate')
      .send({ token: tokenOf(inviteLink), newPassword: 'short' });
    expect(weak.status).toBe(400);
    const stillValid = await request(http).get('/api/v1/auth/activate/' + tokenOf(inviteLink));
    expect(stillValid.status).toBe(200);
  });

  it('activation sets the password, activates the account and enables login', async () => {
    const res = await request(http).post('/api/v1/auth/activate')
      .send({ token: tokenOf(inviteLink), newPassword: PW_NEW });
    expect(res.status).toBe(200);
    const login = await request(http).post('/api/v1/auth/login')
      .send({ email: 'erin@test.local', password: PW_NEW });
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(false);
  });

  it('an activation link is single-use', async () => {
    const again = await request(http).post('/api/v1/auth/activate')
      .send({ token: tokenOf(inviteLink), newPassword: 'AnotherPass#99' });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('TokenUsed');
  });

  it('resending an invitation supersedes the previous link', async () => {
    const pending = await request(http).post('/api/v1/users').set(auth(tokens.manager))
      .send({ email: 'frank@test.local', fullName: 'Frank Pending', role: 'ESTIMATOR' });
    const first = tokenOf(pending.body.activation.link);
    const resend = await request(http).post('/api/v1/users/' + pending.body.id + '/resend-activation')
      .set(auth(tokens.manager));
    expect(resend.status).toBe(200);
    const second = tokenOf(resend.body.link);
    expect(second).not.toBe(first);
    expect((await request(http).get('/api/v1/auth/activate/' + first)).status).toBe(400);
    expect((await request(http).get('/api/v1/auth/activate/' + second)).status).toBe(200);
  });

  it('resend-activation is refused once the account is activated', async () => {
    const res = await request(http).post('/api/v1/users/' + inviteId + '/resend-activation').set(auth(tokens.manager));
    expect(res.status).toBe(400);
  });

  it('forgot-password answers identically for known and unknown addresses', async () => {
    const known = await request(http).post('/api/v1/auth/forgot-password').send({ email: mail('alice') });
    const unknown = await request(http).post('/api/v1/auth/forgot-password').send({ email: 'nobody@test.local' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    const issued = await prisma.authToken.count({ where: { userId: est1.id, type: 'PASSWORD_RESET' } });
    expect(issued).toBe(1);
  });

  it('a reset link sets a new password and kills existing sessions', async () => {
    const agent = request.agent(http);
    await agent.post('/api/v1/auth/login').send({ email: mail('alice'), password: PW });
    const fresh = await request(http).post('/api/v1/users/' + est1.id + '/reset-password').set(auth(tokens.manager));
    expect(fresh.body.kind).toBe('PASSWORD_RESET');
    const res = await request(http).post('/api/v1/auth/reset-password')
      .send({ token: tokenOf(fresh.body.link), newPassword: 'AliceReset#2026' });
    expect(res.status).toBe(200);
    expect((await request(http).post('/api/v1/auth/login').send({ email: mail('alice'), password: PW })).status).toBe(401);
    const relogin = await request(http).post('/api/v1/auth/login')
      .send({ email: mail('alice'), password: 'AliceReset#2026' });
    expect(relogin.status).toBe(200);
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(401);
    tokens.est1 = relogin.body.accessToken;
  });

  it('a reset link is single-use and an unknown token is rejected', async () => {
    const issued = await request(http).post('/api/v1/users/' + est2.id + '/reset-password').set(auth(tokens.manager));
    const t = tokenOf(issued.body.link);
    expect((await request(http).post('/api/v1/auth/reset-password')
      .send({ token: t, newPassword: 'BobReset#2026a' })).status).toBe(200);
    const reuse = await request(http).post('/api/v1/auth/reset-password')
      .send({ token: t, newPassword: 'BobReset#2026b' });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe('TokenUsed');
    const bogus = await request(http).post('/api/v1/auth/reset-password')
      .send({ token: 'f'.repeat(64), newPassword: 'Whatever#2026' });
    expect(bogus.status).toBe(400);
    const r = await request(http).post('/api/v1/auth/login').send({ email: mail('bob'), password: 'BobReset#2026a' });
    tokens.est2 = r.body.accessToken;
  });

  it('an expired link is refused', async () => {
    const issued = await request(http).post('/api/v1/users/' + inviteId + '/reset-password').set(auth(tokens.manager));
    await prisma.authToken.updateMany({
      where: { userId: inviteId, type: 'PASSWORD_RESET', usedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await request(http).post('/api/v1/auth/reset-password')
      .send({ token: tokenOf(issued.body.link), newPassword: 'Expired#2026pw' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('TokenExpired');
  });

  it('only roles with stUsers.edit can send links', async () => {
    const res = await request(http).post('/api/v1/users/' + est1.id + '/reset-password').set(auth(tokens.admin));
    expect(res.status).toBe(403);
  });

  // Placed last: resending supersedes the outstanding activation token, so running this
  // earlier would invalidate the link the tests above still use.
  it('an invited user can still recover: forgot-password resends the activation link', async () => {
    const res = await request(http).post('/api/v1/auth/forgot-password')
      .send({ email: 'erin@test.local' });
    expect(res.status).toBe(200);
    // Same neutral answer an unknown address gets, so this path leaks nothing either.
    const unknown = await request(http).post('/api/v1/auth/forgot-password')
      .send({ email: 'no.such.person@test.local' });
    expect(res.body).toEqual(unknown.body);
  });
});

describe('Audit trail', () => {
  it('mutations are recorded and only managers can read the trail', async () => {
    const deny = await request(http).get('/api/v1/audit').set(auth(tokens.admin));
    expect(deny.status).toBe(403);
    const res = await request(http).get('/api/v1/audit?entityType=ticket').set(auth(tokens.manager));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    const actions = res.body.items.map((i: any) => i.action);
    expect(actions).toContain('create');
    expect(actions.some((a: string) => ['update', 'delete', 'restore'].includes(a))).toBe(true);
    const withActor = res.body.items.find((i: any) => i.actor);
    expect(withActor.actor.fullName).toBeTruthy();
  });
});

// ── AR-08 ────────────────────────────────────────────────────────────────────
describe('AR-08 token forgery is refused regardless of the algorithm claimed', () => {
  const { createHmac } = require('crypto');
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (header: any, payload: any, secret: string | null) => {
    const body = `${b64(header)}.${b64(payload)}`;
    if (secret === null) return `${body}.`;
    return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
  };
  const claims = () => {
    const real = JSON.parse(Buffer.from(tokens.est1.split('.')[1], 'base64url').toString());
    return { ...real, role: 'MANAGER' };
  };
  const probe = (t: string) => request(http).get('/api/v1/roles').set(auth(t));

  it('rejects a token whose payload was edited but signature left alone', async () => {
    const [h, , sig] = tokens.est1.split('.');
    const res = await probe(`${h}.${b64(claims())}.${sig}`);
    expect(res.status).toBe(401);
  });

  it('rejects an unsigned "alg: none" token', async () => {
    const res = await probe(sign({ alg: 'none', typ: 'JWT' }, claims(), null));
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const res = await probe(sign({ alg: 'HS256', typ: 'JWT' }, claims(), 'not-the-real-secret'));
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the REFRESH secret rather than the access secret', async () => {
    const res = await probe(sign({ alg: 'HS256', typ: 'JWT' }, claims(), process.env.JWT_REFRESH_SECRET!));
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const res = await probe(sign(
      { alg: 'HS256', typ: 'JWT' },
      { ...claims(), iat: past - 60, exp: past },
      process.env.JWT_ACCESS_SECRET!,
    ));
    expect(res.status).toBe(401);
  });
});

// ── AR-11 / AR-12 / AR-14 / AR-15 ────────────────────────────────────────────
describe('AR-11 user-controlled values cannot inject markup into email', () => {
  const { MailService } = require('../src/common/mail.service');

  it('escapes a display name containing HTML in the activation email', async () => {
    const svc = app.get(MailService);
    const spy = jest.spyOn(svc as any, 'send').mockResolvedValue({ delivered: true });
    await svc.activation(
      'victim@test.local',
      '<a href="https://evil.example">Click here to verify</a>',
      'Test Co', 'https://app.example/activate?token=abc', 72,
    );
    const html = spy.mock.calls[0][3] as string;
    expect(html).not.toContain('<a href="https://evil.example"');
    expect(html).toContain('&lt;a href=&quot;https://evil.example&quot;');
    spy.mockRestore();
  });

  it('strips CR/LF from the recipient and subject so headers cannot be injected', () => {
    const header = (MailService as any).header;
    expect(header('victim@test.local\r\nBcc: attacker@evil.example'))
      .toBe('victim@test.local Bcc: attacker@evil.example');
  });
});

describe('AR-12 the audit trail is tamper-evident', () => {
  const { AuditService } = require('../src/common/audit.service');

  it('chains records and detects an edited row', async () => {
    const audit = app.get(AuditService);
    await createTicket(tokens.admin, { name: 'Audit chain probe' });

    const clean = await audit.verifyChain(ws.id);
    expect(clean.ok).toBe(true);
    expect(clean.checked).toBeGreaterThan(0);

    // Rewrite history the way someone with database access would.
    const victim = await prisma.auditLog.findFirst({
      where: { workspaceId: ws.id, hash: { not: null } }, orderBy: { id: 'desc' },
    });
    const original = victim!.action;
    await prisma.auditLog.update({ where: { id: victim!.id }, data: { action: 'something-else' } });

    const broken = await audit.verifyChain(ws.id);
    expect(broken.ok).toBe(false);
    expect(broken.firstBreakAt).toBe(String(victim!.id));

    await prisma.auditLog.update({ where: { id: victim!.id }, data: { action: original } });
    expect((await audit.verifyChain(ws.id)).ok).toBe(true);
  });

  it('detects a deleted row', async () => {
    const audit = app.get(AuditService);
    const rows = await prisma.auditLog.findMany({
      where: { workspaceId: ws.id, hash: { not: null } }, orderBy: { id: 'desc' }, take: 2,
    });
    const removed = rows[1];
    const copy = { ...removed };
    await prisma.auditLog.delete({ where: { id: removed.id } });
    expect((await audit.verifyChain(ws.id)).ok).toBe(false);
    await prisma.auditLog.create({ data: { ...copy, id: undefined } as any });
  });
});

describe('AR-14 the test-email endpoint is not an open relay', () => {
  it('refuses to send to an address that is not the caller own', async () => {
    const res = await request(http).post('/api/v1/mail/test').set(auth(tokens.manager))
      .send({ to: 'someone@external.example' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('RecipientNotPermitted');
  });

  it('allows the caller own address', async () => {
    const res = await request(http).post('/api/v1/mail/test').set(auth(tokens.manager))
      .send({ to: mail('boss') });
    expect(res.status).toBe(200);
    expect(res.body.to).toBe(mail('boss'));
  });

  it('defaults to the caller own address when none is given', async () => {
    const res = await request(http).post('/api/v1/mail/test').set(auth(tokens.manager)).send({});
    expect(res.status).toBe(200);
    expect(res.body.to).toBe(mail('boss'));
  });
});

describe('AR-15 repeated failed logins lock the account', () => {
  const victim = 'lockme@test.local';
  let saved: string | undefined;

  beforeAll(async () => {
    saved = process.env.LOCKOUT_THRESHOLD;
    process.env.LOCKOUT_THRESHOLD = '3';
    process.env.LOCKOUT_MINUTES = '15';
    const argon2 = require('argon2');
    await prisma.user.create({
      data: {
        workspaceId: ws.id, username: 'lockme', email: victim, fullName: 'Lock Me',
        companyId: internalCo.id,
        role: 'ESTIMATOR', passwordHash: await argon2.hash(PW, { type: argon2.argon2id }),
        isActive: true, activatedAt: new Date(), mustChangePassword: false,
      },
    });
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.LOCKOUT_THRESHOLD; else process.env.LOCKOUT_THRESHOLD = saved;
  });

  it('locks after the threshold and then refuses even the CORRECT password', async () => {
    for (let i = 0; i < 3; i++) {
      const bad = await request(http).post('/api/v1/auth/login')
        .send({ email: victim, password: 'wrong-password' });
      expect(bad.status).toBe(401);
    }
    const row = await prisma.user.findUnique({ where: { email: victim } });
    expect(row!.lockedUntil).not.toBeNull();

    // The whole point: the right password does not help while the account is locked.
    const good = await request(http).post('/api/v1/auth/login').send({ email: victim, password: PW });
    expect(good.status).toBe(401);
    // ...and the response is identical to a wrong password, so the lock is not an oracle.
    const unknown = await request(http).post('/api/v1/auth/login')
      .send({ email: 'nobody-at-all@test.local', password: PW });
    expect(good.body).toEqual(unknown.body);

    const events = await prisma.auditLog.findMany({
      where: { entityType: 'auth', actorId: row!.id }, select: { action: true },
    });
    expect(events.map((e) => e.action)).toContain('login-lockout');
  });

  it('a successful login clears the counter', async () => {
    await prisma.user.update({ where: { email: victim }, data: { lockedUntil: null, failedLoginCount: 2 } });
    const ok = await request(http).post('/api/v1/auth/login').send({ email: victim, password: PW });
    expect(ok.status).toBe(200);
    const row = await prisma.user.findUnique({ where: { email: victim } });
    expect(row!.failedLoginCount).toBe(0);
    expect(row!.lastLoginAt).not.toBeNull();
  });
});

// ── AR-07 ────────────────────────────────────────────────────────────────────
describe('AR-07 every route declares how it is authorised', () => {
  const { RoutePolicyService } = require('../src/common/route-policy');

  it('leaves no route undeclared', () => {
    const routes = app.get(RoutePolicyService).all();
    expect(routes.length).toBeGreaterThan(40);
    const undeclared = routes.filter((r: any) => !r.gate);
    if (undeclared.length) {
      // eslint-disable-next-line no-console
      console.log('undeclared:', undeclared.map((r: any) => `${r.method} ${r.path}`).join('\n'));
    }
    expect(undeclared).toHaveLength(0);
  });

  it('exposes a readable policy so the effective matrix can be reviewed', () => {
    const routes = app.get(RoutePolicyService).all();
    const byGate = routes.reduce((acc: any, r: any) => {
      const kind = r.gate.split(':')[0];
      acc[kind] = (acc[kind] || 0) + 1;
      return acc;
    }, {});
    // Public routes are the internet-facing attack surface; keep the number small and known.
    expect(byGate.public).toBeLessThanOrEqual(15);  // tripwire: the enumerated list below is authoritative
    expect(byGate.perm).toBeGreaterThan(15);
  });

  it('the public routes are exactly the ones we intend to expose unauthenticated', () => {
    const routes = app.get(RoutePolicyService).all();
    const publicPaths = routes.filter((r: any) => r.gate === 'public')
      .map((r: any) => `${r.method} ${r.path}`).sort();
    expect(publicPaths).toEqual([
      'GET /auth/activate/:token',
      'GET /auth/reset-password/:token',
      'GET /auth/sso/callback',
      'GET /auth/sso/config',
      'GET /auth/sso/health',
      'GET /auth/sso/start',
      'GET /health',
      'GET /ready',
      'GET /workspace',
      'POST /auth/activate',
      'POST /auth/forgot-password',
      'POST /auth/login',
      'POST /auth/mfa/verify',
      'POST /auth/refresh',
      'POST /auth/reset-password',
    ]);
  });
});

// ── AR-04 ────────────────────────────────────────────────────────────────────
describe('AR-04 TOTP implementation matches the RFC 6238 test vectors', () => {
  const totp = require('../src/auth/totp');
  // RFC 6238 Appendix B: secret "12345678901234567890" (ASCII), SHA-1, 8 digits.
  const SECRET = totp.base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  const VECTORS: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(VECTORS)('T=%i produces %s', (time, expected) => {
    expect(totp.generate(SECRET, { digits: 8, now: time })).toBe(expected);
  });

  it('round-trips base32 encoding', () => {
    const raw = Buffer.from('12345678901234567890', 'ascii');
    expect(totp.base32Decode(totp.base32Encode(raw)).equals(raw)).toBe(true);
  });

  it('accepts one step of clock drift either side but not two', () => {
    const now = 1700000000;
    const code = totp.generate(SECRET, { now });
    expect(totp.verify(code, SECRET, { now: now + 30 })).toBe(true);
    expect(totp.verify(code, SECRET, { now: now - 30 })).toBe(true);
    expect(totp.verify(code, SECRET, { now: now + 90 })).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    expect(totp.verify('', SECRET)).toBe(false);
    expect(totp.verify('abcdef', SECRET)).toBe(false);
    expect(totp.verify('12345', SECRET)).toBe(false);
  });
});

describe('AR-04 two-factor authentication end to end', () => {
  const totp = require('../src/auth/totp');
  const email = mail('boss');
  let secret = '';
  let backupCodes: string[] = [];
  let freshToken = '';

  const code = () => totp.generate(secret);

  it('enrolment: setup returns a secret and QR, and nothing is enabled yet', async () => {
    const res = await request(http).post('/api/v1/auth/mfa/setup').set(auth(tokens.manager)).send({});
    expect(res.status).toBe(200);
    expect(res.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.body.qr).toMatch(/^data:image\/png;base64,/);
    expect(res.body.uri).toContain('otpauth://totp/');
    secret = res.body.secret;

    const status = await request(http).get('/api/v1/auth/mfa/status').set(auth(tokens.manager));
    expect(status.body.enabled).toBe(false);
  });

  it('a wrong code does not enable it', async () => {
    const res = await request(http).post('/api/v1/auth/mfa/enable')
      .set(auth(tokens.manager)).send({ code: '000000' });
    expect(res.status).toBe(400);
    const status = await request(http).get('/api/v1/auth/mfa/status').set(auth(tokens.manager));
    expect(status.body.enabled).toBe(false);
  });

  it('a correct code enables it and returns single-use backup codes', async () => {
    const res = await request(http).post('/api/v1/auth/mfa/enable')
      .set(auth(tokens.manager)).send({ code: code() });
    expect(res.status).toBe(200);
    expect(res.body.backupCodes).toHaveLength(10);
    expect(res.body.accessToken).toBeTruthy();
    backupCodes = res.body.backupCodes;
    freshToken = res.body.accessToken;

    // stored hashed, never in the clear
    const row = await prisma.user.findUnique({ where: { email } });
    expect(row!.mfaBackupCodes).toHaveLength(10);
    expect(row!.mfaBackupCodes).not.toContain(backupCodes[0]);
    // and the secret itself is encrypted at rest, not the base32 value
    expect(row!.mfaSecret).not.toContain(secret);
    expect(row!.mfaSecret!.split('.')).toHaveLength(3);
  });

  it('the correct password alone no longer yields a session', async () => {
    const res = await request(http).post('/api/v1/auth/login').send({ email, password: PW });
    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.accessToken).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('the challenge token cannot be used as an access token', async () => {
    const login = await request(http).post('/api/v1/auth/login').send({ email, password: PW });
    const res = await request(http).get('/api/v1/roles').set(auth(login.body.mfaToken));
    expect(res.status).toBe(401);
  });

  it('a wrong second factor is refused', async () => {
    const login = await request(http).post('/api/v1/auth/login').send({ email, password: PW });
    const res = await request(http).post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: login.body.mfaToken, code: '000000' });
    expect(res.status).toBe(401);
  });

  it('a correct second factor completes the login', async () => {
    const login = await request(http).post('/api/v1/auth/login').send({ email, password: PW });
    const res = await request(http).post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: login.body.mfaToken, code: code() });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(String(res.headers['set-cookie'])).toContain('engpro_rt');
    tokens.manager = res.body.accessToken;
  });

  it('a backup code works once and then is consumed', async () => {
    const one = backupCodes[0];
    const login1 = await request(http).post('/api/v1/auth/login').send({ email, password: PW });
    const first = await request(http).post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: login1.body.mfaToken, code: one });
    expect(first.status).toBe(200);

    const login2 = await request(http).post('/api/v1/auth/login').send({ email, password: PW });
    const second = await request(http).post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: login2.body.mfaToken, code: one });
    expect(second.status).toBe(401);

    const row = await prisma.user.findUnique({ where: { email } });
    expect(row!.mfaBackupCodes).toHaveLength(9);
  });

  it('an expired or forged challenge is refused', async () => {
    const res = await request(http).post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: tokens.est1, code: code() });   // a real access token, wrong purpose
    expect(res.status).toBe(401);
  });

  it('disabling requires the password and then restores password-only login', async () => {
    const wrong = await request(http).post('/api/v1/auth/mfa/disable')
      .set(auth(tokens.manager)).send({ password: 'not-my-password' });
    expect(wrong.status).toBe(401);

    const ok = await request(http).post('/api/v1/auth/mfa/disable')
      .set(auth(tokens.manager)).send({ password: PW });
    expect(ok.status).toBe(200);

    const login = await request(http).post('/api/v1/auth/login').send({ email, password: PW });
    expect(login.body.accessToken).toBeTruthy();
    tokens.manager = login.body.accessToken;
  });
});

describe('AR-04 MFA_POLICY=required forces privileged roles to enrol', () => {
  let saved: string | undefined;
  beforeAll(() => { saved = process.env.MFA_POLICY; process.env.MFA_POLICY = 'required'; });
  afterAll(() => {
    if (saved === undefined) delete process.env.MFA_POLICY; else process.env.MFA_POLICY = saved;
  });

  it('blocks a privileged role that has not enrolled', async () => {
    const res = await request(http).get('/api/v1/tickets').set(auth(tokens.manager));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MfaEnrollmentRequired');
  });

  it('still allows the routes needed to enrol, and to sign out', async () => {
    for (const path of ['/api/v1/auth/mfa/status', '/api/v1/auth/me']) {
      expect((await request(http).get(path).set(auth(tokens.manager))).status).toBe(200);
    }
    expect((await request(http).post('/api/v1/auth/mfa/setup').set(auth(tokens.manager)).send({})).status).toBe(200);
  });

  it('does not block roles outside MFA_REQUIRED_ROLES', async () => {
    const res = await request(http).get('/api/v1/tickets').set(auth(tokens.est1));
    expect(res.status).toBe(200);
  });

  it('reports the obligation so the UI can prompt', async () => {
    const res = await request(http).get('/api/v1/auth/mfa/status').set(auth(tokens.manager));
    expect(res.body).toMatchObject({ required: true, policy: 'required', enabled: false });
  });

  it('a required role cannot turn MFA off again', async () => {
    const totp = require('../src/auth/totp');
    const setup = await request(http).post('/api/v1/auth/mfa/setup').set(auth(tokens.manager)).send({});
    const enabled = await request(http).post('/api/v1/auth/mfa/enable')
      .set(auth(tokens.manager)).send({ code: totp.generate(setup.body.secret) });
    expect(enabled.status).toBe(200);
    const token = enabled.body.accessToken;

    // enrolled: the application is usable again
    expect((await request(http).get('/api/v1/tickets').set(auth(token))).status).toBe(200);

    const off = await request(http).post('/api/v1/auth/mfa/disable').set(auth(token)).send({ password: PW });
    expect(off.status).toBe(400);

    // clean up so later suites are unaffected
    await prisma.user.update({
      where: { email: mail('boss') },
      data: { mfaEnabledAt: null, mfaSecret: null, mfaBackupCodes: [] },
    });
    tokens.manager = (await request(http).post('/api/v1/auth/login')
      .send({ email: mail('boss'), password: PW })).body.accessToken;
  });
});
