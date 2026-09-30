import { Logger } from '@nestjs/common';

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

const logger = new Logger('EmailLogReporter');

export async function reportEmail(entry: EmailLogReport): Promise<void> {
  const hrUrl = process.env.HR_SERVICE_URL || 'http://localhost:3001';
  // Was a fallback to the literal 'nairon-internal' — a string from this
  // repository, sent as a credential whenever the variable was unset. An
  // unconfigured service now sends nothing: the report is lost exactly as it
  // would be if HR were unreachable.
  const secret = process.env.INTERNAL_SECRET;
  if (typeof secret !== 'string' || secret.trim() === '') {
    logger.warn('INTERNAL_SECRET is not set; email audit entry not sent');
    return;
  }
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
