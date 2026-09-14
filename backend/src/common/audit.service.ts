import { Injectable } from '@nestjs/common';
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

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  /** Pass a transaction client to write inside a transaction; defaults to the root client. */
  async log(input: AuditInput, tx?: any): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorId: input.actorId ?? null,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        action: input.action,
        before: input.before === undefined ? undefined : jsonSafe(input.before),
        after: input.after === undefined ? undefined : jsonSafe(input.after),
        ip: input.ip ?? null,
      },
    });
  }
}
