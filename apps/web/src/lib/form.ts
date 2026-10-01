import { useCallback, useState, type FormEvent } from 'react';
import type { z } from 'zod';
import { isApiError } from './api';

export type FieldErrors = Record<string, string>;

/** Convert zod issues into { 'a.b': message } (first message per path) */
export function zodErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.');
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/**
 * Minimal form state with zod validation (no extra dependency).
 *   const f = useZodForm(schema, initial)
 *   <Input value={f.values.name} onChange={(e) => f.set('name', e.target.value)} />
 *   <form onSubmit={f.handleSubmit((data) => mutate(data))}>
 */
export function useZodForm<TIn extends Record<string, unknown>, TOut>(
  schema: z.ZodType<TOut, TIn>,
  initial: TIn,
) {
  const [values, setValues] = useState<TIn>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [dirty, setDirty] = useState(false);

  const set = useCallback(<K extends keyof TIn>(key: K, value: TIn[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setDirty(true);
    setErrors((e) => {
      if (!e[key as string]) return e;
      const next = { ...e };
      delete next[key as string];
      return next;
    });
  }, []);

  const reset = useCallback((next: TIn) => {
    setValues(next);
    setErrors({});
    setDirty(false);
  }, []);

  const validate = useCallback((): TOut | null => {
    const res = schema.safeParse(values);
    if (!res.success) {
      setErrors(zodErrors(res.error));
      return null;
    }
    setErrors({});
    return res.data;
  }, [schema, values]);

  const handleSubmit = useCallback(
    (fn: (data: TOut) => void | Promise<void>) => (e?: FormEvent) => {
      e?.preventDefault();
      const data = validate();
      if (data !== null) void fn(data);
      else {
        // move focus to the first invalid control for keyboard / screen reader users
        window.setTimeout(
          () => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
          0,
        );
      }
    },
    [validate],
  );

  /** Map API validation errors (zod issues from the server) onto fields */
  const applyServerError = useCallback((err: unknown) => {
    if (isApiError(err) && err.category === 'validation') {
      const fe = err.fieldErrors();
      if (Object.keys(fe).length) setErrors(fe);
    }
  }, []);

  return {
    values,
    setValues,
    set,
    errors,
    setErrors,
    reset,
    validate,
    handleSubmit,
    applyServerError,
    dirty,
  };
}

/** '' → undefined helpers for optional inputs */
export const emptyToNull = (v: string | null | undefined) =>
  v === undefined || v === null || v.trim() === '' ? null : v.trim();
export const emptyToUndefined = (v: string | null | undefined) =>
  v === undefined || v === null || v.trim() === '' ? undefined : v.trim();
