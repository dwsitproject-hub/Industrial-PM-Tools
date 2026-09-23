import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma.service';
import { MailService, MailResult } from '../common/mail.service';

export type AuthTokenType = 'ACTIVATION' | 'PASSWORD_RESET';

export const ACTIVATION_TTL_HOURS = () => parseInt(process.env.ACTIVATION_TTL_HOURS || '72', 10);
export const RESET_TTL_MINUTES = () => parseInt(process.env.RESET_TTL_MINUTES || '60', 10);

/** Single-use, hashed-at-rest links for activation and password reset. */
@Injectable()
export class TokensService {
  constructor(private prisma: PrismaService, private mail: MailService) {}

  static hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private baseUrl(): string {
    return (process.env.APP_BASE_URL || 'http://localhost:8090').replace(/\/+$/, '');
  }

  linkFor(type: AuthTokenType, raw: string): string {
    const path = type === 'ACTIVATION' ? '/activate' : '/reset-password';
    return `${this.baseUrl()}${path}?token=${raw}`;
  }

  /** Issues a fresh token and invalidates any outstanding one of the same type. */
  async issue(userId: string, type: AuthTokenType): Promise<{ raw: string; link: string; expiresAt: Date }> {
    const raw = randomBytes(32).toString('hex');
    const ttlMs = type === 'ACTIVATION'
      ? ACTIVATION_TTL_HOURS() * 3600_000
      : RESET_TTL_MINUTES() * 60_000;
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.prisma.$transaction([
      this.prisma.authToken.updateMany({
        where: { userId, type, usedAt: null },
        data: { usedAt: new Date() },          // supersede outstanding links
      }),
      this.prisma.authToken.create({
        data: { userId, type, tokenHash: TokensService.hash(raw), expiresAt },
      }),
    ]);
    return { raw, link: this.linkFor(type, raw), expiresAt };
  }

  /** Validates without consuming — powers the "is this link still good?" check on page load. */
  async peek(raw: string, type: AuthTokenType) {
    if (!raw || raw.length < 20) throw new BadRequestException({ error: 'InvalidToken', message: 'This link is not valid.' });
    const row = await this.prisma.authToken.findFirst({
      where: { tokenHash: TokensService.hash(raw), type },
      include: { user: { select: { id: true, email: true, fullName: true, isActive: true, deletedAt: true } } },
    });
    if (!row || !row.user || row.user.deletedAt) {
      throw new BadRequestException({ error: 'InvalidToken', message: 'This link is not valid.' });
    }
    if (row.usedAt) {
      throw new BadRequestException({ error: 'TokenUsed', message: 'This link has already been used. Request a new one.' });
    }
    if (row.expiresAt < new Date()) {
      throw new BadRequestException({ error: 'TokenExpired', message: 'This link has expired. Request a new one.' });
    }
    if (!row.user.isActive) {
      throw new BadRequestException({ error: 'AccountDisabled', message: 'This account is disabled. Contact your manager.' });
    }
    return row;
  }

  /** Validates and marks the token used in one step. */
  async consume(raw: string, type: AuthTokenType) {
    const row = await this.peek(raw, type);
    const claimed = await this.prisma.authToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw new BadRequestException({ error: 'TokenUsed', message: 'This link has already been used. Request a new one.' });
    }
    return row;
  }

  /** Fire-and-forget security notice; never blocks or fails a login attempt. */
  async notifyLockout(user: { email: string; fullName: string }, minutes: number, ip?: string | null) {
    return this.mail.lockoutNotice(user.email, user.fullName, minutes, ip ?? null);
  }

  async sendActivation(user: { id: string; email: string; fullName: string }, company: string): Promise<{ link: string; mail: MailResult }> {
    const { link } = await this.issue(user.id, 'ACTIVATION');
    const mail = await this.mail.activation(user.email, user.fullName, company, link, ACTIVATION_TTL_HOURS());
    return { link, mail };
  }

  async sendReset(user: { id: string; email: string; fullName: string }, company: string): Promise<{ link: string; mail: MailResult }> {
    const { link } = await this.issue(user.id, 'PASSWORD_RESET');
    const mail = await this.mail.passwordReset(user.email, user.fullName, company, link, RESET_TTL_MINUTES());
    return { link, mail };
  }
}
