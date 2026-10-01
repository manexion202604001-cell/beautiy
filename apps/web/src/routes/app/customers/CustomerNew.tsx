import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { customerKeys, customersApi } from '../../../api/customers';
import type { DuplicateCandidate } from '../../../api/types';
import { reasonLabel } from '../../../components/appointments/CustomerPicker';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Card,
  Dialog,
  PageHeader,
  useToast,
} from '../../../components/ui';
import { errorMessage, newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDate } from '../../../lib/format';
import { useStableKey } from '../../../lib/hooks';
import { CustomerForm, toInitial } from './CustomerForm';

export default function CustomerNew() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { currentShopId } = useAuth();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dups, setDups] = useState<{ id: string; candidates: DuplicateCandidate[] } | null>(null);
  const [key, regen] = useStableKey(newIdempotencyKey);
  const initial = useMemo(
    () => toInitial(null, { primaryShopId: currentShopId ?? '' }),
    [currentShopId],
  );

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="顧客を新規登録"
        back={
          <Link to="/app/customers" className="text-[13px] text-muted hover:text-fg">
            ← 顧客一覧
          </Link>
        }
      />
      {error ? (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}
      <Card>
        <CustomerForm
          initial={initial}
          isNew
          submitLabel="登録する"
          saving={saving}
          onCancel={() => navigate('/app/customers')}
          onSubmit={async (input) => {
            setSaving(true);
            setError(null);
            try {
              const res = await customersApi.create(input, key);
              regen();
              void qc.invalidateQueries({ queryKey: customerKeys.all });
              toast.success('顧客を登録しました');
              if (res.duplicateCandidates.length)
                setDups({ id: res.customer.id, candidates: res.duplicateCandidates });
              else navigate(`/app/customers/${res.customer.id}`);
            } catch (e) {
              regen();
              setError(errorMessage(e));
            } finally {
              setSaving(false);
            }
          }}
        />
      </Card>

      <Dialog
        open={!!dups}
        onClose={() => dups && navigate(`/app/customers/${dups.id}`)}
        title="重複の可能性がある顧客がいます"
        description="同一人物の場合は、顧客詳細の「重複候補」タブから統合できます。"
        footer={
          <Button variant="primary" onClick={() => dups && navigate(`/app/customers/${dups.id}`)}>
            登録した顧客を開く
          </Button>
        }
      >
        <ul className="space-y-2">
          {dups?.candidates.map((c) => (
            <li
              key={c.customerId}
              className="flex items-center justify-between gap-3 rounded-xl border border-border p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{c.displayName}</p>
                <p className="truncate text-xs text-muted">
                  {[
                    c.phone,
                    c.email,
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
              <ButtonLink size="sm" to={`/app/customers/${dups.id}?tab=duplicates`}>
                確認して統合
              </ButtonLink>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}
