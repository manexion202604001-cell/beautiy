import { z } from 'zod';
import { paginationQuery } from '../../lib/pagination.js';
import { booleanQuery, isoDateTime, uuid } from '../../lib/schemas.js';

export const CHANNELS = ['line', 'email', 'sms'] as const;
export type Channel = (typeof CHANNELS)[number];
export const channelEnum = z.enum(CHANNELS);

// ---------------------------------------------------------------- LINE channels

const lineChannelFields = {
  shopId: uuid.nullable().optional(),
  channelId: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  channelSecret: z.string().min(8).max(200),
  accessToken: z.string().min(8).max(1000),
  botUserId: z.string().min(1).max(100).nullable().optional(),
  basicId: z.string().max(50).nullable().optional(),
  liffId: z.string().max(100).nullable().optional(),
  loginChannelId: z.string().max(100).nullable().optional(),
};

export const createLineChannelSchema = z.object({
  ...lineChannelFields,
  /** verify the access token against LINE (reads the bot userId used as webhook destination) */
  verify: z.boolean().default(true),
});
export type CreateLineChannelInput = z.infer<typeof createLineChannelSchema>;

export const updateLineChannelSchema = z
  .object({
    name: lineChannelFields.name,
    channelSecret: lineChannelFields.channelSecret,
    accessToken: lineChannelFields.accessToken,
    botUserId: lineChannelFields.botUserId,
    basicId: lineChannelFields.basicId,
    liffId: lineChannelFields.liffId,
    loginChannelId: lineChannelFields.loginChannelId,
    status: z.enum(['active', 'disabled']),
  })
  .partial();
export type UpdateLineChannelInput = z.infer<typeof updateLineChannelSchema>;

// ---------------------------------------------------------------- templates

export const TEMPLATE_CATEGORIES = ['transactional', 'marketing', 'followup', 'review', 'other'] as const;

export const createTemplateSchema = z.object({
  shopId: uuid.nullable().optional(),
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,59}$/, 'キーは英小文字・数字・_で指定してください')
    .nullable()
    .optional(),
  name: z.string().min(1).max(100),
  channel: channelEnum.default('line'),
  category: z.enum(TEMPLATE_CATEGORIES).default('other'),
  subject: z.string().max(200).nullable().optional(),
  body: z.string().min(1).max(5000),
  payload: z.record(z.string(), z.unknown()).nullable().optional(),
  status: z.enum(['active', 'inactive']).default('active'),
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = z
  .object({
    name: z.string().min(1).max(100),
    category: z.enum(TEMPLATE_CATEGORIES),
    subject: z.string().max(200).nullable(),
    body: z.string().min(1).max(5000),
    payload: z.record(z.string(), z.unknown()).nullable(),
    status: z.enum(['active', 'inactive']),
  })
  .partial();
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

export const listTemplatesSchema = z.object({
  shopId: uuid.optional(),
  channel: channelEnum.optional(),
  key: z.string().max(60).optional(),
  category: z.enum(TEMPLATE_CATEGORIES).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const previewTemplateSchema = z
  .object({
    templateId: uuid.optional(),
    body: z.string().max(5000).optional(),
    subject: z.string().max(200).nullable().optional(),
    customerId: uuid.optional(),
    shopId: uuid.optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => v.templateId || v.body, { message: 'templateId または body を指定してください' });

// ---------------------------------------------------------------- 1:1 messages

export const sendMessageSchema = z
  .object({
    customerId: uuid,
    body: z.string().min(1).max(5000).optional(),
    templateId: uuid.optional(),
    channel: channelEnum.optional(),
    shopId: uuid.nullable().optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => v.body || v.templateId, { message: '本文またはテンプレートを指定してください' });
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const listMessagesSchema = paginationQuery.extend({
  customerId: uuid,
  direction: z.enum(['inbound', 'outbound']).optional(),
});

export const inboxSchema = paginationQuery.extend({
  shopId: uuid.optional(),
  unreadOnly: booleanQuery,
});

// ---------------------------------------------------------------- segments (rule validated in segments.ts)

export const createSegmentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  rule: z.unknown(),
});
export const updateSegmentSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).nullable(),
    rule: z.unknown(),
  })
  .partial();
export const previewSegmentSchema = z.object({
  rule: z.unknown(),
  shopId: uuid.optional(),
  sampleSize: z.number().int().min(0).max(100).default(20),
});

// ---------------------------------------------------------------- campaigns

export const createCampaignSchema = z
  .object({
    name: z.string().min(1).max(100),
    shopId: uuid.nullable().optional(),
    channel: channelEnum.default('line'),
    segmentId: uuid.nullable().optional(),
    segmentRule: z.unknown().optional(),
    templateId: uuid.nullable().optional(),
    body: z.string().min(1).max(5000).nullable().optional(),
  })
  .refine((v) => v.templateId || v.body, { message: '本文またはテンプレートを指定してください' })
  .refine((v) => v.segmentId || v.segmentRule !== undefined, { message: 'セグメントを指定してください' });
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export const updateCampaignSchema = z
  .object({
    name: z.string().min(1).max(100),
    shopId: uuid.nullable(),
    channel: channelEnum,
    segmentId: uuid.nullable(),
    segmentRule: z.unknown(),
    templateId: uuid.nullable(),
    body: z.string().min(1).max(5000).nullable(),
  })
  .partial();
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;

export const scheduleCampaignSchema = z.object({ scheduledAt: isoDateTime.optional() });
export const listCampaignsSchema = paginationQuery.extend({
  status: z.enum(['draft', 'scheduled', 'running', 'completed', 'cancelled', 'failed']).optional(),
});

// ---------------------------------------------------------------- automations

export const TRIGGER_TYPES = ['days_since_last_visit', 'no_return_after_first_visit', 'visit_cycle_due', 'after_visit', 'birthday_month'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const automationConfigSchema = z
  .object({
    /** days threshold (休眠日数 / 初回後日数 / 来店後日数) */
    days: z.number().int().min(1).max(3650).optional(),
    requireNoFutureAppointment: z.boolean().optional(),
    /** visit_cycle_due: send N days after (positive) / before (negative) the expected next visit */
    offsetDays: z.number().int().min(-60).max(365).optional(),
    /** visit_cycle_due: minimum visits needed for a reliable cycle */
    minVisits: z.number().int().min(2).max(100).optional(),
    /** local hour to send at (default: immediately when the daily run happens) */
    sendHour: z.number().int().min(9).max(20).optional(),
    /** system template key used when no template_id is set */
    templateKey: z.string().max(60).optional(),
    /** additional segment rule to narrow candidates (DSL) */
    segmentRule: z.unknown().optional(),
  })
  .strict();
export type AutomationConfig = z.infer<typeof automationConfigSchema>;

export const createAutomationSchema = z.object({
  name: z.string().min(1).max(100),
  shopId: uuid.nullable().optional(),
  triggerType: z.enum(TRIGGER_TYPES),
  config: automationConfigSchema.default({}),
  channel: channelEnum.default('line'),
  templateId: uuid.nullable().optional(),
  isActive: z.boolean().default(false),
});
export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;

export const updateAutomationSchema = z
  .object({
    name: z.string().min(1).max(100),
    shopId: uuid.nullable(),
    config: automationConfigSchema,
    channel: channelEnum,
    templateId: uuid.nullable(),
    isActive: z.boolean(),
  })
  .partial();
export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;

// ---------------------------------------------------------------- preferences

export const channelPreferenceItem = z.object({
  channel: channelEnum,
  marketingAllowed: z.boolean().optional(),
  transactionalAllowed: z.boolean().optional(),
});
export const updatePreferencesSchema = z.object({
  marketingOptIn: z.boolean().optional(),
  channels: z.array(channelPreferenceItem).max(3).optional(),
});
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;

export const unsubscribeSchema = z.object({
  token: z.string().min(10).max(2000),
  /** channel: stop marketing on this channel only / all: global marketing opt-out */
  scope: z.enum(['channel', 'all']).default('channel'),
});

// ---------------------------------------------------------------- LINE linking

export const lineLinkTokenSchema = z.object({
  shopId: uuid.optional(),
  ttlHours: z.number().int().min(1).max(24 * 30).default(72),
});
export const publicLineLinkSchema = z.object({
  token: z.string().min(10).max(200),
  idToken: z.string().min(5).max(5000),
});
