"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import {
  ArrowLeft,
  Phone,
  Mail,
  MapPin,
  Briefcase,
  Edit,
  Trash2,
  Calendar,
  FileText,
  ClipboardList,
  ChevronRight,
} from "lucide-react";
import {
  customers,
  staff as staffApi,
  type Customer,
  type Staff,
  type AssignedStaff,
  type Reservation,
  type Karute,
} from "@/lib/api";
import { formatDate, formatPrice } from "@/lib/utils";
import { useStore } from "@/contexts/store-context";
import { CounselingSheetForm } from "@/components/counseling-sheet-form";

type CustomerFormData = {
  name: string;
  name_kana: string;
  gender: "male" | "female" | "other" | "";
  birthday: string;
  occupation: string;
  postal_code: string;
  address: string;
  phone: string;
  email: string;
  memo: string;
};

export default function CustomerDetail({ id, defaultTab = "karutes", backPath = "/customers" }: { id: string; defaultTab?: string; backPath?: string }) {
  const router = useRouter();
  const { currentStore, staff: currentStaff } = useStore();
  const canDelete = currentStaff?.role === "system_admin" || currentStaff?.role === "owner";

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [lineInfo, setLineInfo] = useState<{ display_name: string; picture_url: string } | null>(null);
  const [reservationList, setReservationList] = useState<Reservation[]>([]);
  const [karuteList, setKaruteList] = useState<Karute[]>([]);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [assignedStaffList, setAssignedStaffList] = useState<AssignedStaff[]>([]);
  const [linkedCustomers, setLinkedCustomers] = useState<{
    id: string; store_id: string; store_name: string; name: string;
    visit_count: number | null; last_visit_at: string | null;
    staff_name: string | null; karute_count: number; last_reservation_at: string | null;
  }[]>([]);
  const [loading, setLoading] = useState(true);

  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [formData, setFormData] = useState<CustomerFormData>({
    name: "", name_kana: "", gender: "", birthday: "", occupation: "",
    postal_code: "", address: "", phone: "", email: "", memo: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [searchingAddress, setSearchingAddress] = useState(false);

  const fetchCustomer = useCallback(async () => {
    if (id === "placeholder") return;
    setLoading(true);
    try {
      const [data, staffData] = await Promise.all([
        customers.get(id),
        staffApi.list(),
      ]);
      setCustomer(data.customer);
      setAssignedStaffList(data.assigned_staff || []);
      setLineInfo(data.line);
      setLinkedCustomers((data as { linked_customers?: typeof linkedCustomers }).linked_customers || []);
      setReservationList(data.reservations as Reservation[]);
      setKaruteList(data.karutes as Karute[]);
      setStaffList(staffData.staff);
    } catch (error) {
      console.error("Failed to fetch customer:", error);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchCustomer();
  }, [fetchCustomer]);

  const searchAddressByPostalCode = async (postalCode: string) => {
    const cleanedCode = postalCode.replace(/-/g, "");
    if (cleanedCode.length !== 7 || !/^\d+$/.test(cleanedCode)) return;
    setSearchingAddress(true);
    try {
      const response = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${cleanedCode}`);
      const data = await response.json();
      if (data.results?.length > 0) {
        const result = data.results[0];
        setFormData((prev) => ({ ...prev, address: `${result.address1}${result.address2}${result.address3}` }));
      }
    } catch (error) {
      console.error("Failed to search address:", error);
    } finally {
      setSearchingAddress(false);
    }
  };

  const handleEdit = () => {
    if (!customer) return;
    setFormData({
      name: customer.name || "",
      name_kana: customer.name_kana || "",
      gender: (customer.gender as CustomerFormData["gender"]) || "",
      birthday: customer.birthday || "",
      occupation: customer.occupation || "",
      postal_code: customer.postal_code || "",
      address: customer.address || "",
      phone: customer.phone || "",
      email: customer.email || "",
      memo: customer.memo || "",
    });
    setShowEditDialog(true);
  };

  const handleSave = async () => {
    if (!customer || !formData.name.trim()) return;
    setSubmitting(true);
    try {
      const { customer: updated } = await customers.update(customer.id, {
        name: formData.name,
        name_kana: formData.name_kana || null,
        gender: formData.gender || null,
        birthday: formData.birthday || null,
        occupation: formData.occupation || null,
        postal_code: formData.postal_code || null,
        address: formData.address || null,
        phone: formData.phone || null,
        email: formData.email || null,
        memo: formData.memo || null,
      });
      setCustomer(updated);
      setShowEditDialog(false);
    } catch (error) {
      console.error("Failed to update:", error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleStaff = async (staffId: string) => {
    if (!customer) return;
    try {
      const currentIds = assignedStaffList.map(s => s.staff_id);
      let newIds: string[];
      if (currentIds.includes(staffId)) {
        newIds = currentIds.filter(id => id !== staffId);
      } else {
        newIds = [...currentIds, staffId];
      }
      const { customer: updated } = await customers.assignStaffMultiple(customer.id, newIds);
      setCustomer(updated);
      // Refresh assigned staff
      const data = await customers.get(customer.id);
      setAssignedStaffList(data.assigned_staff || []);
    } catch (error) {
      console.error("Failed to assign staff:", error);
    }
  };

  const handleDelete = async () => {
    if (!customer) return;
    setDeleting(true);
    try {
      await customers.delete(customer.id);
      router.push(backPath);
    } catch (error) {
      console.error("Failed to delete:", error);
    } finally {
      setDeleting(false);
    }
  };

  const getStatusBadge = (status: Reservation["status"]) => {
    switch (status) {
      case "pending": return <Badge variant="warning">確認待ち</Badge>;
      case "confirmed": return <Badge variant="success">確定</Badge>;
      case "completed": return <Badge variant="secondary">完了</Badge>;
      case "cancelled": return <Badge variant="destructive">キャンセル</Badge>;
      case "noshow": return <Badge variant="destructive">無断キャンセル</Badge>;
      default: return <Badge>{status}</Badge>;
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  if (!customer) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => router.push(backPath)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          顧客一覧に戻る
        </Button>
        <div className="py-8 text-center text-muted-foreground">顧客が見つかりません</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => router.push(backPath)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-xl md:text-2xl font-bold">{customer.name}</h1>
            {customer.name_kana && (
              <p className="text-sm text-muted-foreground">{customer.name_kana}</p>
            )}
            {customer.member_no && (
              <p className="text-xs text-muted-foreground font-mono mt-0.5">会員番号: {customer.member_no}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleEdit}>
            <Edit className="mr-2 h-4 w-4" />
            編集
          </Button>
          {canDelete && (
            <Button variant="destructive" size="sm" onClick={() => setShowDeleteDialog(true)}>
              <Trash2 className="mr-2 h-4 w-4" />
              削除
            </Button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="grid gap-6 lg:grid-cols-4">
        {/* Customer Info Sidebar */}
        <Card className="lg:col-span-1">
          <CardHeader className="text-center">
            <Avatar className="mx-auto h-20 w-20">
              {lineInfo?.picture_url && <AvatarImage src={lineInfo.picture_url} />}
              <AvatarFallback className="text-2xl">{customer.name.charAt(0)}</AvatarFallback>
            </Avatar>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3 text-sm">
              <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
              <span>{customer.phone || "未設定"}</span>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="truncate">{customer.email || "未設定"}</span>
            </div>
            {(customer.address || customer.postal_code) && (
              <div className="flex items-start gap-3 text-sm">
                <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <span>
                  {customer.postal_code && `〒${customer.postal_code} `}
                  {customer.address}
                </span>
              </div>
            )}
            {customer.occupation && (
              <div className="flex items-center gap-3 text-sm">
                <Briefcase className="h-4 w-4 text-muted-foreground shrink-0" />
                <span>{customer.occupation}</span>
              </div>
            )}
            <Separator />
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">来店回数</span>
                <span className="font-medium">{customer.visit_count}回</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">最終来店</span>
                <span className="font-medium">
                  {customer.last_visit_at ? formatDate(customer.last_visit_at, "date") : "なし"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">性別</span>
                <span className="font-medium">
                  {customer.gender === "male" ? "男性" : customer.gender === "female" ? "女性" : customer.gender === "other" ? "その他" : "未設定"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">誕生日</span>
                <span className="font-medium">{customer.birthday || "未設定"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">集客元</span>
                <Badge variant={customer.origin === "staff" ? "outline" : "secondary"} className={customer.origin === "staff" ? "border-blue-400 text-blue-600" : ""}>
                  {customer.origin === "staff" ? "スタッフ集客" : "店舗集客"}
                </Badge>
              </div>
            </div>
            {customer.memo && (
              <>
                <Separator />
                <div>
                  <p className="text-xs text-muted-foreground mb-1">メモ</p>
                  <p className="text-sm whitespace-pre-wrap">{customer.memo}</p>
                </div>
              </>
            )}
            <Separator />
            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">担当スタッフ</label>
              {assignedStaffList.length === 0 && (
                <p className="text-sm text-muted-foreground">担当未設定</p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {assignedStaffList.map((as) => (
                  <Badge key={as.staff_id} variant="secondary" className="cursor-pointer hover:bg-destructive/20" onClick={() => handleToggleStaff(as.staff_id)}>
                    {as.staff_name} ×
                  </Badge>
                ))}
              </div>
              <Select value="" onValueChange={handleToggleStaff}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="+ スタッフを追加" />
                </SelectTrigger>
                <SelectContent>
                  {staffList
                    .filter((s) => !assignedStaffList.some((as) => as.staff_id === s.id))
                    .map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          {linkedCustomers.length > 0 && (
            <>
              <Separator />
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">同一会員番号のリンク済みレコード（他店舗含む）</p>
                {linkedCustomers.map((lc) => (
                  <div key={lc.id} className="rounded-md border p-2 text-xs space-y-0.5">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{lc.store_name}</span>
                      <span className="text-muted-foreground">来店{lc.visit_count || 0}回</span>
                    </div>
                    <div className="text-muted-foreground">
                      {lc.staff_name && <span>担当: {lc.staff_name}　</span>}
                      {lc.last_visit_at && <span>最終来店: {lc.last_visit_at.slice(0, 10)}</span>}
                      {!lc.last_visit_at && lc.last_reservation_at && <span>直近予約: {lc.last_reservation_at.slice(0, 10)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          </CardContent>
        </Card>

        {/* Tabs Area */}
        <div className="lg:col-span-3">
          <Tabs defaultValue={defaultTab}>
            <TabsList className="w-full grid grid-cols-4">
              <TabsTrigger value="reservations" className="text-xs sm:text-sm">
                <Calendar className="mr-1 sm:mr-2 h-3 w-3 sm:h-4 sm:w-4" />
                <span className="hidden sm:inline">予約履歴</span>
                <span className="sm:hidden">予約</span>
              </TabsTrigger>
              <TabsTrigger value="karutes" className="text-xs sm:text-sm">
                <FileText className="mr-1 sm:mr-2 h-3 w-3 sm:h-4 sm:w-4" />
                カルテ
              </TabsTrigger>
              <TabsTrigger value="counseling" className="text-xs sm:text-sm">
                <ClipboardList className="mr-1 sm:mr-2 h-3 w-3 sm:h-4 sm:w-4" />
                <span className="hidden sm:inline">カウンセリング</span>
                <span className="sm:hidden">問診</span>
              </TabsTrigger>
              <TabsTrigger value="messages" className="text-xs sm:text-sm">
                <span className="hidden sm:inline">メッセージ</span>
                <span className="sm:hidden">MSG</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="reservations" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">予約履歴</CardTitle>
                  <CardDescription>{reservationList.length}件</CardDescription>
                </CardHeader>
                <CardContent>
                  {reservationList.length === 0 ? (
                    <div className="py-8 text-center text-muted-foreground">予約履歴がありません</div>
                  ) : (
                    <div className="space-y-3">
                      {reservationList.map((reservation) => (
                        <div key={reservation.id} className="rounded-lg border p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="font-medium text-sm">
                                {formatDate(reservation.start_at, "datetime")}
                              </div>
                              <div className="text-xs text-muted-foreground truncate">
                                {reservation.menu_name} / {reservation.staff_name}
                              </div>
                            </div>
                            <div className="flex flex-col items-end gap-1 shrink-0">
                              {getStatusBadge(reservation.status)}
                              <span className="text-sm font-medium">{formatPrice(reservation.price || 0)}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="karutes" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">カルテ</CardTitle>
                  <CardDescription>{karuteList.length}件</CardDescription>
                </CardHeader>
                <CardContent>
                  {karuteList.length === 0 ? (
                    <div className="py-8 text-center text-muted-foreground">カルテがありません</div>
                  ) : (
                    <div className="space-y-3">
                      {karuteList.map((karute) => (
                        <div
                          key={karute.id}
                          className="rounded-lg border p-3 transition-colors hover:bg-accent cursor-pointer"
                          onClick={() => router.push(`/customers/karutes/${karute.id}`)}
                        >
                          <div className="flex items-center justify-between">
                            <div className="font-medium">{formatDate(karute.visit_date, "date")}</div>
                            <div className="flex items-center gap-2">
                              {karute.is_shared_to_customer ? (
                                <Badge variant="success">共有済み</Badge>
                              ) : (
                                <Badge variant="outline">未共有</Badge>
                              )}
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            </div>
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">
                            {karute.menu_content || "施術内容なし"}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            担当: {karute.staff_name}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="counseling" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">カウンセリングシート</CardTitle>
                  <CardDescription>事前問診・ご要望</CardDescription>
                </CardHeader>
                <CardContent>
                  <CounselingSheetForm
                    customerId={customer.id}
                    storeId={currentStore?.id}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="messages" className="mt-4">
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  メッセージ機能は準備中です
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* Edit Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>顧客情報を編集</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>名前 <span className="text-destructive">*</span></Label>
                <Input placeholder="例: 山田 花子" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} />
                <p className="text-xs text-muted-foreground">姓と名の間にスペースを入れてください</p>
              </div>
              <div className="space-y-2">
                <Label>よみがな</Label>
                <Input placeholder="例: ヤマダ ハナコ" value={formData.name_kana} onChange={(e) => setFormData({ ...formData, name_kana: e.target.value })} />
                <p className="text-xs text-muted-foreground">姓と名の間にスペースを入れてください</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>性別</Label>
                <Select value={formData.gender} onValueChange={(v) => setFormData({ ...formData, gender: v as CustomerFormData["gender"] })}>
                  <SelectTrigger><SelectValue placeholder="選択してください" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="female">女性</SelectItem>
                    <SelectItem value="male">男性</SelectItem>
                    <SelectItem value="other">その他</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>生年月日</Label>
                <Input type="date" value={formData.birthday} onChange={(e) => setFormData({ ...formData, birthday: e.target.value })} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>職業</Label>
              <Input value={formData.occupation} onChange={(e) => setFormData({ ...formData, occupation: e.target.value })} />
            </div>
            <Separator />
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>電話番号</Label>
                <Input type="tel" value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>メールアドレス</Label>
                <Input type="email" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} />
              </div>
            </div>
            <Separator />
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>郵便番号</Label>
                <div className="relative">
                  <Input
                    value={formData.postal_code}
                    onChange={(e) => {
                      const value = e.target.value;
                      setFormData({ ...formData, postal_code: value });
                      if (value.replace(/-/g, "").length === 7) searchAddressByPostalCode(value);
                    }}
                    placeholder="123-4567"
                  />
                  {searchingAddress && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    </div>
                  )}
                </div>
              </div>
              <div className="col-span-2 space-y-2">
                <Label>住所</Label>
                <Input value={formData.address} onChange={(e) => setFormData({ ...formData, address: e.target.value })} />
              </div>
            </div>
            <Separator />
            <div className="space-y-2">
              <Label>メモ</Label>
              <Textarea value={formData.memo} onChange={(e) => setFormData({ ...formData, memo: e.target.value })} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>キャンセル</Button>
            <Button onClick={handleSave} disabled={submitting}>{submitting ? "保存中..." : "保存"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>顧客を削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              「{customer.name}」を削除します。この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
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
