import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, newIdempotencyKey } from '../lib/api';
import type { FieldDef, FieldValues } from './kartes';
import type { Page } from './types';

export type FormKind = 'counseling' | 'consent' | 'pre_visit';
export type FormStatus = 'draft' | 'active' | 'archived';

export interface FormTemplate {
  id: string;
  lineage_id: string;
  shop_id: string | null;
  kind: FormKind;
  name: string;
  fields: FieldDef[];
  body_markdown: string | null;
  requires_signature: boolean;
  status: FormStatus;
  version: number;
  created_at: string;
  updated_at: string;
  previous_version_id?: string | null;
  new_version?: boolean;
}

export interface FormTemplateInput {
  kind?: FormKind;
  name?: string;
  shopId?: string | null;
  fields?: FieldDef[];
  bodyMarkdown?: string | null;
  requiresSignature?: boolean;
  status?: FormStatus;
}

export interface FormResponseListItem {
  id: string;
  template_id: string;
  template_version: number;
  template_name: string;
  kind: FormKind;
  customer_id: string;
  appointment_id: string | null;
  karte_id: string | null;
  shop_id: string | null;
  status: 'pending' | 'submitted' | 'voided';
  submitted_via: string | null;
  signer_name: string | null;
  signed_at: string | null;
  submitted_at: string | null;
  document_hash: string | null;
  voided_at: string | null;
  created_at: string;
}

export interface TemplateSnapshot {
  templateId: string;
  lineageId: string;
  kind: FormKind;
  name: string;
  version: number;
  fields: FieldDef[];
  bodyMarkdown: string | null;
  requiresSignature: boolean;
}

export interface FormResponseDetail {
  id: string;
  template_id: string;
  template_version: number;
  template_snapshot: TemplateSnapshot;
  customer_id: string;
  appointment_id: string | null;
  karte_id: string | null;
  status: 'pending' | 'submitted' | 'voided';
  answers: FieldValues;
  signer_name: string | null;
  signed_at: string | null;
  submitted_at: string | null;
  submitted_via: string | null;
  document_hash: string | null;
  void_reason: string | null;
  voided_at: string | null;
  created_at: string;
  signature: { url: string; expiresAt: string; contentType: string } | null;
}

export interface VerifyResult {
  valid: boolean;
  status: string;
  documentHash: string | null;
  recomputedHash: string;
  hashMatches: boolean;
  signature: { present: boolean; intact: boolean | null; checksum: string | null };
  verifiedAt: string;
}

export interface FormLinkResult {
  responseId: string;
  url: string;
  expiresAt: string;
  messageId: string | null;
}

export interface PublicFormView {
  form: {
    name: string;
    kind: FormKind;
    version: number;
    fields: FieldDef[];
    bodyMarkdown: string | null;
    requiresSignature: boolean;
  };
  shop: { name: string } | null;
  appointment: { startAt: string } | null;
  customer: {
    lastName: string;
    firstName: string;
    lastNameKana: string | null;
    firstNameKana: string | null;
    birthday: string | null;
  };
  prefill: FieldValues;
}

export const formsApi = {
  templates: (q: { kind?: FormKind; shopId?: string; includeArchived?: boolean } = {}) =>
    api.get<FormTemplate[]>('/form-templates', {
      kind: q.kind,
      shopId: q.shopId,
      includeArchived: q.includeArchived ? 'true' : undefined,
    }),
  template: (id: string) => api.get<FormTemplate>(`/form-templates/${id}`),
  versions: (id: string) => api.get<FormTemplate[]>(`/form-templates/${id}/versions`),
  createTemplate: (input: FormTemplateInput) => api.post<FormTemplate>('/form-templates', input),
  updateTemplate: (id: string, input: FormTemplateInput) =>
    api.patch<FormTemplate>(`/form-templates/${id}`, input),
  archiveTemplate: (id: string) => api.delete(`/form-templates/${id}`),
  responses: (q: {
    customerId: string;
    kind?: FormKind;
    status?: string;
    appointmentId?: string;
    cursor?: string;
    limit?: number;
  }) => api.get<Page<FormResponseListItem>>('/form-responses', { ...q }),
  response: (id: string) => api.get<FormResponseDetail>(`/form-responses/${id}`),
  createResponse: (
    input: {
      templateId: string;
      customerId: string;
      appointmentId?: string | null;
      karteId?: string | null;
      answers: FieldValues;
      signature?: { dataUrl: string; signerName: string };
    },
    key = newIdempotencyKey(),
  ) => api.post<FormResponseDetail>('/form-responses', input, { idempotencyKey: key }),
  voidResponse: (id: string, reason: string) =>
    api.post<FormResponseDetail>(`/form-responses/${id}/void`, { reason }),
  verify: (id: string) => api.get<VerifyResult>(`/form-responses/${id}/verify`),
  preVisitLink: (
    appointmentId: string,
    input: {
      templateId: string;
      expiresInDays?: number;
      notify: boolean;
      channel?: 'line' | 'email' | 'sms';
    },
  ) => api.post<FormLinkResult>(`/appointments/${appointmentId}/pre-visit-form`, input),
  customerLink: (
    customerId: string,
    input: {
      templateId: string;
      expiresInDays?: number;
      notify: boolean;
      channel?: 'line' | 'email' | 'sms';
    },
  ) => api.post<FormLinkResult>(`/customers/${customerId}/form-links`, input),
  publicView: (token: string) =>
    api.get<PublicFormView>(`/public/forms/${encodeURIComponent(token)}`, undefined, {
      auth: 'none',
    }),
  publicSubmit: (
    token: string,
    input: { answers: FieldValues; signature?: { dataUrl: string; signerName: string } },
  ) =>
    api.post<{ ok: true; responseId: string; submittedAt: string; documentHash: string }>(
      `/public/forms/${encodeURIComponent(token)}`,
      input,
      { auth: 'none' },
    ),
};

export const formKeys = {
  all: ['forms'] as const,
  templates: (q: object) => ['forms', 'templates', q] as const,
  versions: (id: string) => ['forms', 'versions', id] as const,
  responses: (q: object) => ['forms', 'responses', q] as const,
  response: (id: string) => ['forms', 'response', id] as const,
};

export function useFormTemplates(
  q: { kind?: FormKind; shopId?: string; includeArchived?: boolean } = {},
) {
  return useQuery({
    queryKey: formKeys.templates(q),
    queryFn: () => formsApi.templates(q),
    staleTime: 60_000,
  });
}

export function useFormResponses(q: { customerId: string; kind?: FormKind; status?: string }) {
  return useInfiniteQuery({
    queryKey: formKeys.responses(q),
    queryFn: ({ pageParam }) => formsApi.responses({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export const FORM_KIND_LABEL: Record<FormKind, string> = {
  counseling: 'カウンセリング',
  consent: '同意書',
  pre_visit: '事前問診',
};

export const FORM_STATUS_LABEL: Record<FormStatus, string> = {
  draft: '下書き',
  active: '公開中',
  archived: 'アーカイブ',
};

export const RESPONSE_STATUS_LABEL: Record<FormResponseListItem['status'], string> = {
  pending: '未回答',
  submitted: '提出済',
  voided: '無効',
};
