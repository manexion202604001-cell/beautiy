import { z } from 'zod';
import { uuid } from '../../lib/schemas.js';

export const createReviewRequestSchema = z.object({
  customerId: uuid,
  appointmentId: uuid.optional(),
  shopId: uuid.optional(),
  staffId: uuid.optional(),
  /** send the request message now (default) or only issue the URL (e.g. to show as QR at the counter) */
  send: z.boolean().default(true),
});
export type CreateReviewRequestInput = z.infer<typeof createReviewRequestSchema>;

export const listReviewRequestsSchema = z.object({
  shopId: uuid.optional(),
  customerId: uuid.optional(),
  status: z.enum(['created', 'sent', 'opened', 'submitted', 'expired']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListReviewRequestsInput = z.infer<typeof listReviewRequestsSchema>;

export const submitReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(100).optional(),
  body: z.string().trim().max(2000).optional(),
  /** public nickname; real names are never shown publicly */
  reviewerName: z.string().trim().max(30).optional(),
  staffRating: z.number().int().min(1).max(5).optional(),
});
export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;

export const listReviewsSchema = z.object({
  shopId: uuid.optional(),
  staffId: uuid.optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  status: z.enum(['pending', 'published', 'hidden']).optional(),
  source: z.enum(['internal', 'google', 'external']).optional(),
  replied: z.enum(['true', 'false']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListReviewsInput = z.infer<typeof listReviewsSchema>;

export const moderateReviewSchema = z.object({ status: z.enum(['published', 'hidden', 'pending']) });

export const replySchema = z.object({ body: z.string().trim().min(1).max(4000) });

export const summaryQuerySchema = z.object({ shopId: uuid.optional(), staffId: uuid.optional() });

export const publicReviewsQuerySchema = z.object({
  staffId: uuid.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const googleImportSchema = z.object({ integrationAccountId: uuid.optional() });
