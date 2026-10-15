import { useQueryClient } from '@tanstack/react-query';
import { Plus, Store, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { shopAdminApi, useInvalidateShops } from '../../../api/storeSettings';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogTitle,
  Input,
  Label,
} from '../../../components/shad';
import { usePrimaryShopId } from '../../../components/layout/usePrimaryShop';
import { AlertDialog } from '../../../components/shad/alert-dialog';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';

const EMPTY_SHOP = { name: '', address: '', phone: '', email: '' };

/** 店舗一覧: every shop of the organization, with 新しい店舗 / 店舗設定 / delete */
export function StoresTab() {
  const { shops, currentShop, setCurrentShopId, can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const invalidateShops = useInvalidateShops();
  // the signed-in staff member's main shop gets the 「主」 mark
  const primaryShopId = usePrimaryShopId();
  const ownerLevel = can('shop.manage') && can('org.manage');

  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_SHOP);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const createShop = async () => {
    if (!draft.name) return;
    setCreating(true);
    try {
      await shopAdminApi.create({
        name: draft.name.trim(),
        addressLine: draft.address.trim() || null,
        phone: draft.phone.trim() || null,
        email: draft.email.trim() || null,
      });
      setDraft(EMPTY_SHOP);
      setCreateOpen(false);
      // the creator is assigned to the new shop: refresh the shop list and the signed-in profile
      await Promise.all([invalidateShops(), qc.invalidateQueries({ queryKey: ['me'] })]);
    } catch (e) {
      toast.error('店舗の作成に失敗しました', errorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  const deleteShop = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await shopAdminApi.delete(deleteTarget.id);
      setDeleteOpen(false);
      const removedCurrent = currentShop?.id === deleteTarget.id;
      const next = shops.find((s) => s.id !== deleteTarget.id);
      setDeleteTarget(null);
      await Promise.all([
        invalidateShops(),
        qc.invalidateQueries({ queryKey: ['me'] }),
        qc.invalidateQueries({ queryKey: ['staff'] }),
      ]);
      if (removedCurrent && next) setCurrentShopId(next.id);
    } catch (e) {
      toast.error('店舗の削除に失敗しました', errorMessage(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>店舗一覧</CardTitle>
              <CardDescription>オーナーが管理する全店舗</CardDescription>
            </div>
            {ownerLevel ? (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                新しい店舗
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          {shops.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">店舗がありません</div>
          ) : (
            <div className="sy-3">
              {shops.map((shop) => (
                <div
                  key={shop.id}
                  data-testid="shop-row"
                  className="rounded-lg border p-4 transition-colors hover:bg-accent/50"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                        <Store className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{shop.name}</span>
                          {primaryShopId === shop.id ? (
                            <Badge variant="secondary" className="text-xs">
                              主
                            </Badge>
                          ) : null}
                          {currentShop?.id === shop.id ? (
                            <Badge variant="outline" className="text-xs">
                              選択中
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setCurrentShopId(shop.id);
                          navigate('/app/settings');
                        }}
                      >
                        店舗設定
                      </Button>
                      {ownerLevel && shops.length > 1 ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`${shop.name}を削除`}
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget({ id: shop.id, name: shop.name });
                            setDeleteOpen(true);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={
          <>
            <DialogTitle>新しい店舗を作成</DialogTitle>
            <p className="text-sm text-muted-foreground">新しい店舗の情報を入力してください</p>
          </>
        }
      >
        <div className="sy-4 pt-4">
          <div className="sy-2">
            <Label htmlFor="new-shop-name">店舗名 *</Label>
            <Input
              id="new-shop-name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="例: ビューティーサロン 新宿店"
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="new-shop-address">住所</Label>
            <Input
              id="new-shop-address"
              value={draft.address}
              onChange={(e) => setDraft({ ...draft, address: e.target.value })}
              placeholder="例: 東京都新宿区..."
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="sy-2">
              <Label htmlFor="new-shop-phone">電話番号</Label>
              <Input
                id="new-shop-phone"
                value={draft.phone}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                placeholder="03-1234-5678"
              />
            </div>
            <div className="sy-2">
              <Label htmlFor="new-shop-email">メールアドレス</Label>
              <Input
                id="new-shop-email"
                type="email"
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                placeholder="store@example.com"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              キャンセル
            </Button>
            <Button onClick={() => void createShop()} disabled={creating || !draft.name}>
              {creating ? '作成中...' : '作成'}
            </Button>
          </div>
        </div>
      </Dialog>

      <AlertDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="店舗を削除しますか？"
        description={
          <>
            「{deleteTarget?.name}
            」を削除します。この店舗は店舗一覧と予約受付から外れ、スタッフの所属も解除されます。過去の予約・会計・カルテの記録は保持されます。この操作は取り消せません。
          </>
        }
        busy={deleting}
        actionLabel={deleting ? '削除中...' : '削除する'}
        actionClassName="bg-destructive text-destructive-foreground hover:bg-destructive/90"
        onAction={() => void deleteShop()}
      />
    </>
  );
}
