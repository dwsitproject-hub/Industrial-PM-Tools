import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Req } from '@nestjs/common';
import { IsEmail, IsOptional, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { Request } from 'express';
import { CurrentUser, JwtUser, RequirePerm } from './auth.types';
import { MailService } from './mail.service';
import { AuditService } from './audit.service';
import { PrismaService } from '../prisma.service';
import { Heavy } from './throttle';

class TestMailDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'A valid email address is required' }) @MaxLength(200) to?: string;
}

/** Operator diagnostics for outbound email. Manager-only; never returns credentials. */
@Controller('mail')
export class MailController {
  constructor(
    private mail: MailService,
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /** Connects and authenticates without sending anything. */
  @RequirePerm('stUsers', 'edit')
  @Get('health')
  async health() {
    const result = await this.mail.verify();
    return {
      configured: this.mail.configured,
      host: process.env.SMTP_HOST || null,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : (process.env.SMTP_PORT === '465'),
      user: process.env.SMTP_USER || null,
      from: process.env.SMTP_FROM || process.env.MAIL_FROM || process.env.SMTP_USER || null,
      ok: result.delivered,
      reason: result.reason,
    };
  }

  /**
   * Sends a real message so you can confirm delivery end to end.
   *
   * AR-14: the recipient used to be free-form, which turned a compromised manager account
   * into a phishing platform sending from the corporate relay with EngPro branding — and
   * risked the relay's sending reputation. The message now goes to the caller's own address
   * unless the operator has explicitly allowlisted others in MAIL_TEST_ALLOWLIST, and every
   * use is audited.
   */
  @RequirePerm('stUsers', 'edit')
  @Heavy()
  @Post('test')
  @HttpCode(200)
  async test(@CurrentUser() user: JwtUser, @Body() dto: TestMailDto, @Req() req: Request) {
    const me = await this.prisma.user.findUnique({
      where: { id: user.sub }, select: { email: true },
    });
    const own = (me?.email || '').toLowerCase();
    const allowlist = (process.env.MAIL_TEST_ALLOWLIST || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

    const to = dto.to || own;
    if (!to) throw new ForbiddenException('Your account has no email address to send to.');
    if (to !== own && !allowlist.includes(to)) {
      throw new ForbiddenException({
        error: 'RecipientNotPermitted',
        message: 'Test email can only be sent to your own address. Add others to MAIL_TEST_ALLOWLIST if an operator needs them.',
      });
    }

    const stamp = new Date().toISOString();
    const result = await this.mail.send(
      to,
      'EngPro test email',
      `This is a test message from EngPro, sent at ${stamp}.\n` +
      'If you received it, activation and password-reset emails will work too.\n',
      `<p>This is a test message from <strong>EngPro</strong>, sent at ${stamp}.</p>` +
      '<p>If you received it, activation and password-reset emails will work too.</p>',
    );
    await this.audit.log({
      workspaceId: user.ws, actorId: user.sub, entityType: 'mail', entityId: user.sub,
      action: 'test-email', after: { to, delivered: result.delivered }, ip: req.ip,
    });
    return { to, sent: result.delivered, reason: result.reason };
  }
}
