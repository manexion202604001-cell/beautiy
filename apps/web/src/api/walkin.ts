import { useInfiniteQuery } from '@tanstack/react-query';
import { api, newIdempotencyKey } from '../lib/api';
import type { FormKind } from './forms';
import type { CounselingSheetData, FieldDef, FieldValues } from './kartes';
import type { Page } from './types';

/** Walk-in intakes (同意書一覧・受付保留): consents submitted at reception without a reservation. */

export type WalkinStatus = 'pending' | 'linked' | 'created' | 'discarded';

export interface WalkinIntakeListItem {
  id: string;
  shop_id: string;
  status: WalkinStatus;
  customer_id: string | null;
  customer_name: string;
  customer_name_kana: string;
  customer_phone: string | null;
  /** YYYY-MM-DD */
  customer_birthday: string | null;
  staff_id: string | null;
  staff_name: string | null;
  has_counseling: boolean;
  consent_submitted_at: string;
  /** filled inside LINE (LIFF) */
  line?: { display_name: string | null } | null;
}

export interface WalkinConsentSnapshot {
  title: string;
  version: number;
  body_markdown: string | null;
  /** the consent form's own questions (the customer's details are separate columns) */
  fields: FieldDef[];
  answers: FieldValues;
  agreed_at: string;
  signer_name: string | null;
  document_hash: string;
  signature: { url: string; expiresAt: string; contentType: string } | null;
}

export interface WalkinIntakeDetail extends WalkinIntakeListItem {
  customer_occupation: string | null;
  customer_visit_reason: string | null;
  consent_snapshot: WalkinConsentSnapshot;
  /** counselling sheet filled after the consent: { <category id>: { <question id>: answer } } */
  counseling_data: CounselingSheetData | null;
  counseling_submitted_at: string | null;
}

export interface WalkinResolveResult {
  ok: true;
  intakeId: string;
  customerId: string;
  consentResponseId: string;
  /** counselling categories written onto the customer's sheet */
  counselingCategories: string[];
}

export interface ReceptionLink {
  url: string;
  shop: { id: string; name: string; slug: string; open: boolean };
  staff: { id: string; name: string } | null;
  consentForms: { lineageId: string; templateId: string; name: string; version: number; url: string }[];
  /** LIFF ID the QR opens in LINE with; null = reception without LINE linking */
  liffId: string | null;
}

export interface PublicWalkinForm {
  templateId: string;
  lineageId: string;
  kind: FormKind;
  name: string;
  version: number;
  fields: FieldDef[];
  bodyMarkdown: string | null;
  requiresSignature: boolean;
}

export interface PublicWalkinView {
  shop: { name: string };
  staff: { id: string; name: string } | null;
  consent: PublicWalkinForm | null;
}

export interface PublicWalkinCustomer {
  lastName: string;
  firstName: string;
  lastNameKana: string;
  firstNameKana: string;
  birthday: string;
  phone: string;
  occupation?: string | null;
  visitReason?: string | null;
}

const none = { auth: 'none' as const };

export const walkinApi = {
  list: (q: { shopId: string; q?: string; status?: WalkinStatus; cursor?: string; limit?: number }) =>
    api.get<Page<WalkinIntakeListItem>>('/walkin-intakes', { ...q }),
  get: (id: string) => api.get<{ intake: WalkinIntakeDetail }>(`/walkin-intakes/${id}`),
  link: (id: string, customerId: string, key = newIdempotencyKey()) =>
    api.post<WalkinResolveResult & { filled: string[] }>(
      `/walkin-intakes/${id}/link`,
      { customerId },
      { idempotencyKey: key },
    ),
  create: (id: string, key = newIdempotencyKey()) =>
    api.post<WalkinResolveResult>(`/walkin-intakes/${id}/create`, {}, { idempotencyKey: key }),
  discard: (id: string) => api.post<{ ok: true; intakeId: string }>(`/walkin-intakes/${id}/discard`),
  receptionLink: (q: { shopId: string; staffId?: string }) =>
    api.get<ReceptionLink>('/walkin-intakes/reception-link', { ...q }),

  // customer-facing (reception QR)
  publicView: (slug: string, q: { staff?: string; form?: string }) =>
    api.get<PublicWalkinView>(`/public/walkin/${encodeURIComponent(slug)}`, { ...q }, none),
  publicSubmit: (
    slug: string,
    input: {
      staffId?: string | null;
      templateId: string;
      customer: PublicWalkinCustomer;
      agreed: true;
      answers: FieldValues;
      signature?: { dataUrl: string; signerName: string };
      /** LIFF id token when the page runs inside LINE: links the LINE user to the customer */
      lineIdToken?: string;
    },
  ) =>
    api.post<{ ok: true; intakeId: string; submittedAt: string; token: string; expiresAt: string; line?: boolean }>(
      `/public/walkin/${encodeURIComponent(slug)}`,
      input,
      none,
    ),
  /** counselling sheet after the consent; categories sent again replace what was sent before */
  publicCounseling: (token: string, data: CounselingSheetData) =>
    api.post<{ ok: true; intakeId: string; categories: string[]; submittedAt: string }>(
      `/public/walkin-intakes/${encodeURIComponent(token)}/counseling`,
      { data },
      none,
    ),
};

export const walkinKeys = {
  all: ['walkin-intakes'] as const,
  list: (q: object) => ['walkin-intakes', 'list', q] as const,
  receptionLink: (q: object) => ['walkin-intakes', 'reception-link', q] as const,
};

export function useWalkinIntakes(q: { shopId: string | null; q?: string }, enabled = true) {
  return useInfiniteQuery({
    queryKey: walkinKeys.list(q),
    queryFn: ({ pageParam }) => walkinApi.list({ shopId: q.shopId!, q: q.q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: enabled && !!q.shopId,
    // customers submit from their own phones: keep the reception list fresh
    refetchInterval: 20_000,
  });
}

/** One block of a consent text: a heading with bullet items and/or free text */
export interface ConsentSection {
  title: string;
  items: string[];
  content: string;
}

/**
 * Split a consent body into titled sections. Lines starting with `#` (any level) start a section,
 * `- ` / `・` lines are its bullet items, everything else is free text. A body without headings
 * is one untitled section.
 */
export function consentSections(body: string | null | undefined): ConsentSection[] {
  const out: ConsentSection[] = [];
  let cur: ConsentSection | null = null;
  const text: string[] = [];
  const flush = () => {
    if (!cur) return;
    cur.content = text.join('\n').trim();
    text.length = 0;
    if (cur.title || cur.items.length || cur.content) out.push(cur);
    cur = null;
  };
  for (const raw of (body ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      cur = { title: heading[1]!.trim(), items: [], content: '' };
      continue;
    }
    cur ??= { title: '', items: [], content: '' };
    const bullet = /^\s*(?:[-*]\s+|・\s*)(.+)$/.exec(line);
    if (bullet && !text.some((t) => t.trim())) cur.items.push(bullet[1]!.trim());
    else text.push(line);
  }
  flush();
  return out;
}
