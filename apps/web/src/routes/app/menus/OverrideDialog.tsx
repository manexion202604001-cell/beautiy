import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { catalogApi, catalogKeys } from '../../../api/catalog';
import type { EffectiveMenu } from '../../../api/types';
import { Alert, Button, Dialog, Field, Input, Switch, useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDuration, formatYen } from '../../../lib/format';

/** 店舗別上書き: price / duration / availability of a common menu for the current shop */
export function OverrideDialog({
  shopId,
  menu,
  onClose,
}: {
  shopId: string;
  menu: EffectiveMenu;
  onClose: () => void;
}) {
  const { currentShop } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({
    queryKey: catalogKeys.menu(menu.id),
    queryFn: () => catalogApi.menu(menu.id),
  });
  const existing = detail.data?.overrides.find((o) => o.shop_id === shopId);
  const [price, setPrice] = useState('');
  const [duration, setDuration] = useState('');
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!detail.data) return;
    setPrice(existing?.price != null ? String(existing.price) : '');
    setDuration(existing?.duration_min != null ? String(existing.duration_min) : '');
    setAvailable(existing?.is_available ?? true);
  }, [detail.data, existing]);

  const done = (msg: string) => {
    void qc.invalidateQueries({ queryKey: catalogKeys.all });
    toast.success(msg);
    onClose();
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await catalogApi.setOverride(menu.id, shopId, {
        price: price === '' ? null : Number(price),
        durationMin: duration === '' ? null : Number(duration),
        isAvailable: available,
      });
      done('店舗別設定を保存しました');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const reset = async () => {
    setSaving(true);
    try {
      await catalogApi.deleteOverride(menu.id, shopId);
      done('共通設定に戻しました');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const base = detail.data;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`店舗別設定: ${menu.name}`}
      description={`${currentShop?.name ?? 'この店舗'} だけの価格・所要時間・提供可否を設定します。空欄は共通設定を使います。`}
      footer={
        <>
          {existing ? (
            <Button variant="ghost" onClick={reset} disabled={saving} className="mr-auto">
              共通設定に戻す
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={!base}>
            保存
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}
      <div className="space-y-4">
        <Switch
          checked={available}
          onChange={setAvailable}
          label="この店舗で提供する"
          description="オフにすると、この店舗のメニュー一覧・予約画面に表示されません。"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="料金" hint={base ? `共通: ${formatYen(base.price)}` : undefined}>
            <Input
              type="number"
              min={0}
              step={10}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              leading="¥"
              placeholder="共通設定"
            />
          </Field>
          <Field
            label="所要時間"
            hint={base ? `共通: ${formatDuration(base.duration_min)}` : undefined}
          >
            <Input
              type="number"
              min={5}
              max={720}
              step={5}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              trailing="分"
              placeholder="共通設定"
            />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
