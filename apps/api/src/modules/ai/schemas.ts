import { z } from 'zod';
import { uuid } from '../../lib/schemas.js';

export const atRiskQuery = z.object({
  shopId: uuid.optional(),
  level: z.enum(['low', 'medium', 'high']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AtRiskQuery = z.infer<typeof atRiskQuery>;

export const forecastQuery = z.object({
  shopId: uuid,
  days: z.coerce.number().int().min(1).max(90).default(30),
});
export type ForecastQuery = z.infer<typeof forecastQuery>;

export const MESSAGE_PURPOSES = ['followup', 'dormant', 'birthday', 'review_thanks'] as const;
export const TONES = ['polite', 'friendly', 'casual'] as const;

export const messageDraftBody = z.object({
  customerId: uuid,
  purpose: z.enum(MESSAGE_PURPOSES),
  tone: z.enum(TONES).optional(),
});
export type MessageDraftBody = z.infer<typeof messageDraftBody>;

export const reviewReplyDraftBody = z.object({ reviewId: uuid });
export const karteSummaryBody = z.object({ customerId: uuid });

export const acceptBody = z.object({
  /** text as edited by the staff member (stored on the suggestion; never sent automatically) */
  editedText: z.string().min(1).max(5000).optional(),
});
export const rejectBody = z.object({ reason: z.string().max(500).optional() });

export const SUGGESTION_KINDS = ['message_draft', 'review_reply', 'karte_summary', 'sales_forecast', 'next_action'] as const;

export const listSuggestionsQuery = z.object({
  subjectType: z.enum(['customer', 'review']).optional(),
  subjectId: uuid.optional(),
  kind: z.enum(SUGGESTION_KINDS).optional(),
  status: z.enum(['proposed', 'accepted', 'rejected', 'applied']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListSuggestionsQuery = z.infer<typeof listSuggestionsQuery>;

export const nextActionsQuery = z.object({
  shopId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type NextActionsQuery = z.infer<typeof nextActionsQuery>;
