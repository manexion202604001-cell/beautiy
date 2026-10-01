import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { Errors } from '../../lib/errors.js';
import type { FieldDef } from './schemas.js';

export type FieldValue = string | number | boolean | string[] | null;
export type FieldValues = Record<string, FieldValue>;

const DEFAULT_MAX_LENGTH: Partial<Record<FieldDef['type'], number>> = { text: 500, textarea: 10000, color_formula: 2000 };

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
}

/**
 * Validate dynamic field values (karte fields / form answers) against template definitions.
 *  - unknown keys are rejected (unless listed in allowExtraKeys — e.g. legacy keys of an existing karte)
 *  - required: value must be present; for checkbox it must be true (同意チェック)
 *  - type checks: number range, select/multiselect options, ISO date, string length
 * Returns normalized values (trimmed strings, empty → null, deduped multiselect).
 */
export function validateFieldValues(fields: readonly FieldDef[], values: Record<string, unknown>, opts: { allowExtraKeys?: ReadonlySet<string> } = {}): FieldValues {
  const issues: { path: string; message: string }[] = [];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const out: FieldValues = {};

  for (const [key, value] of Object.entries(values)) {
    if (byKey.has(key)) continue;
    if (opts.allowExtraKeys?.has(key)) out[key] = value as FieldValue;
    else issues.push({ path: key, message: `不明な項目です (${key})` });
  }

  for (const f of fields) {
    const raw = values[f.key];
    const missing = isEmpty(raw) || (f.type === 'checkbox' && f.required && raw !== true);
    if (missing) {
      if (f.required) issues.push({ path: f.key, message: f.type === 'checkbox' ? `「${f.label}」への同意が必要です` : `「${f.label}」は必須です` });
      else if (raw !== undefined) out[f.key] = f.type === 'checkbox' && raw === false ? false : null;
      continue;
    }
    const bad = (message: string) => issues.push({ path: f.key, message: `「${f.label}」${message}` });
    switch (f.type) {
      case 'text':
      case 'textarea':
      case 'color_formula': {
        if (typeof raw !== 'string') {
          bad('は文字列で入力してください');
          break;
        }
        const s = raw.trim();
        const max = f.maxLength ?? DEFAULT_MAX_LENGTH[f.type] ?? 500;
        if (s.length > max) bad(`は${max}文字以内で入力してください`);
        else out[f.key] = s;
        break;
      }
      case 'number': {
        const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
        if (typeof n !== 'number' || !Number.isFinite(n)) bad('は数値で入力してください');
        else if (f.min !== undefined && n < f.min) bad(`は${f.min}以上で入力してください`);
        else if (f.max !== undefined && n > f.max) bad(`は${f.max}以下で入力してください`);
        else out[f.key] = n;
        break;
      }
      case 'select':
        if (typeof raw !== 'string' || !(f.options ?? []).includes(raw)) bad('の選択肢が不正です');
        else out[f.key] = raw;
        break;
      case 'multiselect': {
        if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string' || !(f.options ?? []).includes(x))) bad('の選択肢が不正です');
        else out[f.key] = [...new Set(raw as string[])];
        break;
      }
      case 'checkbox':
        if (typeof raw !== 'boolean') bad('は true / false で指定してください');
        else out[f.key] = raw;
        break;
      case 'date':
        if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !DateTime.fromISO(raw).isValid) bad('はYYYY-MM-DD形式で入力してください');
        else out[f.key] = raw;
        break;
    }
  }
  if (issues.length) throw Errors.validation('入力内容に誤りがあります', { issues });
  return out;
}

/** Template-less karte: free-form keys with primitive values */
export function validateFreeFields(values: Record<string, unknown>): FieldValues {
  const keys = Object.keys(values);
  if (keys.length > 100) throw Errors.validation('項目数が多すぎます');
  const bad = keys.filter((k) => !/^[a-z][a-z0-9_]{0,49}$/.test(k));
  if (bad.length) throw Errors.validation('項目キーは英小文字・数字・_ で指定してください', { keys: bad });
  return values as FieldValues;
}

/** Human readable value for documents / customer views */
export function formatFieldValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join('、');
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ';
  return String(v);
}

/** Deterministic JSON: object keys sorted recursively, undefined dropped (hash input) */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : norm(x)));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

export interface DocumentHashInput {
  templateSnapshot: unknown;
  answers: unknown;
  signatureChecksum: string | null;
  signerName: string | null;
  signedAt: Date | null;
  submittedAt: Date | null;
}

/** Tamper evidence for submitted forms: sha256 over the canonical JSON of the signed content */
export function computeDocumentHash(input: DocumentHashInput): string {
  const payload = canonicalJson({
    v: 1,
    templateSnapshot: input.templateSnapshot,
    answers: input.answers,
    signatureChecksum: input.signatureChecksum,
    signerName: input.signerName,
    signedAt: input.signedAt ? input.signedAt.toISOString() : null,
    submittedAt: input.submittedAt ? input.submittedAt.toISOString() : null,
  });
  return createHash('sha256').update(payload).digest('hex');
}
