"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { stores, reservations as reservationsApi, equipment as equipmentApi, type Store, type Equipment } from "@/lib/api";
import { Plus, Pencil } from "lucide-react";
import { useStore } from "@/contexts/store-context";

export default function StoreSettingsPage() {
  const { currentStore: selectedStore, refreshStores } = useStore();
  const [store, setStore] = useState<Store | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [storeForm, setStoreForm] = useState({
    name: "",
    postal_code: "",
    address: "",
    phone: "",
    email: "",
    seat_limit: 0,
    enable_seat_alert: false,
  });

  const [salonboardForm, setSalonboardForm] = useState({
    salonboard_id: "",
    salonboard_password: "",
    salonboard_enabled: false,
    hpb_email: "",
  });

  // Menu delete all state

  // Reservation delete all state (dev only)
  const [deletingAllReservations, setDeletingAllReservations] = useState(false);
  const [deleteAllReservationsMessage, setDeleteAllReservationsMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const isDev = typeof window !== "undefined" && window.location.hostname.includes("dev");

  // Equipment state
  const [equipmentList, setEquipmentList] = useState<Equipment[]>([]);
  const [equipmentLoading, setEquipmentLoading] = useState(false);
  const [equipmentForm, setEquipmentForm] = useState({ name: "", quantity: 1 });
  const [editingEquipment, setEditingEquipment] = useState<Equipment | null>(null);
  const [equipmentSaving, setEquipmentSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchStoreData = async () => {
      if (!selectedStore) {
        setLoading(false);
        return;
      }
      setLoading(true);
      // Reset equipment list so it reloads for the new store
      setEquipmentList([]);
      try {
        const { store: storeData } = await stores.get(selectedStore.id);
        if (cancelled) return;
        setStore(storeData);
        setStoreForm({
          name: storeData.name || "",
          postal_code: storeData.postal_code || "",
          address: storeData.address || "",
          phone: storeData.phone || "",
          email: storeData.email || "",
          seat_limit: storeData.seat_limit || 0,
          enable_seat_alert: storeData.enable_seat_alert === 1,
        });
        setSalonboardForm({
          salonboard_id: storeData.salonboard_id || "",
          salonboard_password: "",
          salonboard_enabled: storeData.salonboard_enabled === 1,
          hpb_email: storeData.hpb_email || "",
        });
      } catch (error) {
        console.error("Failed to fetch store:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchStoreData();
    return () => { cancelled = true; };
  }, [selectedStore?.id]);

  const handleSaveStore = async () => {
    if (!store) return;
    setSaving(true);
    try {
      const { store: updated } = await stores.update(store.id, {
        ...storeForm,
        enable_seat_alert: storeForm.enable_seat_alert ? 1 : 0,
      });
      setStore(updated);
      await refreshStores();
    } catch (error) {
      console.error("Failed to save store:", error);
      alert(error instanceof Error ? error.message : "店舗情報の保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSalonboard = async () => {
    if (!store) return;
    setSaving(true);
    try {
      const updateData: Record<string, string | boolean> = {
        salonboard_enabled: salonboardForm.salonboard_enabled,
      };
      if (salonboardForm.salonboard_id) {
        updateData.salonboard_id = salonboardForm.salonboard_id;
      }
      if (salonboardForm.salonboard_password) {
        updateData.salonboard_password = salonboardForm.salonboard_password;
      }
      updateData.hpb_email = salonboardForm.hpb_email || "";
      const { store: updated } = await stores.update(store.id, updateData);
      setStore(updated);
      setSalonboardForm((prev) => ({ ...prev, salonboard_password: "" }));
    } catch (error) {
      console.error("Failed to save Salonboard settings:", error);
    } finally {
      setSaving(false);
    }
  };


  const handleDeleteAllReservations = async () => {
    if (!store) return;
    if (!confirm("本当にすべての予約を削除しますか？この操作は取り消せません。")) return;
    setDeletingAllReservations(true);
    setDeleteAllReservationsMessage(null);
    try {
      const result = await reservationsApi.deleteAll(store.id);
      setDeleteAllReservationsMessage({
        type: "success",
        text: `${result.deleted}件の予約を削除しました。`,
      });
    } catch (error) {
      setDeleteAllReservationsMessage({
        type: "error",
        text: error instanceof Error ? error.message : "予約の削除に失敗しました",
      });
    } finally {
      setDeletingAllReservations(false);
    }
  };

  const fetchEquipment = async () => {
    if (!selectedStore) return;
    setEquipmentLoading(true);
    try {
      const { equipment } = await equipmentApi.list(selectedStore.id, false);
      setEquipmentList(equipment);
    } catch (error) {
      console.error("Failed to fetch equipment:", error);
    } finally {
      setEquipmentLoading(false);
    }
  };

  const handleCreateEquipment = async () => {
    if (!store || !equipmentForm.name.trim()) return;
    setEquipmentSaving(true);
    try {
      await equipmentApi.create({
        store_id: store.id,
        name: equipmentForm.name.trim(),
        quantity: equipmentForm.quantity,
      });
      setEquipmentForm({ name: "", quantity: 1 });
      await fetchEquipment();
    } catch (error) {
      alert(error instanceof Error ? error.message : "設備の追加に失敗しました");
    } finally {
      setEquipmentSaving(false);
    }
  };

  const handleUpdateEquipment = async () => {
    if (!editingEquipment) return;
    setEquipmentSaving(true);
    try {
      await equipmentApi.update(editingEquipment.id, {
        name: editingEquipment.name,
        quantity: editingEquipment.quantity,
        is_active: editingEquipment.is_active === 1,
      });
      setEditingEquipment(null);
      await fetchEquipment();
    } catch (error) {
      alert(error instanceof Error ? error.message : "設備の更新に失敗しました");
    } finally {
      setEquipmentSaving(false);
    }
  };

  const handleDeleteEquipment = async (id: string) => {
    if (!confirm("この設備を削除しますか？")) return;
    try {
      await equipmentApi.delete(id);
      await fetchEquipment();
    } catch (error) {
      alert(error instanceof Error ? error.message : "設備の削除に失敗しました");
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  if (!store) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <div className="text-muted-foreground">店舗情報が見つかりません</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">店舗設定</h1>

      <Tabs defaultValue="store">
        <TabsList className="flex w-full flex-wrap h-auto gap-1">
          <TabsTrigger value="store">店舗情報</TabsTrigger>
          <TabsTrigger value="salonboard">サロンボード</TabsTrigger>
          <TabsTrigger value="equipment" onClick={() => { if (equipmentList.length === 0) fetchEquipment(); }}>設備</TabsTrigger>
        </TabsList>

        <TabsContent value="store" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>店舗情報</CardTitle>
              <CardDescription>店舗の基本情報を設定します</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>店舗名</Label>
                <Input
                  value={storeForm.name}
                  onChange={(e) => setStoreForm({ ...storeForm, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>郵便番号</Label>
                <Input
                  value={storeForm.postal_code}
                  onChange={(e) => setStoreForm({ ...storeForm, postal_code: e.target.value })}
                  placeholder="123-4567"
                />
              </div>
              <div className="space-y-2">
                <Label>住所</Label>
                <Input
                  value={storeForm.address}
                  onChange={(e) => setStoreForm({ ...storeForm, address: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>電話番号</Label>
                  <Input
                    value={storeForm.phone}
                    onChange={(e) => setStoreForm({ ...storeForm, phone: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>メールアドレス</Label>
                  <Input
                    type="email"
                    value={storeForm.email}
                    onChange={(e) => setStoreForm({ ...storeForm, email: e.target.value })}
                  />
                </div>
              </div>
              <Separator />

              <div className="space-y-3">
                <Label className="text-base">席数アラート</Label>
                <p className="text-sm text-muted-foreground">
                  同時刻に受付可能な予約数の上限を設定します。上限を超えた場合、予約作成がブロックされます。
                </p>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={storeForm.enable_seat_alert}
                    onCheckedChange={(checked) =>
                      setStoreForm({ ...storeForm, enable_seat_alert: checked })
                    }
                  />
                  <Label>席数超過時に予約作成をブロックする</Label>
                </div>
                {storeForm.enable_seat_alert && (
                  <div className="space-y-2">
                    <Label>同時最大予約数</Label>
                    <Input
                      type="number"
                      min={1}
                      value={storeForm.seat_limit || ""}
                      onChange={(e) =>
                        setStoreForm({ ...storeForm, seat_limit: parseInt(e.target.value) || 0 })
                      }
                      placeholder="例: 5"
                      className="w-32"
                    />
                  </div>
                )}
              </div>

              <Separator />
              <Button onClick={handleSaveStore} disabled={saving}>
                {saving ? "保存中..." : "保存"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="salonboard" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>サロンボード連携設定</CardTitle>
              <CardDescription>
                ホットペッパービューティーのサロンボードと予約を同期します
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>注意</AlertTitle>
                <AlertDescription>
                  この機能はサロンボードの利用規約に抵触する可能性があります。
                  ご利用は自己責任でお願いします。
                </AlertDescription>
              </Alert>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>サロンボード連携を有効にする</Label>
                  <p className="text-sm text-muted-foreground">
                    有効にすると予約がサロンボードに自動同期されます
                  </p>
                </div>
                <Switch
                  checked={salonboardForm.salonboard_enabled}
                  onCheckedChange={(checked) =>
                    setSalonboardForm({ ...salonboardForm, salonboard_enabled: checked })
                  }
                />
              </div>

              <Separator />

              <div className="space-y-2">
                <Label>サロンボードID</Label>
                <Input
                  value={salonboardForm.salonboard_id}
                  onChange={(e) =>
                    setSalonboardForm({ ...salonboardForm, salonboard_id: e.target.value })
                  }
                  placeholder="サロンボードのログインID"
                  disabled={!salonboardForm.salonboard_enabled}
                />
              </div>
              <div className="space-y-2">
                <Label>パスワード</Label>
                <Input
                  type="password"
                  value={salonboardForm.salonboard_password}
                  onChange={(e) =>
                    setSalonboardForm({ ...salonboardForm, salonboard_password: e.target.value })
                  }
                  placeholder={store?.salonboard_id ? "変更する場合のみ入力" : "パスワード"}
                  disabled={!salonboardForm.salonboard_enabled}
                />
                {store?.salonboard_id && (
                  <p className="text-xs text-muted-foreground">
                    パスワードは既に設定されています。変更する場合のみ入力してください。
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label>HPBメール受信アドレス</Label>
                <Input
                  value={salonboardForm.hpb_email}
                  onChange={(e) =>
                    setSalonboardForm({ ...salonboardForm, hpb_email: e.target.value })
                  }
                  placeholder="hpb_storename@example.com"
                  disabled={!salonboardForm.salonboard_enabled}
                />
                <p className="text-xs text-muted-foreground">
                  ホットペッパーからの予約メール受信用アドレスです
                </p>
              </div>

              <Separator />
              <Button onClick={handleSaveSalonboard} disabled={saving}>
                {saving ? "保存中..." : "保存"}
              </Button>


              {isDev && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <Label className="text-base text-destructive">予約全削除（開発用）</Label>
                      <p className="text-sm text-muted-foreground">
                        この店舗のすべての予約を削除します。開発環境でのみ表示されます。
                      </p>
                    </div>

                    {deleteAllReservationsMessage && (
                      <Alert variant={deleteAllReservationsMessage.type === "error" ? "destructive" : "default"}>
                        <AlertDescription>{deleteAllReservationsMessage.text}</AlertDescription>
                      </Alert>
                    )}

                    <Button
                      onClick={handleDeleteAllReservations}
                      disabled={deletingAllReservations}
                      variant="destructive"
                    >
                      {deletingAllReservations ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          削除中...
                        </>
                      ) : (
                        <>
                          <Trash2 className="mr-2 h-4 w-4" />
                          すべての予約を削除
                        </>
                      )}
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="equipment" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>設備管理</CardTitle>
              <CardDescription>
                メニューに紐づける設備を管理します。数量を設定すると、同時間帯に予約が設備数を超えないよう制御されます。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Add new equipment */}
              <div className="flex items-end gap-3">
                <div className="flex-1 space-y-2">
                  <Label>設備名</Label>
                  <Input
                    value={equipmentForm.name}
                    onChange={(e) => setEquipmentForm({ ...equipmentForm, name: e.target.value })}
                    placeholder="例: シャンプー台"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && equipmentForm.name.trim()) handleCreateEquipment();
                    }}
                  />
                </div>
                <div className="w-24 space-y-2">
                  <Label>数量</Label>
                  <Input
                    type="number"
                    min={1}
                    value={equipmentForm.quantity}
                    onChange={(e) => setEquipmentForm({ ...equipmentForm, quantity: parseInt(e.target.value) || 1 })}
                  />
                </div>
                <Button onClick={handleCreateEquipment} disabled={equipmentSaving || !equipmentForm.name.trim()}>
                  <Plus className="h-4 w-4 mr-1" />
                  追加
                </Button>
              </div>

              <Separator />

              {/* Equipment list */}
              {equipmentLoading ? (
                <div className="text-center py-4 text-muted-foreground">読み込み中...</div>
              ) : equipmentList.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  設備がまだ登録されていません
                </div>
              ) : (
                <div className="space-y-2">
                  {equipmentList.map((eq) => (
                    <div key={eq.id} className="flex items-center justify-between rounded-lg border p-3">
                      {editingEquipment?.id === eq.id ? (
                        <div className="flex flex-1 items-center gap-3">
                          <Input
                            value={editingEquipment.name}
                            onChange={(e) => setEditingEquipment({ ...editingEquipment, name: e.target.value })}
                            className="flex-1"
                          />
                          <Input
                            type="number"
                            min={1}
                            value={editingEquipment.quantity}
                            onChange={(e) => setEditingEquipment({ ...editingEquipment, quantity: parseInt(e.target.value) || 1 })}
                            className="w-20"
                          />
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={editingEquipment.is_active === 1}
                              onCheckedChange={(checked) => setEditingEquipment({ ...editingEquipment, is_active: checked ? 1 : 0 })}
                            />
                            <span className="text-xs text-muted-foreground">有効</span>
                          </div>
                          <Button size="sm" onClick={handleUpdateEquipment} disabled={equipmentSaving}>保存</Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingEquipment(null)}>取消</Button>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-3">
                            <span className={eq.is_active !== 1 ? "text-muted-foreground line-through" : "font-medium"}>{eq.name}</span>
                            <span className="text-sm text-muted-foreground">{eq.quantity}台</span>
                            {eq.is_active !== 1 && <span className="text-xs text-destructive">無効</span>}
                          </div>
                          <div className="flex items-center gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setEditingEquipment({ ...eq })}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => handleDeleteEquipment(eq.id)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

    </div>
  );
}
