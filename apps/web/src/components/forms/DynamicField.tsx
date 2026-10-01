import { useId } from 'react';
import type { FieldDef, FieldValue, FieldValues } from '../../api/kartes';
import { cn } from '../../lib/cn';
import { Checkbox, Field, Input, Select, Textarea } from '../ui';

/**
 * Renders one template-driven field (karte templates / counseling & consent forms).
 * Supported types: text / textarea / number / select / multiselect / checkbox / date
 * (color_formula is edited as multi-line text).
 */
export function DynamicField({
  field,
  value,
  onChange,
  error,
  disabled,
  size = 'md',
}: {
  field: FieldDef;
  value: FieldValue | undefined;
  onChange: (v: FieldValue) => void;
  error?: string | null;
  disabled?: boolean;
  size?: 'md' | 'lg';
}) {
  const groupId = useId();
  const hint = field.helpText;
  switch (field.type) {
    case 'textarea':
    case 'color_formula':
      return (
        <Field label={field.label} required={field.required} hint={hint} error={error}>
          <Textarea
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            rows={field.type === 'color_formula' ? 3 : 4}
            maxLength={field.maxLength}
            disabled={disabled}
            placeholder={
              field.type === 'color_formula' ? '例: 8Lv ブラウン 1:1 OX6% 20分' : undefined
            }
            className={size === 'lg' ? 'text-base' : undefined}
          />
        </Field>
      );
    case 'number':
      return (
        <Field label={field.label} required={field.required} hint={hint} error={error}>
          <Input
            type="number"
            inputMode="decimal"
            value={
              typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''
            }
            min={field.min}
            max={field.max}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
            disabled={disabled}
            inputSize={size}
          />
        </Field>
      );
    case 'date':
      return (
        <Field label={field.label} required={field.required} hint={hint} error={error}>
          <Input
            type="date"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value || null)}
            disabled={disabled}
            inputSize={size}
          />
        </Field>
      );
    case 'select':
      return (
        <Field label={field.label} required={field.required} hint={hint} error={error}>
          <Select
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value || null)}
            disabled={disabled}
          >
            <option value="">選択してください</option>
            {(field.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </Field>
      );
    case 'multiselect': {
      const selected = Array.isArray(value) ? value : [];
      return (
        <fieldset
          className="flex flex-col gap-1.5"
          aria-describedby={error ? `${groupId}-error` : hint ? `${groupId}-hint` : undefined}
          aria-invalid={error ? true : undefined}
        >
          <legend className="mb-1.5 text-[13px] font-medium text-fg">
            {field.label}
            {field.required ? (
              <span className="ml-1 text-danger" aria-hidden>
                *
              </span>
            ) : null}
          </legend>
          <div className="flex flex-wrap gap-2">
            {(field.options ?? []).map((o) => {
              const on = selected.includes(o);
              return (
                <button
                  key={o}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  disabled={disabled}
                  onClick={() => onChange(on ? selected.filter((x) => x !== o) : [...selected, o])}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-[13px] transition-colors disabled:opacity-50',
                    size === 'lg' && 'px-4 py-2 text-sm',
                    on
                      ? 'border-primary bg-primary-soft font-medium text-primary'
                      : 'border-border bg-surface text-fg hover:border-border-strong',
                  )}
                >
                  {on ? '✓ ' : ''}
                  {o}
                </button>
              );
            })}
          </div>
          {hint && !error ? (
            <p id={`${groupId}-hint`} className="text-xs text-muted">
              {hint}
            </p>
          ) : null}
          {error ? (
            <p id={`${groupId}-error`} className="text-xs font-medium text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </fieldset>
      );
    }
    case 'checkbox':
      return (
        <div>
          <Checkbox
            label={
              <>
                {field.label}
                {field.required ? <span className="ml-1 text-danger">*</span> : null}
              </>
            }
            description={hint}
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
          />
          {error ? (
            <p className="mt-1 text-xs font-medium text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      );
    case 'text':
    default:
      return (
        <Field label={field.label} required={field.required} hint={hint} error={error}>
          <Input
            value={
              typeof value === 'string'
                ? value
                : value === null || value === undefined
                  ? ''
                  : String(value)
            }
            onChange={(e) => onChange(e.target.value)}
            maxLength={field.maxLength}
            disabled={disabled}
            inputSize={size}
          />
        </Field>
      );
  }
}

function isEmpty(v: FieldValue | undefined): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** Client-side validation mirroring the API (required, number range, max length) */
export function validateFields(fields: FieldDef[], values: FieldValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.required) {
      if (f.type === 'checkbox' ? v !== true : isEmpty(v)) {
        errors[f.key] = f.type === 'checkbox' ? '確認してチェックしてください' : '入力してください';
        continue;
      }
    }
    if (isEmpty(v)) continue;
    if (f.type === 'number') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) errors[f.key] = '数値で入力してください';
      else if (f.min !== undefined && n < f.min) errors[f.key] = `${f.min}以上で入力してください`;
      else if (f.max !== undefined && n > f.max) errors[f.key] = `${f.max}以下で入力してください`;
    }
    if (typeof v === 'string' && f.maxLength && v.length > f.maxLength) {
      errors[f.key] = `${f.maxLength}文字以内で入力してください`;
    }
  }
  return errors;
}

/** Remove empty values before sending (the API treats missing keys as unanswered) */
export function compactValues(fields: FieldDef[], values: FieldValues): FieldValues {
  const out: FieldValues = {};
  for (const f of fields) {
    const v = values[f.key];
    if (isEmpty(v)) continue;
    out[f.key] = typeof v === 'string' ? v.trim() : v!;
  }
  return out;
}

/** Map API field errors ("fields.key" / "answers.key" / "key") onto field keys */
export function fieldErrorsFromApi(
  fe: Record<string, string>,
  prefix?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fe)) {
    const key = prefix && k.startsWith(`${prefix}.`) ? k.slice(prefix.length + 1) : k;
    out[key] = v;
  }
  return out;
}
