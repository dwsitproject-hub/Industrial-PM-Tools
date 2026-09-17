import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

export interface MailResult {
  /** true when the message was handed to an SMTP server */
  delivered: boolean;
  /** why it was not delivered (shown to managers so they can fall back to sharing the link) */
  reason?: string;
}

/**
 * SMTP delivery via nodemailer.
 * When SMTP_HOST is not configured the service degrades to a log transport: the message is
 * written to the API log and `delivered:false` is returned, so the caller can surface the link
 * to the manager instead of silently doing nothing.
 */
@Injectable()
export class MailService {
  private readonly log = new Logger('MailService');
  private transporter: nodemailer.Transporter | null = null;

  private get from(): string {
    return process.env.MAIL_FROM || 'EngPro <no-reply@engpro.local>';
  }

  get configured(): boolean {
    return !!process.env.SMTP_HOST;
  }

  private getTransport(): nodemailer.Transporter | null {
    if (!this.configured) return null;
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
      });
    }
    return this.transporter;
  }

  async send(to: string, subject: string, text: string, html?: string): Promise<MailResult> {
    const transport = this.getTransport();
    if (!transport) {
      this.log.warn(
        `SMTP not configured (SMTP_HOST empty) — email NOT sent.\n` +
        `  to: ${to}\n  subject: ${subject}\n${text}`,
      );
      return { delivered: false, reason: 'SMTP is not configured on this server' };
    }
    try {
      await transport.sendMail({ from: this.from, to, subject, text, html: html ?? undefined });
      this.log.log(`Sent "${subject}" to ${to}`);
      return { delivered: true };
    } catch (e: any) {
      this.log.error(`Failed to send "${subject}" to ${to}: ${e?.message}`);
      return { delivered: false, reason: `SMTP error: ${e?.message ?? 'unknown'}` };
    }
  }

  // ── templates ─────────────────────────────────────────────────────
  private layout(title: string, intro: string, cta: string, link: string, footer: string): string {
    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#181816;line-height:1.55">
  <h2 style="font-size:17px;margin:0 0 12px">${title}</h2>
  <p style="margin:0 0 14px">${intro}</p>
  <p style="margin:0 0 18px">
    <a href="${link}" style="background:#181816;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${cta}</a>
  </p>
  <p style="margin:0 0 6px;color:#6B6A66;font-size:12px">Or paste this address into your browser:</p>
  <p style="margin:0 0 18px;font-size:12px;word-break:break-all"><a href="${link}">${link}</a></p>
  <p style="margin:0;color:#6B6A66;font-size:12px">${footer}</p>
</div>`;
  }

  activation(to: string, fullName: string, company: string, link: string, hours: number) {
    const subject = `Activate your ${company} account`;
    const text =
      `Hi ${fullName},\n\nAn account has been created for you on ${company} (EngPro).\n` +
      `Set your password to activate it:\n${link}\n\n` +
      `The link expires in ${hours} hours. If it expires, ask your manager to resend it.\n`;
    return this.send(to, subject, text,
      this.layout(
        `Activate your ${company} account`,
        `Hi ${fullName}, an account has been created for you. Choose a password to activate it.`,
        'Set my password', link,
        `This link expires in ${hours} hours. If it expires, ask your manager to send a new one. If you were not expecting this email, you can ignore it.`,
      ));
  }

  passwordReset(to: string, fullName: string, company: string, link: string, minutes: number) {
    const subject = `Reset your ${company} password`;
    const text =
      `Hi ${fullName},\n\nWe received a request to reset your ${company} (EngPro) password.\n` +
      `Choose a new one here:\n${link}\n\n` +
      `The link expires in ${minutes} minutes and can only be used once.\n` +
      `If you did not request this, you can ignore this email — your password stays unchanged.\n`;
    return this.send(to, subject, text,
      this.layout(
        `Reset your ${company} password`,
        `Hi ${fullName}, we received a request to reset your password.`,
        'Choose a new password', link,
        `This link expires in ${minutes} minutes and can only be used once. If you did not request it, ignore this email — your password stays unchanged.`,
      ));
  }
}
