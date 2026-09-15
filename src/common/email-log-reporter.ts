/**
 * Email audit reporter (2026-09-15): every send attempt, and the startup
 * transport status, goes to HR's EmailLog through the internal route — the
 * same HR_SERVICE_URL / INTERNAL_SECRET pair the in-app notifications use.
 * Best effort: a failed report never fails the send.
 */
export interface EmailLogReport {
  app: 'crm' | 'warehouse' | 'hr';
  context: string;
  recipients?: string[];
  subject?: string;
  status: 'SENT' | 'FAILED' | 'CONFIGURED' | 'DISABLED';
  error?: string | null;
  messageId?: string | null;
}

export async function reportEmail(entry: EmailLogReport): Promise<void> {
  const hrUrl = process.env.HR_SERVICE_URL || 'http://localhost:3001';
  const secret = process.env.INTERNAL_SECRET || 'nairon-internal';
  try {
    await fetch(`${hrUrl}/api/email-log/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
      body: JSON.stringify(entry),
    });
  } catch {
    /* audit is best effort */
  }
}
