import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { UsersPrismaService } from '../users-prisma.service';

export interface WarehouseNotification {
  /** Who to reach: everyone holding any of these permissions (super-admins always included). */
  permissions: string[];
  title: string;
  /** Plain text — used verbatim in-app and as the email's lead line. */
  body: string;
  /** Path within the warehouse client, e.g. "/resources". */
  path?: string;
  /** Optional detail rows rendered as a table in the email. */
  details?: { label: string; value: string }[];
}

/**
 * Warehouse notifications: in-app plus email.
 *
 * In-app follows the platform pattern — hr-api owns the notification store and
 * sibling services POST to it with the shared internal secret (crm-api does the
 * same). Email is sent directly from here.
 *
 * Everything is best-effort and never throws: a notification failure must not
 * roll back or fail the warehouse operation that triggered it. Delivery is also
 * fire-and-forget by design, so callers should NOT await it inside a
 * transaction.
 */
@Injectable()
export class WarehouseNotificationsService {
  private readonly logger = new Logger(WarehouseNotificationsService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor(private usersPrisma: UsersPrismaService) {
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;
    if (user && pass) {
      this.transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: { user, pass },
      });
    } else {
      this.logger.warn('EMAIL_USER/EMAIL_PASS not set — warehouse emails are disabled (in-app still works)');
    }
  }

  /** Resolve recipients by permission and deliver over both channels. Never throws. */
  async send(n: WarehouseNotification): Promise<void> {
    try {
      const recipients = await this.usersPrisma.getNotificationRecipients(n.permissions);
      if (!recipients.length) {
        this.logger.warn(`No recipients hold [${n.permissions.join(', ')}] — "${n.title}" not sent`);
        return;
      }
      await this.deliver(recipients, n);
    } catch (e: any) {
      this.logger.error(`Notification "${n.title}" failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Deliver to specific users rather than a permission audience — used for
   * requester-facing alerts, which are routed to the assignees of the linked
   * CRM task (a reservation itself records no requester).
   */
  async sendToUsers(userIds: number[], n: Omit<WarehouseNotification, 'permissions'>): Promise<void> {
    try {
      const ids = [...new Set(userIds.filter((id) => Number.isFinite(id)))];
      if (!ids.length) return;
      const recipients = await this.usersPrisma.getUsersByIds(ids);
      if (!recipients.length) return;
      await this.deliver(recipients, { ...n, permissions: [] });
    } catch (e: any) {
      this.logger.error(`Notification "${n.title}" failed: ${e?.message ?? e}`);
    }
  }

  private async deliver(
    recipients: { id: number; email: string }[],
    n: WarehouseNotification,
  ): Promise<void> {
    const url = this.clientUrl(n.path);
    await Promise.allSettled([
      this.sendInApp(recipients.map((r) => r.id), n, url),
      this.sendEmail(recipients.map((r) => r.email).filter(Boolean), n, url),
    ]);
  }

  private clientUrl(path?: string): string {
    const base = (process.env.FRONTEND_URL || 'http://localhost:4003').replace(/\/$/, '');
    return path ? `${base}${path.startsWith('/') ? path : `/${path}`}` : base;
  }

  private async sendInApp(userIds: number[], n: WarehouseNotification, url: string): Promise<void> {
    const hrUrl = process.env.HR_SERVICE_URL || 'http://localhost:3001';
    const secret = process.env.INTERNAL_SECRET || 'nairon-internal';

    const results = await Promise.allSettled(
      userIds.map((userId) =>
        fetch(`${hrUrl}/api/notifications/internal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
          body: JSON.stringify({ userId, title: n.title, body: n.body, url }),
        }).then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status} for userId ${userId}`);
        }),
      ),
    );
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
      this.logger.error(
        `In-app notification failed for ${failed.length}/${userIds.length}: ` +
          `${(failed[0] as PromiseRejectedResult).reason?.message}`,
      );
    }
  }

  private async sendEmail(to: string[], n: WarehouseNotification, url: string): Promise<void> {
    if (!this.transporter || !to.length) return;
    try {
      await this.transporter.sendMail({
        from: `"Nairon Պահեստ" <${process.env.EMAIL_USER}>`,
        to: to.join(', '),
        subject: n.title,
        html: this.render(n, url),
      });
    } catch (e: any) {
      this.logger.error(`Warehouse email failed: ${e?.message ?? e}`);
    }
  }

  /** Mirrors the card/CTA shape the CRM notification emails already use. */
  private render(n: WarehouseNotification, url: string): string {
    const rows = (n.details ?? [])
      .map(
        (d) => `
            <tr>
              <td style="padding:6px 0;color:#64748b;font-size:13px;width:160px;vertical-align:top;">${d.label}</td>
              <td style="padding:6px 0;font-size:13px;color:#1e293b;"><b>${d.value}</b></td>
            </tr>`,
      )
      .join('');

    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:#1e293b;padding:20px 32px;">
            <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.5px;">Nairon Պահեստ</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 20px;font-size:15px;color:#475569;">${n.body}</p>
            ${rows ? `<table style="width:100%;border-collapse:collapse;margin:16px 0;">${rows}</table>` : ''}
            <a href="${url}" style="display:inline-block;margin-top:8px;background:#6366f1;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600;">Բացել պահեստը →</a>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;">
            <p style="margin:0;font-size:12px;color:#94a3b8;">Դուք ստացել եք այս նամակը Nairon պահեստի ծանուցումների կարգավորման համաձայն</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }
}
