/**
 * Public contract of the kartes / forms module for other modules.
 */
import type { Ctx } from '../../auth/actor.js';

/**
 * Appointments (of the given ids) for which the customer has submitted a form — a consent or
 * counselling sheet filled in for that visit. Shown as 「同意済」 on the reservation screens.
 */
export async function appointmentsWithSubmittedForm(ctx: Ctx, appointmentIds: string[]): Promise<Set<string>> {
  if (!appointmentIds.length) return new Set();
  const rows = await ctx.trx
    .selectFrom('form_responses')
    .select('appointment_id')
    .where('appointment_id', 'in', appointmentIds)
    .where('status', '=', 'submitted')
    .execute();
  return new Set(rows.map((r) => r.appointment_id!).filter(Boolean));
}

/**
 * Put counselling answers collected outside the customer screen (walk-in reception, …) on the
 * customer's カウンセリングシート. `data` = { <category id>: { <question id>: answer } }; the given
 * categories replace the same categories of the sheet. The caller checks permissions.
 */
export { mergeIntoCounselingSheet } from './counseling.js';
