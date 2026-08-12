import type { Env } from './types.ts';

/**
 * Best-effort failure alert.
 *
 * An unattended loop that fails silently is indistinguishable from one that
 * succeeded, so the failure paths say so out loud. Two rules:
 *
 * 1. No-ops when `ALERT_WEBHOOK` is unset, so the loop runs unconfigured.
 * 2. NEVER throws. Alerting is not allowed to fail the run it is reporting on,
 *    and a webhook post is one more subrequest that can fail on its own.
 */
export async function alert(env: Env, subject: string, detail: string): Promise<void> {
  const url = env.ALERT_WEBHOOK;
  if (!url) return;

  const text = `[research-loop] ${subject}\n${detail}`.slice(0, 1800);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `text` is Slack's field, `content` is Discord's. Each ignores the
      // other, so one body works for both without configuration.
      body: JSON.stringify({ text, content: text }),
    });
  } catch (e) {
    console.error(`[alert] webhook post failed (original problem: ${subject}): ${String(e)}`);
  }
}
