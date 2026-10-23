import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useShop, useUpdateShop, type ShopInput } from '../../../api/org';
import { equipmentApi, equipmentKeys, useEquipment, type Equipment } from '../../../api/storeSettings';
import type { Shop } from '../../../api/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Separator,
  Tabs,
} from '../../../components/shad';
import { Switch } from '../../../components/shad/switch';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { addressOf, splitAddress } from './address';
import { SalonboardSettingsCard } from './SalonboardSettingsCard';

type Tab = 'store' | 'salonboard' | 'equipment';

const PANEL =
  'mt-6 ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** 店舗設定: shop profile, seat alert, サロンボード連携 and equipment of the selected shop */
export default function StoreSettings() {
  const { currentShopId } = useAuth();
  const shopQ = useShop(currentShopId);
  const [tab, setTab] = useState<Tab>('store');
  // the equipment list is fetched the first time its tab is opened
  const [equipmentOpened, setEquipmentOpened] = useState(false);

  if (shopQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }
  const shop = shopQ.data;
  if (!shop) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <div className="text-muted-foreground">店舗情報が見つかりません</div>
      </div>
    );
  }

  return (
    <div className="sy-6">
      <h1 className="text-2xl font-bold">店舗設定</h1>
      <div>
        <Tabs<Tab>
          label="店舗設定"
          value={tab}
          onValueChange={(t) => {
            setTab(t);
            if (t === 'equipment') setEquipmentOpened(true);
          }}
          listClassName="flex h-auto w-full flex-wrap gap-1"
          items={[
            { value: 'store', label: '店舗情報' },
            { value: 'salonboard', label: 'サロンボード' },
            { value: 'equipment', label: '設備' },
          ]}
        />
        {tab === 'store' ? (
          <div role="tabpanel" className={PANEL}>
            <StoreInfoCard key={shop.id} shop={shop} />
          </div>
        ) : null}
        {tab === 'salonboard' ? (
          <div role="tabpanel" className={PANEL}>
            <SalonboardSettingsCard key={shop.id} shopId={shop.id} />
          </div>
        ) : null}
        {tab === 'equipment' ? (
          <div role="tabpanel" className={PANEL}>
            <EquipmentCard key={shop.id} shopId={shop.id} enabled={equipmentOpened} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StoreInfoCard({ shop }: { shop: Shop }) {
  const { can } = useAuth();
  const toast = useToast();
  const update = useUpdateShop();
  const editable = can('shop.manage');
  const [form, setForm] = useState({
    name: shop.name || '',
    postal_code: shop.postal_code || '',
    address: addressOf(shop),
    phone: shop.phone || '',
    email: shop.email || '',
    seat_limit: shop.settings.seats?.limit || 0,
    enable_seat_alert: shop.settings.seats?.alertEnabled === true,
  });
  const saving = update.isPending;

  const save = () => {
    if (form.enable_seat_alert && form.seat_limit < 1) {
      toast.error('店舗情報の保存に失敗しました', '同時最大予約数を入力してください');
      return;
    }
    const input: ShopInput = {
      name: form.name.trim(),
      postalCode: form.postal_code.trim() || null,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      settings: { seats: { alertEnabled: form.enable_seat_alert, limit: form.seat_limit } },
      // the three address columns are rewritten only when the line was edited
      ...(form.address.trim() !== addressOf(shop) ? splitAddress(form.address, shop) : {}),
    };
    update.mutate(
      { id: shop.id, input },
      { onError: (e) => toast.error('店舗情報の保存に失敗しました', errorMessage(e)) },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>店舗情報</CardTitle>
        <CardDescription>店舗の基本情報を設定します</CardDescription>
      </CardHeader>
      <CardContent className="sy-4">
        <div className="sy-2">
          <Label htmlFor="store-name">店舗名</Label>
          <Input
            id="store-name"
            value={form.name}
            disabled={!editable}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div className="sy-2">
          <Label htmlFor="store-postal-code">郵便番号</Label>
          <Input
            id="store-postal-code"
            value={form.postal_code}
            disabled={!editable}
            onChange={(e) => setForm({ ...form, postal_code: e.target.value })}
            placeholder="123-4567"
          />
        </div>
        <div className="sy-2">
          <Label htmlFor="store-address">住所</Label>
          <Input
            id="store-address"
            value={form.address}
            disabled={!editable}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="sy-2">
            <Label htmlFor="store-phone">電話番号</Label>
            <Input
              id="store-phone"
              value={form.phone}
              disabled={!editable}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="store-email">メールアドレス</Label>
            <Input
              id="store-email"
              type="email"
              value={form.email}
              disabled={!editable}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
        </div>
        <Separator />
        <div className="sy-3">
          <Label className="text-base">席数アラート</Label>
          <p className="text-sm text-muted-foreground">
            同時刻に受付可能な予約数の上限を設定します。上限を超えた場合、予約作成がブロックされます。
          </p>
          <div className="flex items-center gap-2">
            <Switch
              id="seat-alert"
              checked={form.enable_seat_alert}
              disabled={!editable}
              onCheckedChange={(v) => setForm({ ...form, enable_seat_alert: v })}
            />
            <Label htmlFor="seat-alert">席数超過時に予約作成をブロックする</Label>
          </div>
          {form.enable_seat_alert ? (
            <div className="sy-2">
              <Label htmlFor="seat-limit">同時最大予約数</Label>
              <Input
                id="seat-limit"
                type="number"
                min={1}
                value={form.seat_limit || ''}
                disabled={!editable}
                onChange={(e) => setForm({ ...form, seat_limit: parseInt(e.target.value) || 0 })}
                placeholder="例: 5"
                className="w-32"
              />
            </div>
          ) : null}
        </div>
        <Separator />
        <Button onClick={save} disabled={saving || !editable}>
          {saving ? '保存中...' : '保存'}
        </Button>
      </CardContent>
    </Card>
  );
}

/** Names of the equipment types the previous resource screen offered as presets */
const PRESET_LABEL: Record<string, string> = {
  spa_bed: 'スパベッド',
  shampoo: 'シャンプー台',
  chair: 'セット面',
  room: '個室',
};
const labelOf = (name: string) => PRESET_LABEL[name] ?? name;

interface EditingEquipment {
  /** stored name (the key the update is addressed to) */
  key: string;
  name: string;
  quantity: number;
  isActive: boolean;
}

function EquipmentCard({ shopId, enabled }: { shopId: string; enabled: boolean }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const editable = can('menu.manage');
  const listQ = useEquipment(shopId, true, enabled);
  const equipment = listQ.data ?? [];
  const [draft, setDraft] = useState({ name: '', quantity: 1 });
  const [editing, setEditing] = useState<EditingEquipment | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = () => qc.invalidateQueries({ queryKey: equipmentKeys.all });

  const add = async () => {
    if (!draft.name.trim()) return;
    setSaving(true);
    try {
      await equipmentApi.create({ shopId, name: draft.name.trim(), quantity: draft.quantity });
      setDraft({ name: '', quantity: 1 });
      await reload();
    } catch (e) {
      toast.error('設備の追加に失敗しました', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const name = editing.name.trim();
      await equipmentApi.update({
        shopId,
        name: editing.key,
        // a preset shown under its Japanese label is renamed only when the text was changed
        newName: name && name !== labelOf(editing.key) ? name : undefined,
        quantity: editing.quantity,
        isActive: editing.isActive,
      });
      setEditing(null);
      await reload();
    } catch (e) {
      toast.error('設備の更新に失敗しました', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: Equipment) => {
    if (!window.confirm('この設備を削除しますか？')) return;
    try {
      await equipmentApi.delete(shopId, item.name);
      await reload();
    } catch (e) {
      toast.error('設備の削除に失敗しました', errorMessage(e));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>設備管理</CardTitle>
        <CardDescription>
          メニューに紐づける設備を管理します。数量を設定すると、同時間帯に予約が設備数を超えないよう制御されます。
        </CardDescription>
      </CardHeader>
      <CardContent className="sy-6">
        <div className="flex items-end gap-3">
          <div className="flex-1 sy-2">
            <Label htmlFor="equipment-name">設備名</Label>
            <Input
              id="equipment-name"
              value={draft.name}
              disabled={!editable}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="例: シャンプー台"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && draft.name.trim()) void add();
              }}
            />
          </div>
          <div className="w-24 sy-2">
            <Label htmlFor="equipment-quantity">数量</Label>
            <Input
              id="equipment-quantity"
              type="number"
              min={1}
              value={draft.quantity}
              disabled={!editable}
              onChange={(e) => setDraft({ ...draft, quantity: parseInt(e.target.value) || 1 })}
            />
          </div>
          <Button onClick={() => void add()} disabled={saving || !draft.name.trim() || !editable}>
            <Plus className="mr-1 h-4 w-4" />
            追加
          </Button>
        </div>
        <Separator />
        {listQ.isLoading ? (
          <div className="py-4 text-center text-muted-foreground">読み込み中...</div>
        ) : listQ.isError ? (
          <div className="py-8 text-center text-destructive">{errorMessage(listQ.error)}</div>
        ) : equipment.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">設備がまだ登録されていません</div>
        ) : (
          <div className="sy-2">
            {equipment.map((item) => (
              <div
                key={item.name}
                data-testid="equipment-row"
                className="flex items-center justify-between rounded-lg border p-3"
              >
                {editing?.key === item.name ? (
                  <div className="flex flex-1 items-center gap-3">
                    <Input
                      aria-label="設備名"
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      className="flex-1"
                    />
                    <Input
                      aria-label="数量"
                      type="number"
                      min={1}
                      value={editing.quantity}
                      onChange={(e) =>
                        setEditing({ ...editing, quantity: parseInt(e.target.value) || 1 })
                      }
                      className="w-20"
                    />
                    <div className="flex items-center gap-2">
                      <Switch
                        aria-label="有効"
                        checked={editing.isActive}
                        onCheckedChange={(v) => setEditing({ ...editing, isActive: v })}
                      />
                      <span className="text-xs text-muted-foreground">有効</span>
                    </div>
                    <Button size="sm" onClick={() => void saveEdit()} disabled={saving}>
                      保存
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      取消
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <span
                        className={
                          item.isActive ? 'font-medium' : 'text-muted-foreground line-through'
                        }
                      >
                        {labelOf(item.name)}
                      </span>
                      <span className="text-sm text-muted-foreground">{item.quantity}台</span>
                      {item.isActive ? null : (
                        <span className="text-xs text-destructive">無効</span>
                      )}
                    </div>
                    {editable ? (
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="編集"
                          onClick={() =>
                            setEditing({
                              key: item.name,
                              name: labelOf(item.name),
                              quantity: item.quantity,
                              isActive: item.isActive,
                            })
                          }
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="削除"
                          className="text-destructive"
                          onClick={() => void remove(item)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
