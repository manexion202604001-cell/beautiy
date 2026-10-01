import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type KeyboardEvent } from 'react';
import { customerKeys, customersApi } from '../../api/customers';
import type { DuplicateCandidate } from '../../api/types';
import { errorMessage, newIdempotencyKey } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { formatDate } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';
import { Alert, Badge, Button, Field, Icon, Input, Spinner } from '../ui';

export interface PickedCustomer {
  id: string;
  name: string;
  kana?: string;
  phone?: string | null;
  visitCount?: number;
}

const REASON_LABEL: Record<string, string> = {
  phone_exact: '電話番号が一致',
  email_exact: 'メールが一致',
  name_exact: '氏名が一致',
  birthday_exact: '生年月日が一致',
  kana_similar: 'フリガナが類似',
  name_similar: '氏名が類似',
  phone_tail: '電話番号下4桁が一致',
};

export function reasonLabel(r: string) {
  return REASON_LABEL[r] ?? r;
}

/** Customer typeahead (combobox) with inline quick registration + duplicate suggestions */
export function CustomerPicker({
  value,
  onChange,
  error,
}: {
  value: PickedCustomer | null;
  onChange: (c: PickedCustomer | null) => void;
  error?: string;
}) {
  const { can, currentShopId } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    lastName: '',
    firstName: '',
    lastNameKana: '',
    firstNameKana: '',
    phone: '',
  });
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dups, setDups] = useState<{
    created: PickedCustomer;
    candidates: DuplicateCandidate[];
  } | null>(null);
  const listId = useId();
  const inputId = useId();
  const debounced = useDebounced(q.trim(), 250);

  const results = useQuery({
    queryKey: customerKeys.search({ q: debounced, limit: 8 }),
    queryFn: () => customersApi.search({ q: debounced, limit: 8, sort: 'last_visit' }),
    enabled: debounced.length >= 1 && !value,
  });
  const items = results.data?.items ?? [];

  const pick = (c: PickedCustomer) => {
    onChange(c);
    setOpen(false);
    setQ('');
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open && e.key === 'ArrowDown') setOpen(true);
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      const c = items[active];
      if (c)
        pick({
          id: c.id,
          name: c.display_name,
          kana: `${c.last_name_kana} ${c.first_name_kana}`.trim(),
          phone: c.phone,
          visitCount: c.visit_count,
        });
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const create = async () => {
    setCreateErr(null);
    if (!(form.lastName + form.firstName + form.lastNameKana + form.firstNameKana).trim()) {
      setCreateErr('氏名またはフリガナを入力してください');
      return;
    }
    setSaving(true);
    try {
      const res = await customersApi.create(
        {
          lastName: form.lastName.trim(),
          firstName: form.firstName.trim(),
          lastNameKana: form.lastNameKana.trim(),
          firstNameKana: form.firstNameKana.trim(),
          phone: form.phone.trim() || null,
          primaryShopId: currentShopId,
          acquisitionSource: 'phone',
        },
        newIdempotencyKey(),
      );
      void qc.invalidateQueries({ queryKey: customerKeys.all });
      const created: PickedCustomer = {
        id: res.customer.id,
        name: res.customer.display_name,
        phone: res.customer.phone,
        visitCount: 0,
      };
      if (res.duplicateCandidates.length) setDups({ created, candidates: res.duplicateCandidates });
      else {
        pick(created);
        setCreating(false);
      }
    } catch (e) {
      setCreateErr(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (value) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/60 px-3 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">
            {value.name || '（氏名未登録）'}
            {value.visitCount === 0 ? (
              <Badge tone="info" size="sm" className="ml-2">
                新規
              </Badge>
            ) : null}
          </p>
          <p className="truncate text-xs text-muted">
            {[value.kana, value.phone].filter(Boolean).join(' ・ ') || '連絡先未登録'}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
          変更
        </Button>
      </div>
    );
  }

  if (dups) {
    return (
      <div className="space-y-3 rounded-xl border border-warning/40 bg-warning-soft/40 p-3">
        <Alert tone="warning" title="重複の可能性がある顧客が見つかりました">
          既存の顧客を選ぶか、新しく登録した顧客のまま進めてください（後から名寄せで統合できます）。
        </Alert>
        <ul className="space-y-1.5">
          {dups.candidates.map((c) => (
            <li
              key={c.customerId}
              className="flex items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{c.displayName}</p>
                <p className="truncate text-xs text-muted">
                  {[
                    c.phone,
                    c.birthday && formatDate(c.birthday, undefined, { weekday: false }),
                    `来店${c.visitCount}回`,
                  ]
                    .filter(Boolean)
                    .join(' ・ ')}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {c.reasons.map((r) => (
                    <Badge key={r} size="sm" tone={c.strength === 'exact' ? 'danger' : 'warning'}>
                      {reasonLabel(r)}
                    </Badge>
                  ))}
                </div>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  pick({
                    id: c.customerId,
                    name: c.displayName,
                    phone: c.phone,
                    visitCount: c.visitCount,
                  });
                  setDups(null);
                  setCreating(false);
                }}
              >
                この顧客を使う
              </Button>
            </li>
          ))}
        </ul>
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            pick(dups.created);
            setDups(null);
            setCreating(false);
          }}
        >
          新規登録した顧客で進める
        </Button>
      </div>
    );
  }

  if (creating) {
    return (
      <div className="space-y-3 rounded-xl border border-border p-3">
        <div className="flex items-center justify-between">
          <p className="text-[13px] font-semibold">新規顧客を登録</p>
          <Button size="xs" variant="ghost" onClick={() => setCreating(false)}>
            検索に戻る
          </Button>
        </div>
        {createErr ? <Alert tone="danger">{createErr}</Alert> : null}
        <div className="grid grid-cols-2 gap-2">
          <Field label="姓">
            <Input
              value={form.lastName}
              onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              autoComplete="off"
            />
          </Field>
          <Field label="名">
            <Input
              value={form.firstName}
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              autoComplete="off"
            />
          </Field>
          <Field label="セイ">
            <Input
              value={form.lastNameKana}
              onChange={(e) => setForm({ ...form, lastNameKana: e.target.value })}
              autoComplete="off"
            />
          </Field>
          <Field label="メイ">
            <Input
              value={form.firstNameKana}
              onChange={(e) => setForm({ ...form, firstNameKana: e.target.value })}
              autoComplete="off"
            />
          </Field>
          <Field label="電話番号" className="col-span-2">
            <Input
              type="tel"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              autoComplete="off"
            />
          </Field>
        </div>
        <Button variant="primary" size="sm" onClick={create} loading={saving}>
          登録して選択
        </Button>
      </div>
    );
  }

  const showList = open && debounced.length >= 1;
  return (
    <div className="relative">
      <label htmlFor={inputId} className="sr-only">
        顧客を検索
      </label>
      <Input
        id={inputId}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          showList && items[active] ? `${listId}-${items[active]!.id}` : undefined
        }
        aria-invalid={error ? true : undefined}
        invalid={!!error}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKey}
        placeholder="氏名・フリガナ・電話番号で検索"
        leading={<Icon name="search" size={16} />}
        trailing={results.isFetching ? <Spinner size={14} /> : undefined}
        autoComplete="off"
      />
      {error ? <p className="mt-1 text-xs font-medium text-danger">{error}</p> : null}
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-card"
        >
          {items.map((c, i) => (
            <li
              key={c.id}
              id={`${listId}-${c.id}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() =>
                pick({
                  id: c.id,
                  name: c.display_name,
                  kana: `${c.last_name_kana} ${c.first_name_kana}`.trim(),
                  phone: c.phone,
                  visitCount: c.visit_count,
                })
              }
              className={cn('cursor-pointer px-3 py-2', i === active && 'bg-surface-2')}
            >
              <p className="text-sm font-medium text-fg">{c.display_name || '（氏名未登録）'}</p>
              <p className="text-xs text-muted">
                {[
                  `${c.last_name_kana} ${c.first_name_kana}`.trim(),
                  c.phone,
                  c.last_visit_at
                    ? `最終 ${formatDate(c.last_visit_at, undefined, { weekday: false })}`
                    : '来店履歴なし',
                ]
                  .filter(Boolean)
                  .join(' ・ ')}
              </p>
            </li>
          ))}
          {!results.isFetching && items.length === 0 ? (
            <li className="px-3 py-2 text-[13px] text-muted">該当する顧客が見つかりません</li>
          ) : null}
        </ul>
      ) : null}
      {can('customer.write') ? (
        <button
          type="button"
          className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline"
          onClick={() => setCreating(true)}
        >
          <Icon name="plus" size={14} />
          新規顧客を登録
        </button>
      ) : null}
    </div>
  );
}
