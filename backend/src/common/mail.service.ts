import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

const NEWLINE = '\n';

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

  /** SMTP_FROM and MAIL_FROM are both accepted; falls back to the authenticated user. */
  private get from(): string {
    return process.env.SMTP_FROM || process.env.MAIL_FROM || process.env.SMTP_USER
      || 'EngPro <no-reply@engpro.local>';
  }

  /** SMTP_PASSWORD is the common spelling; SMTP_PASS is kept for older configs. */
  private get pass(): string | undefined {
    return process.env.SMTP_PASSWORD || process.env.SMTP_PASS || undefined;
  }

  get configured(): boolean {
    return !!process.env.SMTP_HOST;
  }

  private getTransport(): nodemailer.Transporter | null {
    if (!this.configured) return null;
    if (!this.transporter) {
      const port = parseInt(process.env.SMTP_PORT || '587', 10);
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        // 465 is implicit TLS; 587 starts plain and upgrades with STARTTLS
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: this.pass } : undefined,
        // set SMTP_REJECT_UNAUTHORIZED=false only for a self-signed relay certificate
        tls: { rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false' },
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
      });
      this.log.log(
        `SMTP transport: ${process.env.SMTP_HOST}:${port} secure=${process.env.SMTP_SECURE ?? (port === 465)} ` +
        `user=${process.env.SMTP_USER || '(none)'} from=${this.from}`,
      );
    }
    return this.transporter;
  }

  /** Opens a connection and authenticates without sending anything. */
  async verify(): Promise<MailResult> {
    const transport = this.getTransport();
    if (!transport) return { delivered: false, reason: 'SMTP is not configured (SMTP_HOST is empty)' };
    try {
      await transport.verify();
      return { delivered: true };
    } catch (e: any) {
      return { delivered: false, reason: `${e?.code ? e.code + ': ' : ''}${e?.message ?? 'unknown error'}` };
    }
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
      await transport.sendMail({
        from: this.from,
        to: MailService.header(to),
        subject: MailService.header(subject),
        text,
        html: html ?? undefined,
      });
      this.log.log(`Sent "${subject}" to ${to}`);
      return { delivered: true };
    } catch (e: any) {
      this.log.error(`Failed to send "${subject}" to ${to}: ${e?.code || ''} ${e?.message}`);
      return { delivered: false, reason: `SMTP ${e?.code || 'error'}: ${e?.message ?? 'unknown'}` };
    }
  }

  // ── templates ─────────────────────────────────────────────────────
  /**
   * AR-11: display names and the workspace company name are user-controlled and were being
   * interpolated straight into the HTML body. A crafted name could therefore inject markup —
   * including a competing link — into an activation email recipients have every reason to
   * trust. Everything that reaches the template is escaped here, at the single point where
   * text becomes HTML, rather than relying on each caller to remember.
   */
  private static esc(value: string): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Header values must not carry CR/LF, which would let a crafted name add headers. */
  private static header(value: string): string {
    return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  }

  private layout(title: string, intro: string, cta: string, link: string, footer: string): string {
    const e = MailService.esc;
    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#181816;line-height:1.55">
  <h2 style="font-size:17px;margin:0 0 12px">${e(title)}</h2>
  <p style="margin:0 0 14px">${e(intro)}</p>
  <p style="margin:0 0 18px">
    <a href="${e(link)}" style="background:#181816;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${e(cta)}</a>
  </p>
  <p style="margin:0 0 6px;color:#6B6A66;font-size:12px">Or paste this address into your browser:</p>
  <p style="margin:0 0 18px;font-size:12px;word-break:break-all"><a href="${e(link)}">${e(link)}</a></p>
  <p style="margin:0;color:#6B6A66;font-size:12px">${e(footer)}</p>
</div>`;
  }

  activation(to: string, fullName: string, company: string, link: string, hours: number) {
    const subject = `Activate your ${company} account`;
    const text = [
      `Hi ${fullName},`,
      '',
      `An account has been created for you on ${company} (EngPro).`,
      'Set your password to activate it:',
      link,
      '',
      `The link expires in ${hours} hours. If it expires, ask your manager to resend it.`,
    ].join(NEWLINE);
    return this.send(to, subject, text,
      this.layout(
        `Activate your ${company} account`,
        `Hi ${fullName}, an account has been created for you. Choose a password to activate it.`,
        'Set my password', link,
        `This link expires in ${hours} hours. If it expires, ask your manager to send a new one. If you were not expecting this email, you can ignore it.`,
      ));
  }

  /**
   * AR-15: sent when an account is locked by repeated failed logins. The login response
   * tells the attacker nothing, so this is how the account's real owner finds out that
   * someone is working on their password.
   */
  lockoutNotice(to: string, fullName: string, minutes: number, ip?: string | null) {
    const where = ip ? ` The most recent attempt came from ${ip}.` : '';
    const text = [
      `Hi ${fullName},`,
      '',
      `There have been repeated failed sign-in attempts on your EngPro account, so it has been locked for ${minutes} minutes.${where}`,
      '',
      `If this was you, wait ${minutes} minutes and try again, or use "Forgot password".`,
      'If it was not you, your password may be known to someone else — reset it now and tell your IT team.',
    ].join(NEWLINE);
    const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
    return this.send(to, 'Unusual sign-in attempts on your EngPro account', text,
      this.layout(
        'Unusual sign-in attempts on your account',
        `Hi ${fullName}, there have been repeated failed sign-in attempts on your EngPro account, so it has been locked for ${minutes} minutes.${where}`,
        'Reset my password', `${base}/forgot-password`,
        'If this was you, simply wait and try again. If it was not, reset your password now and tell your IT team.',
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
