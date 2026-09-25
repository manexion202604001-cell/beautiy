// External booking sync — implemented by the integrations module.
// Contract used by app/api/cron/route.ts:
export async function processPendingSyncEvents(_now: Date = new Date()): Promise<{ processed: number; failed: number }> {
  return { processed: 0, failed: 0 };
}
