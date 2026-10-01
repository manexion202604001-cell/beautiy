import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, newIdempotencyKey } from '../lib/api';
import type { Page } from './types';
import type { SegmentRule } from '../routes/app/campaigns/segment-dsl';

/** Messaging (1:1 messages, templates, segments, campaigns, automations, preferences, LINE). */

export type Channel = 'line' | 'email' | 'sms';
export type MessageStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'read'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'received';

export const CHANNEL_LABEL: Record<Channel, string> = { line: 'LINE', email: 'メール', sms: 'SMS' };

export const MESSAGE_STATUS_LABEL: Record<string, string> = {
  queued: '送信待ち',
  sending: '送信中',
  sent: '送信済み',
  read: '既読',
  failed: '送信失敗',
  skipped: 'スキップ',
  cancelled: '取消',
  received: '未読',
};

export const SKIP_REASON_LABEL: Record<string, string> = {
  no_customer: '顧客が指定されていません',
  customer_not_found: '顧客が見つかりません',
  customer_deleted: '削除済みの顧客',
  customer_merged: '統合済みの顧客',
  customer_blocked: '受付停止中の顧客',
  opted_out: '配信停止中',
  no_line_identity: 'LINE未連携',
  no_contact: '送信可能な連絡先がありません',
  template_disabled: 'テンプレートが無効',
};

export interface Message {
  id: string;
  shop_id: string | null;
  customer_id: string | null;
  channel: Channel;
  direction: 'inbound' | 'outbound';
  category: string;
  message_type: string;
  body: string | null;
  template_id: string | null;
  campaign_id: string | null;
  automation_id: string | null;
  appointment_id: string | null;
  status: MessageStatus;
  skip_reason: string | null;
  error: string | null;
  attempts: number;
  scheduled_at: string | null;
  sent_at: string | null;
  read_at: string | null;
  sent_by_staff_id: string | null;
  sent_by_staff_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface InboxItem {
  id: string;
  customer_id: string;
  created_at: string;
  body: string | null;
  direction: 'inbound' | 'outbound';
  channel: Channel;
  status: MessageStatus;
  message_type: string;
  unread_count: number;
  customer_name: string;
}

export type TemplateCategory = 'transactional' | 'marketing' | 'followup' | 'review' | 'other';
export const TEMPLATE_CATEGORY_LABEL: Record<TemplateCategory, string> = {
  transactional: '予約・取引',
  marketing: '販促',
  followup: 'フォロー',
  review: '口コミ',
  other: 'その他',
};

export interface MessageTemplate {
  id: string;
  shop_id: string | null;
  key: string | null;
  name: string;
  channel: Channel;
  category: TemplateCategory;
  subject: string | null;
  body: string;
  payload: unknown;
  status: 'active' | 'inactive';
  isSystem: boolean;
  variables: string[];
  created_at?: string;
  updated_at?: string;
}

export interface TemplateInput {
  shopId?: string | null;
  name: string;
  channel?: Channel;
  category?: TemplateCategory;
  subject?: string | null;
  body: string;
  status?: 'active' | 'inactive';
}

export interface TemplatePreview {
  subject: string | null;
  body: string;
  variables: string[];
  unknownVariables: string[];
}

export interface Segment {
  id: string;
  name: string;
  description: string | null;
  rule: SegmentRule;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SegmentPreview {
  count: number;
  sample: {
    id: string;
    display_name: string;
    last_visit_at: string | null;
    visit_count: number;
    total_sales: number;
    marketing_opt_in: boolean;
  }[];
}

export type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'completed' | 'cancelled' | 'failed';
export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: '下書き',
  scheduled: '配信予約済み',
  running: '配信中',
  completed: '配信完了',
  cancelled: 'キャンセル',
  failed: '失敗',
};

export interface CampaignStats {
  targets: number;
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

export interface Campaign {
  id: string;
  shop_id: string | null;
  name: string;
  channel: Channel;
  segment_id: string | null;
  segment_rule: SegmentRule;
  template_id: string | null;
  body: string | null;
  scheduled_at: string | null;
  status: CampaignStatus;
  stats: CampaignStats;
  approved_by: string | null;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignInput {
  name: string;
  shopId?: string | null;
  channel?: Channel;
  segmentId?: string | null;
  segmentRule?: SegmentRule;
  templateId?: string | null;
  body?: string | null;
}

export type TriggerType =
  | 'days_since_last_visit'
  | 'no_return_after_first_visit'
  | 'visit_cycle_due'
  | 'after_visit'
  | 'birthday_month';

export const TRIGGER_LABEL: Record<TriggerType, string> = {
  days_since_last_visit: '休眠フォロー（最終来店からN日）',
  no_return_after_first_visit: '初回来店後の未再来',
  visit_cycle_due: '来店周期の到来',
  after_visit: '来店後フォロー（N日後）',
  birthday_month: '誕生月',
};

export interface AutomationConfig {
  days?: number;
  requireNoFutureAppointment?: boolean;
  offsetDays?: number;
  minVisits?: number;
  sendHour?: number;
  templateKey?: string;
  segmentRule?: SegmentRule;
}

export interface Automation {
  id: string;
  shop_id: string | null;
  name: string;
  trigger_type: TriggerType;
  config: AutomationConfig;
  channel: Channel;
  template_id: string | null;
  is_active: boolean;
  last_run_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  stats?: { runs: number; sent: number };
}

export interface AutomationInput {
  name?: string;
  shopId?: string | null;
  triggerType?: TriggerType;
  config?: AutomationConfig;
  channel?: Channel;
  templateId?: string | null;
  isActive?: boolean;
}

export interface DryRunResult {
  candidates: number;
  alreadySent: number;
  sample: { id: string; display_name: string; last_visit_at: string | null; visit_count: number }[];
}

export interface ChannelPreference {
  channel: Channel;
  marketingAllowed: boolean;
  transactionalAllowed: boolean;
  source: string | null;
  updatedAt: string | null;
}

export interface Preferences {
  customerId: string;
  marketingOptIn: boolean;
  channels: ChannelPreference[];
}

export interface PreferencesInput {
  marketingOptIn?: boolean;
  channels?: { channel: Channel; marketingAllowed?: boolean; transactionalAllowed?: boolean }[];
}

export interface LineLinkToken {
  token: string;
  url: string;
  qrPayload: string;
  expiresAt: string;
  lineChannelId: string;
}

export interface LineChannel {
  id: string;
  shop_id: string | null;
  channel_id: string;
  bot_user_id: string | null;
  name: string;
  basic_id: string | null;
  liff_id: string | null;
  login_channel_id: string | null;
  status: 'active' | 'disabled' | string;
  webhook_verified_at: string | null;
  created_at: string;
  updated_at: string;
  channelSecretMasked: string;
  accessTokenMasked: string;
  webhookUrl: string;
}

export interface LineChannelInput {
  shopId?: string | null;
  channelId?: string;
  name?: string;
  channelSecret?: string;
  accessToken?: string;
  basicId?: string | null;
  liffId?: string | null;
  loginChannelId?: string | null;
  status?: 'active' | 'disabled';
  verify?: boolean;
}

export const messagingApi = {
  // 1:1
  inbox: (q: { shopId?: string; unreadOnly?: boolean; cursor?: string; limit?: number }) =>
    api.get<Page<InboxItem>>('/messages/inbox', { ...q }),
  conversation: (q: { customerId: string; cursor?: string; limit?: number }) =>
    api.get<Page<Message>>('/messages', { ...q }),
  send: (
    input: {
      customerId: string;
      body?: string;
      templateId?: string;
      channel?: Channel;
      shopId?: string | null;
    },
    idempotencyKey = newIdempotencyKey(),
  ) => api.post<Message>('/messages/send', input, { idempotencyKey }),
  markRead: (id: string) => api.post<{ ok: true; updated: number }>(`/messages/${id}/read`),
  retry: (id: string, idempotencyKey = newIdempotencyKey()) =>
    api.post<Message>(`/messages/${id}/retry`, undefined, { idempotencyKey }),

  // templates
  templates: (q: { shopId?: string; channel?: Channel; category?: string; status?: string } = {}) =>
    api.get<MessageTemplate[]>('/message-templates', q),
  createTemplate: (input: TemplateInput) => api.post<MessageTemplate>('/message-templates', input),
  updateTemplate: (id: string, input: Partial<TemplateInput>) =>
    api.patch<MessageTemplate>(`/message-templates/${id}`, input),
  deleteTemplate: (id: string) => api.delete(`/message-templates/${id}`),
  previewTemplate: (input: {
    templateId?: string;
    body?: string;
    subject?: string | null;
    customerId?: string;
    shopId?: string;
    vars?: Record<string, unknown>;
  }) => api.post<TemplatePreview>('/message-templates/preview', input),

  // segments
  segments: () => api.get<Page<Segment>>('/segments', { limit: 100 }),
  createSegment: (input: { name: string; description?: string | null; rule: SegmentRule }) =>
    api.post<Segment>('/segments', input),
  updateSegment: (
    id: string,
    input: { name?: string; description?: string | null; rule?: SegmentRule },
  ) => api.patch<Segment>(`/segments/${id}`, input),
  deleteSegment: (id: string) => api.delete(`/segments/${id}`),
  previewSegment: (input: { rule: SegmentRule; shopId?: string; sampleSize?: number }) =>
    api.post<SegmentPreview>('/segments/preview', input),

  // campaigns
  campaigns: (q: { status?: CampaignStatus; cursor?: string; limit?: number } = {}) =>
    api.get<Page<Campaign>>('/campaigns', { ...q }),
  campaign: (id: string) => api.get<Campaign>(`/campaigns/${id}`),
  createCampaign: (input: CampaignInput, idempotencyKey = newIdempotencyKey()) =>
    api.post<Campaign>('/campaigns', input, { idempotencyKey }),
  updateCampaign: (id: string, input: Partial<CampaignInput>) =>
    api.patch<Campaign>(`/campaigns/${id}`, input),
  deleteCampaign: (id: string) => api.delete(`/campaigns/${id}`),
  approveCampaign: (id: string) => api.post<Campaign>(`/campaigns/${id}/approve`),
  scheduleCampaign: (id: string, scheduledAt?: string, idempotencyKey = newIdempotencyKey()) =>
    api.post<Campaign>(
      `/campaigns/${id}/schedule`,
      scheduledAt ? { scheduledAt } : {},
      { idempotencyKey },
    ),
  cancelCampaign: (id: string) =>
    api.post<Campaign & { cancelledMessages: number }>(`/campaigns/${id}/cancel`),

  // automations
  automations: () => api.get<Automation[]>('/automations'),
  automation: (id: string) => api.get<Automation>(`/automations/${id}`),
  createAutomation: (input: AutomationInput) => api.post<Automation>('/automations', input),
  updateAutomation: (id: string, input: AutomationInput) =>
    api.patch<Automation>(`/automations/${id}`, input),
  deleteAutomation: (id: string) =>
    api.delete<{ ok: true; deactivatedOnly: boolean }>(`/automations/${id}`),
  dryRun: (id: string) => api.post<DryRunResult>(`/automations/${id}/dry-run`),

  // preferences
  preferences: (customerId: string) =>
    api.get<Preferences>(`/customers/${customerId}/channel-preferences`),
  updatePreferences: (customerId: string, input: PreferencesInput) =>
    api.put<Preferences>(`/customers/${customerId}/channel-preferences`, input),

  // LINE linking / channels
  lineLinkToken: (customerId: string, input: { shopId?: string; ttlHours?: number } = {}) =>
    api.post<LineLinkToken>(`/customers/${customerId}/line-link-token`, input),
  lineChannels: () => api.get<LineChannel[]>('/line-channels'),
  createLineChannel: (input: LineChannelInput, idempotencyKey = newIdempotencyKey()) =>
    api.post<LineChannel>('/line-channels', input, { idempotencyKey }),
  updateLineChannel: (id: string, input: LineChannelInput) =>
    api.patch<LineChannel>(`/line-channels/${id}`, input),
  deleteLineChannel: (id: string) => api.delete(`/line-channels/${id}`),
  verifyLineChannel: (id: string) =>
    api.post<{ ok: true; botUserId: string; basicId: string | null; channel: LineChannel }>(
      `/line-channels/${id}/verify`,
    ),
};

/** Customer-facing (public / customer-token) messaging endpoints */
export const publicMessagingApi = {
  unsubscribeInfo: (token: string) =>
    api.get<{ channel: Channel; email: string | null; marketingOptIn: boolean; marketingAllowed: boolean }>(
      '/public/unsubscribe',
      { token },
      { auth: 'none' },
    ),
  unsubscribe: (token: string, scope: 'channel' | 'all') =>
    api.post<{ ok: true; channel: Channel; scope: 'channel' | 'all' }>('/public/unsubscribe', { token, scope }, { auth: 'none' }),
  lineLink: (token: string, idToken: string) =>
    api.post<{ linked: true; customerId: string; following: boolean | null }>(
      '/public/line-link',
      { token, idToken },
      { auth: 'none' },
    ),
  myPreferences: (token: string) =>
    api.get<Preferences>('/public/me/notification-preferences', undefined, { auth: 'customer', token }),
  updateMyPreferences: (token: string, input: PreferencesInput) =>
    api.put<Preferences>('/public/me/notification-preferences', input, { auth: 'customer', token }),
};

export const messagingKeys = {
  all: ['messaging'] as const,
  inbox: (q: object) => ['messaging', 'inbox', q] as const,
  conversation: (customerId: string) => ['messaging', 'conversation', customerId] as const,
  templates: (q: object = {}) => ['messaging', 'templates', q] as const,
  segments: ['messaging', 'segments'] as const,
  campaigns: (q: object = {}) => ['messaging', 'campaigns', q] as const,
  automations: ['messaging', 'automations'] as const,
  preferences: (id: string) => ['messaging', 'preferences', id] as const,
  lineChannels: ['messaging', 'line-channels'] as const,
};

export function useInbox(q: { shopId?: string; unreadOnly?: boolean }, enabled = true) {
  return useInfiniteQuery({
    queryKey: messagingKeys.inbox(q),
    queryFn: ({ pageParam }) => messagingApi.inbox({ ...q, cursor: pageParam, limit: 30 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    refetchInterval: 30_000,
  });
}

export function useConversation(customerId: string | null | undefined) {
  return useInfiniteQuery({
    queryKey: messagingKeys.conversation(customerId ?? ''),
    queryFn: ({ pageParam }) =>
      messagingApi.conversation({ customerId: customerId!, cursor: pageParam, limit: 30 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!customerId,
    // queued messages turn into sent/failed asynchronously (worker)
    refetchInterval: (query) => {
      const items = query.state.data?.pages[0]?.items ?? [];
      return items.some((m) => m.status === 'queued' || m.status === 'sending') ? 3_000 : 20_000;
    },
  });
}

export function useTemplates(q: { shopId?: string; channel?: Channel; status?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: messagingKeys.templates(q),
    queryFn: () => messagingApi.templates(q),
    enabled,
    staleTime: 30_000,
  });
}

export function useSegments(enabled = true) {
  return useQuery({
    queryKey: messagingKeys.segments,
    queryFn: messagingApi.segments,
    enabled,
  });
}

export function useLineChannels(enabled = true) {
  return useQuery({
    queryKey: messagingKeys.lineChannels,
    queryFn: messagingApi.lineChannels,
    enabled,
  });
}
