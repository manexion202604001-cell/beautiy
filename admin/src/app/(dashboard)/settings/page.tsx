"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Store, Eye, EyeOff, UserPlus, Trash2, Mail, Clock, Check, X, ArrowUpDown } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { auth, stores, staff as staffApi, type Staff } from "@/lib/api";
import { useStore } from "@/contexts/store-context";
import { useRouter } from "next/navigation";
import { getImageUrl } from "@/lib/utils";

type AssignmentStaff = {
  id: string; name: string; nickname: string | null; email: string; role: string; staff_code: string | null; avatar_url: string | null;
  stores: { id: string; name: string; is_primary: number; is_visible_to_customer: number }[];
};

export default function SettingsPage() {
  const router = useRouter();
  const { currentStore, stores: storeList, staff, refreshStores, setCurrentStore } = useStore();
  const [saving, setSaving] = useState(false);
  const [isNewStoreDialogOpen, setIsNewStoreDialogOpen] = useState(false);

  const [newStoreForm, setNewStoreForm] = useState({
    name: "",
    address: "",
    phone: "",
    email: "",
  });

  // Owner form state
  const [ownerForm, setOwnerForm] = useState({
    owner_type: "" as "" | "individual" | "company",
    company_name: "",
    company_postal_code: "",
    company_phone: "",
    company_address: "",
    company_email: "",
  });
  const [ownerSaving, setOwnerSaving] = useState(false);
  const [ownerMessage, setOwnerMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Staff management state
  const [matrixStaff, setMatrixStaff] = useState<AssignmentStaff[]>([]);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixUpdating, setMatrixUpdating] = useState<string | null>(null);

  // Sort state for store assignment matrix
  const [sortStoreId, setSortStoreId] = useState<string | null>(null);

  // Delete store state
  const [deleteTargetStore, setDeleteTargetStore] = useState<{ id: string; name: string } | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Invitation history state
  type Invitation = {
    id: string; staff_id: string; store_id: string; status: string; role: string;
    created_at: string; responded_at: string | null;
    store_name: string; staff_name: string; staff_code: string | null; avatar_url: string | null;
    invited_by_name: string;
  };
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [invitationsLoading, setInvitationsLoading] = useState(false);

  // Invite by code state
  const [linkCode, setLinkCode] = useState("");
  const [linkSearching, setLinkSearching] = useState(false);
  const [linkLinking, setLinkLinking] = useState(false);
  const [linkFoundStaff, setLinkFoundStaff] = useState<{
    id: string; name: string; email: string; staff_code: string; avatar_url: string | null; email_verified: number;
  } | null>(null);
  const [linkError, setLinkError] = useState("");
  const [linkRole, setLinkRole] = useState<Staff["role"]>("staff");

  // Initialize owner form from staff data
  useEffect(() => {
    if (staff?.role === "owner") {
      setOwnerForm({
        owner_type: staff.owner_type || "",
        company_name: staff.company_name || "",
        company_postal_code: staff.company_postal_code || "",
        company_phone: staff.company_phone || "",
        company_address: staff.company_address || "",
        company_email: staff.company_email || "",
      });
    }
  }, [staff]);

  // Fetch staff assignments and invitations on mount
  useEffect(() => {
    fetchMatrixData();
    fetchInvitations();
  }, []);

  const handleSaveOwner = async () => {
    if (!ownerForm.owner_type) return;
    setOwnerSaving(true);
    setOwnerMessage(null);
    try {
      await auth.updateProfile({
        owner_type: ownerForm.owner_type as "individual" | "company",
        company_name: ownerForm.owner_type === "company" ? ownerForm.company_name || null : null,
        company_postal_code: ownerForm.owner_type === "company" ? ownerForm.company_postal_code || null : null,
        company_phone: ownerForm.owner_type === "company" ? ownerForm.company_phone || null : null,
        company_address: ownerForm.owner_type === "company" ? ownerForm.company_address || null : null,
        company_email: ownerForm.owner_type === "company" ? ownerForm.company_email || null : null,
      });
      setOwnerMessage({ type: "success", text: "オーナー情報を保存しました" });
    } catch (error) {
      setOwnerMessage({
        type: "error",
        text: error instanceof Error ? error.message : "保存に失敗しました",
      });
    } finally {
      setOwnerSaving(false);
    }
  };

  const handleCreateStore = async () => {
    if (!newStoreForm.name) return;
    setSaving(true);
    try {
      await stores.create(newStoreForm);
      setNewStoreForm({ name: "", address: "", phone: "", email: "" });
      setIsNewStoreDialogOpen(false);
      await refreshStores();
    } catch (error: unknown) {
      console.error("Failed to create store:", error);
      const message = error instanceof Error ? error.message : "店舗の作成に失敗しました";
      alert(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteStore = async () => {
    if (!deleteTargetStore) return;
    setDeleting(true);
    try {
      await stores.delete(deleteTargetStore.id);
      setShowDeleteDialog(false);
      setDeleteTargetStore(null);
      await refreshStores();
      // If the deleted store was the current store, switch to another
      if (currentStore?.id === deleteTargetStore.id) {
        const remaining = storeList.filter(s => s.id !== deleteTargetStore.id);
        if (remaining.length > 0) {
          setCurrentStore(remaining[0]);
        }
      }
    } catch (error) {
      console.error("Failed to delete store:", error);
      alert(error instanceof Error ? error.message : "店舗の削除に失敗しました");
    } finally {
      setDeleting(false);
    }
  };

  const fetchMatrixData = async () => {
    setMatrixLoading(true);
    try {
      const result = await staffApi.getStoreAssignments();
      setMatrixStaff(result.staff);
    } catch (error) {
      console.error("Failed to fetch store assignments:", error);
    } finally {
      setMatrixLoading(false);
    }
  };

  const fetchInvitations = async () => {
    setInvitationsLoading(true);
    try {
      const result = await staffApi.getInvitations();
      setInvitations(result.invitations);
    } catch (error) {
      console.error("Failed to fetch invitations:", error);
    } finally {
      setInvitationsLoading(false);
    }
  };

  const handleToggleStore = async (staffMember: AssignmentStaff, storeId: string, checked: boolean) => {
    setMatrixUpdating(`${staffMember.id}-${storeId}`);
    try {
      const currentStoreIds = staffMember.stores.map(s => s.id);
      let newStoreIds: string[];
      if (checked) {
        newStoreIds = [...currentStoreIds, storeId];
      } else {
        newStoreIds = currentStoreIds.filter(id => id !== storeId);
      }
      const currentPrimary = staffMember.stores.find(s => s.is_primary)?.id;
      const primaryId = newStoreIds.includes(currentPrimary || "") ? currentPrimary : newStoreIds[0];
      await staffApi.updateStores(staffMember.id, newStoreIds, primaryId);
      setMatrixStaff(prev => prev.map(s => {
        if (s.id !== staffMember.id) return s;
        const updatedStores = newStoreIds.map(sid => {
          const existing = s.stores.find(st => st.id === sid);
          const storeName = storeList.find(st => st.id === sid)?.name || "";
          return { id: sid, name: existing?.name || storeName, is_primary: sid === primaryId ? 1 : 0, is_visible_to_customer: existing?.is_visible_to_customer ?? 1 };
        });
        return { ...s, stores: updatedStores };
      }));
    } catch (error) {
      console.error("Failed to update store assignment:", error);
    } finally {
      setMatrixUpdating(null);
    }
  };

  const handleToggleVisibility = async (staffMember: AssignmentStaff, storeId: string, isVisible: boolean) => {
    setMatrixUpdating(`vis-${staffMember.id}-${storeId}`);
    try {
      await staffApi.updateStoreVisibility(staffMember.id, storeId, isVisible);
      setMatrixStaff(prev => prev.map(s => {
        if (s.id !== staffMember.id) return s;
        return {
          ...s,
          stores: s.stores.map(st => st.id === storeId ? { ...st, is_visible_to_customer: isVisible ? 1 : 0 } : st),
        };
      }));
    } catch (error) {
      console.error("Failed to update visibility:", error);
    } finally {
      setMatrixUpdating(null);
    }
  };

  const handleSearchByCode = async () => {
    if (!linkCode || linkCode.length !== 6) {
      setLinkError("6桁のスタッフIDを入力してください");
      return;
    }
    setLinkSearching(true);
    setLinkError("");
    setLinkFoundStaff(null);
    try {
      const result = await staffApi.searchByCode(linkCode);
      setLinkFoundStaff(result.staff);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "スタッフが見つかりません");
    } finally {
      setLinkSearching(false);
    }
  };

  const handleLinkStaff = async () => {
    if (!currentStore || !linkFoundStaff) return;
    setLinkLinking(true);
    setLinkError("");
    try {
      await staffApi.linkByCode(linkFoundStaff.staff_code, currentStore.id, linkRole);
      setLinkCode("");
      setLinkFoundStaff(null);
      setLinkRole("staff");
      fetchMatrixData();
      fetchInvitations();
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "招待の送信に失敗しました");
    } finally {
      setLinkLinking(false);
    }
  };

  // Store order: 渋谷→青山→表参道→明治→心斎橋→福岡
  const STORE_ORDER = ["渋谷", "青山", "表参道", "明治", "心斎橋", "福岡"];
  const sortedStoreList = useMemo(() => {
    return [...storeList].sort((a, b) => {
      const aIdx = STORE_ORDER.findIndex(name => a.name.includes(name));
      const bIdx = STORE_ORDER.findIndex(name => b.name.includes(name));
      if (aIdx === -1 && bIdx === -1) return 0;
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });
  }, [storeList]);

  // Sort staff by assignment to a specific store
  const sortedMatrixStaff = useMemo(() => {
    if (!sortStoreId) return matrixStaff;
    return [...matrixStaff].sort((a, b) => {
      const aAssigned = a.stores.some(s => s.id === sortStoreId) ? 1 : 0;
      const bAssigned = b.stores.some(s => s.id === sortStoreId) ? 1 : 0;
      return bAssigned - aAssigned;
    });
  }, [matrixStaff, sortStoreId]);

  const canCreateStore = staff?.role === "system_admin" || staff?.role === "owner";
  const canDeleteStore = staff?.role === "system_admin" || staff?.role === "owner";

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">設定</h1>

      <Tabs defaultValue="stores">
        <TabsList className="flex w-full flex-wrap h-auto gap-1">
          <TabsTrigger value="stores">店舗一覧</TabsTrigger>
          {staff?.role === "owner" && <TabsTrigger value="owner">オーナー情報</TabsTrigger>}
          <TabsTrigger value="staff">スタッフ管理</TabsTrigger>
        </TabsList>

        {/* 店舗一覧タブ */}
        <TabsContent value="stores" className="mt-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>店舗一覧</CardTitle>
                  <CardDescription>オーナーが管理する全店舗</CardDescription>
                </div>
                {canCreateStore && (
                  <Button size="sm" onClick={() => setIsNewStoreDialogOpen(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    新しい店舗
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {storeList.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">
                  店舗がありません
                </div>
              ) : (
                <div className="space-y-3">
                  {storeList.map((s) => (
                    <div
                      key={s.id}
                      className="rounded-lg border p-4 hover:bg-accent/50 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                            <Store className="h-5 w-5 text-primary" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{s.name}</span>
                              {s.is_primary === 1 && (
                                <Badge variant="secondary" className="text-xs">主</Badge>
                              )}
                              {currentStore?.id === s.id && (
                                <Badge variant="outline" className="text-xs">選択中</Badge>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setCurrentStore(s);
                              router.push("/store-settings");
                            }}
                          >
                            店舗設定
                          </Button>
                          {canDeleteStore && storeList.length > 1 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive hover:bg-destructive/10"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteTargetStore({ id: s.id, name: s.name });
                                setShowDeleteDialog(true);
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* オーナー情報タブ */}
        {staff?.role === "owner" && (
          <TabsContent value="owner" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>オーナー情報</CardTitle>
                <CardDescription>事業形態や会社情報を設定します</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {ownerMessage && (
                  <Alert variant={ownerMessage.type === "error" ? "destructive" : "default"}>
                    <AlertDescription>{ownerMessage.text}</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  <Label>事業形態</Label>
                  <Select
                    value={ownerForm.owner_type}
                    onValueChange={(value) => setOwnerForm({ ...ownerForm, owner_type: value as "individual" | "company" })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="選択してください" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="individual">個人</SelectItem>
                      <SelectItem value="company">法人</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {ownerForm.owner_type === "company" && (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <Label>会社名</Label>
                      <Input
                        value={ownerForm.company_name}
                        onChange={(e) => setOwnerForm({ ...ownerForm, company_name: e.target.value })}
                        placeholder="株式会社○○"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>郵便番号</Label>
                      <Input
                        value={ownerForm.company_postal_code}
                        onChange={(e) => setOwnerForm({ ...ownerForm, company_postal_code: e.target.value })}
                        placeholder="123-4567"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>住所</Label>
                      <Input
                        value={ownerForm.company_address}
                        onChange={(e) => setOwnerForm({ ...ownerForm, company_address: e.target.value })}
                        placeholder="東京都..."
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>電話番号</Label>
                        <Input
                          value={ownerForm.company_phone}
                          onChange={(e) => setOwnerForm({ ...ownerForm, company_phone: e.target.value })}
                          placeholder="03-1234-5678"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>メールアドレス</Label>
                        <Input
                          type="email"
                          value={ownerForm.company_email}
                          onChange={(e) => setOwnerForm({ ...ownerForm, company_email: e.target.value })}
                          placeholder="info@example.com"
                        />
                      </div>
                    </div>
                  </>
                )}

                <Separator />
                <Button onClick={handleSaveOwner} disabled={ownerSaving || !ownerForm.owner_type}>
                  {ownerSaving ? "保存中..." : "保存"}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* スタッフ管理タブ */}
        <TabsContent value="staff" className="mt-6 space-y-6">
          {/* スタッフ招待 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserPlus className="h-5 w-5" />
                スタッフ招待
              </CardTitle>
              <CardDescription>
                スタッフの6桁IDを入力して、現在選択中の店舗に招待します
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {linkError && (
                <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive">{linkError}</div>
              )}
              <div className="flex gap-2">
                <Input
                  placeholder="6桁のスタッフID"
                  value={linkCode}
                  onChange={(e) => {
                    setLinkCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                    setLinkFoundStaff(null);
                    setLinkError("");
                  }}
                  maxLength={6}
                  className="font-mono text-lg tracking-widest max-w-[200px]"
                />
                <Button onClick={handleSearchByCode} disabled={linkSearching || linkCode.length !== 6}>
                  {linkSearching ? "検索中..." : "検索"}
                </Button>
              </div>
              {linkFoundStaff && (
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10">
                      <AvatarImage src={linkFoundStaff.avatar_url ? getImageUrl(linkFoundStaff.avatar_url) || "" : ""} />
                      <AvatarFallback>{linkFoundStaff.name.charAt(0)}</AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">{linkFoundStaff.name}</p>
                      <p className="text-sm text-muted-foreground">{linkFoundStaff.email}</p>
                    </div>
                  </div>
                  {linkFoundStaff.email_verified === 0 && (
                    <p className="text-sm text-destructive">このスタッフはメール認証が完了していません</p>
                  )}
                  <div className="flex items-center gap-3">
                    <div className="space-y-1">
                      <Label>権限</Label>
                      <Select value={linkRole} onValueChange={(v) => setLinkRole(v as Staff["role"])}>
                        <SelectTrigger className="w-[160px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="staff">スタッフ</SelectItem>
                          <SelectItem value="manager">ディレクター</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      onClick={handleLinkStaff}
                      disabled={!linkFoundStaff || linkFoundStaff.email_verified === 0 || linkLinking}
                      className="mt-auto"
                    >
                      {linkLinking ? "送信中..." : "招待を送信"}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 店舗割り当てマトリクス */}
          <Card>
            <CardHeader>
              <CardTitle>店舗割り当て</CardTitle>
              <CardDescription>
                スタッフがどの店舗で働くかを設定します。目のアイコンでお客様への表示/非表示を切り替えられます。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {matrixLoading ? (
                <div className="py-8 text-center text-muted-foreground">読み込み中...</div>
              ) : storeList.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">店舗がありません</div>
              ) : (
                <div className="overflow-auto max-h-[70vh] border rounded-md">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-20 bg-background">
                      <tr className="border-b">
                        <th className="text-left py-2 pr-4 font-medium sticky left-0 z-30 bg-background min-w-[140px]">スタッフ</th>
                        {sortedStoreList.map(store => (
                          <th key={store.id} className="text-center py-2 px-3 font-medium whitespace-nowrap">
                            <button
                              className="inline-flex items-center gap-1 hover:text-primary transition-colors"
                              onClick={() => setSortStoreId(prev => prev === store.id ? null : store.id)}
                              title="この店舗の所属スタッフを上に表示"
                            >
                              {store.name}
                              <ArrowUpDown className={`h-3 w-3 ${sortStoreId === store.id ? "text-primary" : "text-muted-foreground/50"}`} />
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedMatrixStaff.map(s => (
                        <tr key={s.id} className="border-b last:border-0">
                          <td className="py-2 pr-4 sticky left-0 z-10 bg-background">
                            <div className="flex items-center gap-2">
                              <Avatar className="h-7 w-7">
                                {s.avatar_url && <AvatarImage src={getImageUrl(s.avatar_url) || undefined} />}
                                <AvatarFallback className="text-xs">{s.name.charAt(0)}</AvatarFallback>
                              </Avatar>
                              <div className="min-w-0">
                                <p className="font-medium truncate text-sm">{s.name}</p>
                                {s.nickname && <p className="text-xs text-muted-foreground truncate">{s.nickname}</p>}
                                {s.staff_code && <p className="text-xs text-muted-foreground">ID: {s.staff_code}</p>}
                              </div>
                            </div>
                          </td>
                          {sortedStoreList.map(store => {
                            const storeAssignment = s.stores.find(st => st.id === store.id);
                            const isAssigned = !!storeAssignment;
                            const isVisible = storeAssignment?.is_visible_to_customer === 1;
                            const isUpdating = matrixUpdating === `${s.id}-${store.id}` || matrixUpdating === `vis-${s.id}-${store.id}`;
                            return (
                              <td key={store.id} className="text-center py-2 px-3">
                                <div className="flex items-center justify-center gap-1">
                                  <Checkbox
                                    checked={isAssigned}
                                    onCheckedChange={(checked) => {
                                      if (matrixUpdating) return;
                                      handleToggleStore(s, store.id, !!checked);
                                    }}
                                    className={isUpdating ? "opacity-50 pointer-events-none" : "cursor-pointer"}
                                  />
                                  {isAssigned && (
                                    <button
                                      onClick={() => {
                                        if (matrixUpdating) return;
                                        handleToggleVisibility(s, store.id, !isVisible);
                                      }}
                                      className={`p-0.5 rounded hover:bg-accent ${isUpdating ? "opacity-50 pointer-events-none" : ""}`}
                                      title={isVisible ? "お客様に表示中" : "お客様に非表示"}
                                    >
                                      {isVisible ? (
                                        <Eye className="h-3.5 w-3.5 text-primary" />
                                      ) : (
                                        <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                                      )}
                                    </button>
                                  )}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                      {sortedMatrixStaff.length === 0 && (
                        <tr>
                          <td colSpan={sortedStoreList.length + 1} className="py-8 text-center text-muted-foreground">
                            スタッフがいません
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 招待履歴 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mail className="h-5 w-5" />
                招待履歴
              </CardTitle>
              <CardDescription>
                送信した招待の状況を確認できます
              </CardDescription>
            </CardHeader>
            <CardContent>
              {invitationsLoading ? (
                <div className="py-8 text-center text-muted-foreground">読み込み中...</div>
              ) : invitations.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">招待履歴はありません</div>
              ) : (
                <div className="space-y-3">
                  {invitations.map((inv) => (
                    <div key={inv.id} className="flex items-center justify-between rounded-lg border p-3 gap-2">
                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar className="h-8 w-8 shrink-0">
                          {inv.avatar_url && <AvatarImage src={getImageUrl(inv.avatar_url) || undefined} />}
                          <AvatarFallback className="text-xs">{inv.staff_name.charAt(0)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-sm truncate">{inv.staff_name}</p>
                            {inv.staff_code && <span className="text-xs text-muted-foreground whitespace-nowrap">ID: {inv.staff_code}</span>}
                          </div>
                          <p className="text-xs text-muted-foreground truncate">
                            {inv.store_name} / {inv.role === "manager" ? "ディレクター" : "スタッフ"} / {inv.invited_by_name}が招待
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(inv.created_at).toLocaleDateString("ja-JP")}
                        </span>
                        {inv.status === "pending" && (
                          <Badge variant="outline" className="flex items-center gap-1 text-yellow-600 border-yellow-300 bg-yellow-50">
                            <Clock className="h-3 w-3" />
                            承認待ち
                          </Badge>
                        )}
                        {inv.status === "accepted" && (
                          <Badge variant="outline" className="flex items-center gap-1 text-green-600 border-green-300 bg-green-50">
                            <Check className="h-3 w-3" />
                            承認済み
                          </Badge>
                        )}
                        {inv.status === "rejected" && (
                          <Badge variant="outline" className="flex items-center gap-1 text-red-600 border-red-300 bg-red-50">
                            <X className="h-3 w-3" />
                            辞退
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* New Store Dialog */}
      <Dialog open={isNewStoreDialogOpen} onOpenChange={setIsNewStoreDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新しい店舗を作成</DialogTitle>
            <DialogDescription>
              新しい店舗の情報を入力してください
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label>店舗名 *</Label>
              <Input
                value={newStoreForm.name}
                onChange={(e) => setNewStoreForm({ ...newStoreForm, name: e.target.value })}
                placeholder="例: ビューティーサロン 新宿店"
              />
            </div>
            <div className="space-y-2">
              <Label>住所</Label>
              <Input
                value={newStoreForm.address}
                onChange={(e) => setNewStoreForm({ ...newStoreForm, address: e.target.value })}
                placeholder="例: 東京都新宿区..."
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>電話番号</Label>
                <Input
                  value={newStoreForm.phone}
                  onChange={(e) => setNewStoreForm({ ...newStoreForm, phone: e.target.value })}
                  placeholder="03-1234-5678"
                />
              </div>
              <div className="space-y-2">
                <Label>メールアドレス</Label>
                <Input
                  type="email"
                  value={newStoreForm.email}
                  onChange={(e) => setNewStoreForm({ ...newStoreForm, email: e.target.value })}
                  placeholder="store@example.com"
                />
              </div>
            </div>
            {staff?.role === "system_admin" && (
              <>
                <Separator />
                <p className="text-xs text-muted-foreground">オーナーアカウントは「オーナー作成」ボタンから別途作成してください</p>
              </>
            )}
            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => setIsNewStoreDialogOpen(false)}>
                キャンセル
              </Button>
              <Button onClick={handleCreateStore} disabled={saving || !newStoreForm.name}>
                {saving ? "作成中..." : "作成"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Store Confirmation */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>店舗を削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTargetStore?.name}」を削除します。この店舗に紐づく顧客、予約、メニュー、カルテなど全てのデータが削除されます。この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteStore}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "削除中..." : "削除する"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
