import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { IsEmail, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { CurrentUser, JwtUser, RequirePerm } from './auth.types';
import { MailService } from './mail.service';

class TestMailDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'A valid email address is required' }) @MaxLength(200) to!: string;
}

/** Operator diagnostics for outbound email. Manager-only; never returns credentials. */
@Controller('mail')
export class MailController {
  constructor(private mail: MailService) {}

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

  /** Sends a real message so you can confirm delivery end to end. */
  @RequirePerm('stUsers', 'edit')
  @Post('test')
  @HttpCode(200)
  async test(@CurrentUser() user: JwtUser, @Body() dto: TestMailDto) {
    const stamp = new Date().toISOString();
    const result = await this.mail.send(
      dto.to,
      'EngPro test email',
      `This is a test message from EngPro, sent at ${stamp}.\n` +
      'If you received it, activation and password-reset emails will work too.\n',
      `<p>This is a test message from <strong>EngPro</strong>, sent at ${stamp}.</p>` +
      '<p>If you received it, activation and password-reset emails will work too.</p>',
    );
    return { to: dto.to, sent: result.delivered, reason: result.reason };
  }
}
