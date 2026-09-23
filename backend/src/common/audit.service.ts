import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma.service';
import { jsonSafe } from './util';

export interface AuditInput {
  workspaceId: string;
  actorId?: string | null;
  entityType: string;
  entityId?: string | null;
  action: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/** Genesis value for the first record in a workspace's chain. */
const GENESIS = '0'.repeat(64);

@Injectable()
export class AuditService {
  private readonly logger = new Logger('AuditService');

  constructor(private prisma: PrismaService) {}

  /**
   * AR-12: every record carries the hash of the one before it, so deleting or editing an
   * entry breaks the chain from that point on. The audit trail is the primary evidence for
   * investigating insider misuse — including misuse by someone with database access — so it
   * has to be able to show that it has not been quietly edited.
   *
   * verifyChain() below re-walks the chain and reports the first break.
   */
  /**
   * PostgreSQL jsonb does not preserve key order, so hashing JSON.stringify() of a value
   * read back from the database would never match the hash computed on the way in. Sorting
   * keys recursively gives a form that survives the round trip.
   */
  private static canonical(value: unknown): string {
    const walk = (v: any): any => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(walk);
      return Object.keys(v).sort().reduce((acc: any, k) => { acc[k] = walk(v[k]); return acc; }, {});
    };
    return JSON.stringify(walk(value) ?? null);
  }

  static digest(row: {
    workspaceId: string; actorId: string | null; entityType: string; entityId: string | null;
    action: string; before: unknown; after: unknown; ip: string | null; createdAt: Date;
    prevHash: string;
  }): string {
    // Field-separated rather than JSON-stringified so a value containing the separator
    // cannot be arranged to look like a different set of fields.
    const parts = [
      row.prevHash, row.workspaceId, row.actorId ?? '', row.entityType, row.entityId ?? '',
      row.action, AuditService.canonical(row.before), AuditService.canonical(row.after),
      row.ip ?? '', row.createdAt.toISOString(),
    ];
    return createHash('sha256').update(parts.map((p) => `${p.length}:${p}`).join('|')).digest('hex');
  }

  /** Pass a transaction client to write inside a transaction; defaults to the root client. */
  async log(input: AuditInput, tx?: any): Promise<void> {
    const client = tx ?? this.prisma;
    const before = input.before === undefined ? null : jsonSafe(input.before);
    const after = input.after === undefined ? null : jsonSafe(input.after);

    try {
      // Serialise chain writes per workspace so two concurrent actions cannot both chain off
      // the same predecessor and leave an ambiguous trail. The lock is transaction-scoped;
      // when no transaction is supplied it covers this statement pair only.
      await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.workspaceId}))`;
    } catch {
      // A missing advisory lock must never cost us the audit record itself.
    }

    const prev = await client.auditLog.findFirst({
      where: { workspaceId: input.workspaceId },
      orderBy: { id: 'desc' },
      select: { hash: true },
    });
    const prevHash = prev?.hash || GENESIS;
    const createdAt = new Date();
    const hash = AuditService.digest({
      workspaceId: input.workspaceId,
      actorId: input.actorId ?? null,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      action: input.action,
      before, after,
      ip: input.ip ?? null,
      createdAt, prevHash,
    });

    await client.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorId: input.actorId ?? null,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        action: input.action,
        before: before === null ? undefined : before,
        after: after === null ? undefined : after,
        ip: input.ip ?? null,
        createdAt, hash, prevHash,
      },
    });
  }

  /**
   * Re-walks a workspace's chain and reports the first record whose stored hash does not
   * match its content and predecessor. Rows written before this migration have no hash and
   * are reported separately rather than counted as tampering.
   */
  async verifyChain(workspaceId: string, limit = 10000): Promise<{
    ok: boolean; checked: number; unchained: number; firstBreakAt: string | null;
  }> {
    const rows = await this.prisma.auditLog.findMany({
      where: { workspaceId },
      orderBy: { id: 'asc' },
      take: limit,
      select: {
        id: true, workspaceId: true, actorId: true, entityType: true, entityId: true,
        action: true, before: true, after: true, ip: true, createdAt: true,
        hash: true, prevHash: true,
      },
    });

    let expectedPrev = GENESIS;
    let unchained = 0;
    let checked = 0;
    for (const r of rows) {
      if (!r.hash) { unchained++; continue; }   // pre-migration record
      const computed = AuditService.digest({ ...r, prevHash: r.prevHash || GENESIS });
      if (computed !== r.hash || (r.prevHash || GENESIS) !== expectedPrev) {
        return { ok: false, checked, unchained, firstBreakAt: String(r.id) };
      }
      expectedPrev = r.hash;
      checked++;
    }
    return { ok: true, checked, unchained, firstBreakAt: null };
  }

  /**
   * Deletes records past the retention horizon. Runs only when AUDIT_RETENTION_DAYS is set,
   * because silently discarding evidence by default would be the wrong failure mode.
   */
  async prune(): Promise<number> {
    const days = parseInt(process.env.AUDIT_RETENTION_DAYS || '', 10);
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 86400_000);
    try {
      const { count } = await this.prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
      if (count > 0) this.logger.log(`Pruned ${count} audit record(s) older than ${days} days.`);
      return count;
    } catch (e: any) {
      // Expected once AR-16 is applied: the application role can append to the audit trail
      // but not delete from it, precisely so a compromised API cannot erase its own tracks.
      // Retention then belongs to scheduled maintenance — prisma/sql/prune-audit.sql.
      if (/permission denied/i.test(e?.message || '')) {
        this.logger.log(
          'Audit retention skipped: the application role cannot delete audit records (by design). ' +
          'Run prisma/sql/prune-audit.sql as the privileged account on a schedule instead.',
        );
        return 0;
      }
      throw e;
    }
  }
}
