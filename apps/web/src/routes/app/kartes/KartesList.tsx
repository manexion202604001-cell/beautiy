import { useState } from 'react';
import { useKartes } from '../../../api/kartes';
import { useStaffList } from '../../../api/org';
import {
  CustomerPicker,
  type PickedCustomer,
} from '../../../components/appointments/CustomerPicker';
import {
  ButtonLink,
  EmptyState,
  ErrorState,
  Field,
  InlineLoading,
  Input,
  LoadMore,
  PageHeader,
  Select,
} from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { KarteCard } from './KarteCard';

export default function KartesList() {
  const { currentShopId: shopId, can, timezone: tz } = useAuth();
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [staffId, setStaffId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const staff = useStaffList({ shopId: shopId ?? undefined });
  const q = useKartes({
    customerId: customer?.id,
    shopId: customer ? undefined : (shopId ?? undefined),
    staffId: staffId || undefined,
    from: from || undefined,
    to: to || undefined,
    limit: 30,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="カルテ"
        description="最近のカルテ（来店日順）"
        actions={
          <>
            {can('form.manage') || can('karte.read') ? (
              <ButtonLink to="/app/kartes/forms" size="sm" icon="file">
                問診・同意書フォーム
              </ButtonLink>
            ) : null}
            {can('karte.write') ? (
              <ButtonLink
                to={customer ? `/app/kartes/new?customerId=${customer.id}` : '/app/kartes/new'}
                size="sm"
                variant="primary"
                icon="plus"
              >
                新しいカルテ
              </ButtonLink>
            ) : null}
          </>
        }
      />
      <div
        className="mb-4 grid gap-3 rounded-2xl border border-border bg-surface p-4 md:grid-cols-[2fr_1fr_1fr_1fr]"
        role="search"
        aria-label="カルテの絞り込み"
      >
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-fg" aria-hidden>
            お客様
          </p>
          <CustomerPicker value={customer} onChange={setCustomer} />
        </div>
        <Field label="担当">
          <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">すべて</option>
            {(staff.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="来店日（から）">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="来店日（まで）">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !rows.length ? (
        <EmptyState
          icon="file"
          title="カルテはまだありません"
          description="予約の詳細や顧客詳細から作成できます。"
        />
      ) : null}
      <ul className="grid gap-3 md:grid-cols-2">
        {rows.map((k) => (
          <KarteCard key={k.id} k={k} tz={tz} showCustomer={!customer} />
        ))}
      </ul>
      <LoadMore
        hasMore={!!q.hasNextPage}
        loading={q.isFetchingNextPage}
        onClick={() => void q.fetchNextPage()}
      />
    </div>
  );
}
