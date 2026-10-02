"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Edit, UserCheck, UserX, UserMinus, Bell, Camera, X, Eye, EyeOff, Settings, Users, ChevronUp, ChevronDown, UserPlus, Clock, CheckCircle2, XCircle, QrCode } from "lucide-react";
import { useRouter } from "next/navigation";
import { Switch } from "@/components/ui/switch";
import { staff as staffApi, type Staff } from "@/lib/api";
import { useStore } from "@/contexts/store-context";
import { getImageUrl } from "@/lib/utils";
import { formatDate } from "@/lib/utils";
import { StaffSettingsDialog } from "./staff-settings-dialog";
import { WalkinQrDialog } from "./walkin-qr-dialog";

export default function StaffPage() {
  const router = useRouter();
  const { currentStore } = useStore();
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingStaff, setEditingStaff] = useState<Staff | null>(null);
  const [qrStaff, setQrStaff] = useState<Staff | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    nickname: "",
    email: "",
    password: "",
    role: "staff" as Staff["role"],
    notify_line: false,
    line_user_id: "",
    salonboard_staff_id: "",
    salonboard_name: "",
  });
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Staff settings dialog state
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [settingsStaff, setSettingsStaff] = useState<Staff | null>(null);

  // Staff invite state
  const [inviteCode, setInviteCode] = useState("");
  const [inviteSearching, setInviteSearching] = useState(false);
  const [inviteSending, setInviteSending] = useState(false);
  const [inviteFoundStaff, setInviteFoundStaff] = useState<{
    id: string; name: string; email: string; staff_code: string; avatar_url: string | null; email_verified: number;
  } | null>(null);
  const [inviteError, setInviteError] = useState("");
  const [inviteRole, setInviteRole] = useState<Staff["role"]>("staff");
  const [invitations, setInvitations] = useState<{
    id: string; staff_id: string; store_id: string; status: string; role: string;
    created_at: string; responded_at: string | null;
    store_name: string; staff_name: string; staff_code: string | null; avatar_url: string | null;
    invited_by_name: string;
  }[]>([]);

  useEffect(() => {
    fetchStaff();
    fetchInvitations();
  }, [currentStore?.id]);

  const fetchStaff = async () => {
    if (!currentStore) return;
    setLoading(true);
    try {
      const { staff } = await staffApi.list(currentStore.id);
      setStaffList(staff);
    } catch (error) {
      console.error("Failed to fetch staff:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchInvitations = async () => {
    try {
      const result = await staffApi.getInvitations();
      setInvitations(result.invitations);
    } catch (error) {
      console.error("Failed to fetch invitations:", error);
    }
  };

  const handleInviteSearch = async () => {
    if (inviteCode.length !== 6) return;
    setInviteSearching(true);
    setInviteError("");
    setInviteFoundStaff(null);
    try {
      const result = await staffApi.searchByCode(inviteCode);
      setInviteFoundStaff(result.staff);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "スタッフが見つかりません");
    } finally {
      setInviteSearching(false);
    }
  };

  const handleInviteSend = async () => {
    if (!inviteFoundStaff || !currentStore) return;
    setInviteSending(true);
    setInviteError("");
    try {
      await staffApi.linkByCode(inviteFoundStaff.staff_code, currentStore.id, inviteRole);
      setInviteCode("");
      setInviteFoundStaff(null);
      setInviteRole("staff");
      fetchInvitations();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "招待の送信に失敗しました");
    } finally {
      setInviteSending(false);
    }
  };

  const handleMoveStaff = useCallback(async (index: number, direction: "up" | "down") => {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= staffList.length) return;
    if (!currentStore) return;

    const reordered = [...staffList];
    [reordered[index], reordered[newIndex]] = [reordered[newIndex], reordered[index]];
    setStaffList(reordered);

    const items = reordered.map((s, i) => ({ staff_id: s.id, sort_order: i }));
    try {
      await staffApi.reorder(currentStore.id, items);
    } catch (error) {
      console.error("Failed to reorder staff:", error);
      fetchStaff();
    }
  }, [staffList, currentStore]);

  const handleOpenDialog = (staffMember?: Staff) => {
    if (staffMember) {
      setEditingStaff(staffMember);
      setFormData({
        name: staffMember.name,
        nickname: staffMember.nickname || "",
        email: staffMember.email,
        password: "",
        role: staffMember.role,
        notify_line: staffMember.notify_line === 1,
        line_user_id: staffMember.line_user_id || "",
        salonboard_staff_id: staffMember.salonboard_staff_id || "",
        salonboard_name: staffMember.salonboard_name || "",
      });
      setAvatarPreview(getImageUrl(staffMember.avatar_url));
    } else {
      setEditingStaff(null);
      setFormData({
        name: "",
        nickname: "",
        email: "",
        password: "",
        role: "staff",
        notify_line: false,
        line_user_id: "",
        salonboard_staff_id: "",
        salonboard_name: "",
      });
      setAvatarPreview(null);
    }
    setAvatarFile(null);
    setDialogOpen(true);
  };

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAvatarFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setAvatarPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleRemoveAvatar = () => {
    setAvatarFile(null);
    setAvatarPreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleSubmit = async () => {
    try {
      setUploading(true);
      let staffId: string;

      if (editingStaff) {
        const updateData: {
          name: string;
          nickname: string;
          email: string;
          role: Staff["role"];
          notify_line: boolean;
          line_user_id: string;
          salonboard_staff_id: string;
          salonboard_name: string;
          password?: string;
        } = {
          name: formData.name,
          nickname: formData.nickname,
          email: formData.email,
          role: formData.role,
          notify_line: formData.notify_line,
          line_user_id: formData.line_user_id,
          salonboard_staff_id: formData.salonboard_staff_id,
          salonboard_name: formData.salonboard_name,
        };
        if (formData.password) {
          updateData.password = formData.password;
        }
        await staffApi.update(editingStaff.id, updateData);
        staffId = editingStaff.id;
      } else {
        return;
      }

      // Upload avatar if selected
      if (avatarFile) {
        await staffApi.uploadAvatar(staffId, avatarFile);
      }

      await fetchStaff();
      setDialogOpen(false);
    } catch (error) {
      console.error("Failed to save staff:", error);
    } finally {
      setUploading(false);
    }
  };

  const handleApproveEmail = async (staffMember: Staff) => {
    if (!confirm(`${staffMember.name}のメール認証を承認しますか？`)) return;
    try {
      await staffApi.approveEmail(staffMember.id);
      await fetchStaff();
    } catch (error) {
      console.error("Failed to approve email:", error);
    }
  };

  const handleToggleActive = async (staffMember: Staff) => {
    try {
      await staffApi.update(staffMember.id, { is_active: staffMember.is_active ? 0 : 1 });
      await fetchStaff();
    } catch (error) {
      console.error("Failed to toggle staff:", error);
      alert(error instanceof Error ? error.message : "スタッフの有効/無効の切り替えに失敗しました");
    }
  };

  const handleToggleVisibility = async (staffMember: Staff) => {
    if (!currentStore) return;
    try {
      const newVisible = !staffMember.is_visible_to_customer;
      await staffApi.updateStoreVisibility(staffMember.id, currentStore.id, newVisible);
      setStaffList((prev) =>
        prev.map((s) =>
          s.id === staffMember.id ? { ...s, is_visible_to_customer: newVisible ? 1 : 0 } : s
        )
      );
    } catch (error) {
      console.error("Failed to toggle visibility:", error);
      alert(error instanceof Error ? error.message : "表示設定の切り替えに失敗しました");
    }
  };

  const handleRetire = async (staffMember: Staff) => {
    const isRetired = !!staffMember.retired_at;
    const message = isRetired
      ? `${staffMember.name}の退職を取り消しますか？\n再びログインできるようになります。`
      : `${staffMember.name}を退職にしますか？\nお客様への表示がOFFになり、ログインもできなくなります。`;
    if (!confirm(message)) return;
    try {
      await staffApi.update(staffMember.id, {
        retired_at: isRetired ? null : new Date().toISOString().slice(0, 10),
      });
      await fetchStaff();
      alert(isRetired ? `${staffMember.name}の退職を取り消しました。` : `${staffMember.name}を退職にしました（ログイン不可・お客様非表示）。`);
    } catch (error) {
      console.error("Failed to retire staff:", error);
      alert(error instanceof Error ? error.message : "退職処理に失敗しました");
    }
  };

  // スタッフ削除はsystemアプリ(system_admin)に集約。adminからは削除を提供しない。

  const getRoleName = (role: Staff["role"]) => {
    switch (role) {
      case "system_admin":
        return "システム管理者";
      case "owner":
        return "オーナー";
      case "manager":
        return "ディレクター";
      case "staff":
        return "スタッフ";
    }
  };

  const getRoleBadge = (role: Staff["role"]) => {
    switch (role) {
      case "system_admin":
        return <Badge variant="destructive">{getRoleName(role)}</Badge>;
      case "owner":
        return <Badge variant="default">{getRoleName(role)}</Badge>;
      case "manager":
        return <Badge variant="secondary">{getRoleName(role)}</Badge>;
      case "staff":
        return <Badge variant="outline">{getRoleName(role)}</Badge>;
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl md:text-2xl font-bold">スタッフ管理</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>スタッフ編集</DialogTitle>
              <DialogDescription>
                スタッフ情報を入力してください
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>プロフィール写真</Label>
                <div className="flex items-center gap-4">
                  <div className="relative">
                    {avatarPreview ? (
                      <>
                        <Avatar className="h-20 w-20">
                          <AvatarImage src={avatarPreview} />
                          <AvatarFallback className="text-xl">{formData.name.charAt(0) || "?"}</AvatarFallback>
                        </Avatar>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          className="absolute -top-2 -right-2 h-6 w-6 p-0 rounded-full"
                          onClick={handleRemoveAvatar}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        className="h-20 w-20 rounded-full flex flex-col gap-1"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <Camera className="h-6 w-6" />
                        <span className="text-xs">追加</span>
                      </Button>
                    )}
                  </div>
                  {avatarPreview && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      変更
                    </Button>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleAvatarChange}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>氏名</Label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>ニックネーム</Label>
                <Input
                  value={formData.nickname}
                  placeholder="表示名（お客様に表示される名前）"
                  onChange={(e) => setFormData({ ...formData, nickname: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>メールアドレス</Label>
                <Input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>パスワード（変更する場合のみ）</Label>
                <Input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>権限</Label>
                <Select
                  value={formData.role}
                  onValueChange={(value) =>
                    setFormData({ ...formData, role: value as Staff["role"] })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="staff">スタッフ</SelectItem>
                    <SelectItem value="manager">ディレクター</SelectItem>
                    <SelectItem value="owner">オーナー</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="border-t pt-4 mt-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Bell className="h-4 w-4 text-green-500" />
                        <Label className="font-medium">LINE通知</Label>
                      </div>
                      <Switch
                        checked={formData.notify_line}
                        onCheckedChange={(checked) =>
                          setFormData({ ...formData, notify_line: checked })
                        }
                      />
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">
                      新規予約が入った時にLINEで通知を受け取ります
                    </p>
                    {formData.notify_line && (
                      <div className="space-y-2">
                        <Label>LINE User ID</Label>
                        <Input
                          type="text"
                          placeholder="U1234567890abcdef..."
                          value={formData.line_user_id}
                          onChange={(e) =>
                            setFormData({ ...formData, line_user_id: e.target.value })
                          }
                        />
                        <p className="text-xs text-muted-foreground">
                          店舗のLINE公式アカウントと友だちになった際に取得できるUser IDを入力してください。
                          LINEで「ID確認」と送信すると、あなたのUser IDが表示されます。
                        </p>
                      </div>
                    )}
                  </div>
                  <div className="border-t pt-4 mt-4">
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label className="font-medium">サロンボード スタッフ名</Label>
                        <Input
                          type="text"
                          placeholder="サロンボードに登録されている名前"
                          value={formData.salonboard_name}
                          onChange={(e) =>
                            setFormData({ ...formData, salonboard_name: e.target.value })
                          }
                        />
                        <p className="text-xs text-muted-foreground">
                          サロンボードに登録されている名前。CSV予約インポート時のスタッフマッチングに使用します
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label className="font-medium">サロンボード スタッフID</Label>
                        <Input
                          type="text"
                          placeholder="サロンボード上のスタッフID"
                          value={formData.salonboard_staff_id}
                          onChange={(e) =>
                            setFormData({ ...formData, salonboard_staff_id: e.target.value })
                          }
                        />
                        <img
                          src="/images/salonboard-staff-id.png"
                          alt="サロンボードのURLに含まれるstaffId"
                          className="rounded-md border mt-2"
                        />
                        <p className="text-xs text-muted-foreground">
                          サロンボードで新規予約を作成した時のURLに含まれる「staffId=」の後の番号を登録してください
                        </p>
                      </div>
                    </div>
                  </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                キャンセル
              </Button>
              <Button onClick={handleSubmit} disabled={uploading}>
                {uploading ? "保存中..." : "更新"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* スタッフ招待 */}
      <Card>
        <CardHeader className="py-3 md:py-6">
          <CardTitle className="text-base md:text-lg flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            スタッフ招待
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            スタッフの6桁IDを入力して、{currentStore?.name || "この店舗"}に招待します
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {inviteError && (
            <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive">{inviteError}</div>
          )}
          <div className="flex gap-2">
            <Input
              placeholder="6桁のスタッフID"
              value={inviteCode}
              onChange={(e) => {
                setInviteCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                setInviteFoundStaff(null);
                setInviteError("");
              }}
              maxLength={6}
              className="font-mono text-lg tracking-widest max-w-[200px]"
            />
            <Button onClick={handleInviteSearch} disabled={inviteSearching || inviteCode.length !== 6}>
              {inviteSearching ? "検索中..." : "検索"}
            </Button>
          </div>
          {inviteFoundStaff && (
            <div className="rounded-lg border p-4 space-y-3">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarImage src={inviteFoundStaff.avatar_url ? getImageUrl(inviteFoundStaff.avatar_url) || "" : ""} />
                  <AvatarFallback>{inviteFoundStaff.name.charAt(0)}</AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-medium">{inviteFoundStaff.name}</p>
                  <p className="text-sm text-muted-foreground">{inviteFoundStaff.email}</p>
                </div>
              </div>
              {inviteFoundStaff.email_verified === 0 && (
                <p className="text-sm text-destructive">このスタッフはメール認証が完了していません</p>
              )}
              <div className="flex items-center gap-3">
                <div className="space-y-1">
                  <Label>権限</Label>
                  <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as Staff["role"])}>
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
                  onClick={handleInviteSend}
                  disabled={!inviteFoundStaff || inviteFoundStaff.email_verified === 0 || inviteSending}
                  className="mt-auto"
                >
                  {inviteSending ? "送信中..." : "招待を送信"}
                </Button>
              </div>
            </div>
          )}
          {/* 招待履歴 */}
          {invitations.length > 0 && (
            <div className="border-t pt-4 space-y-2">
              <p className="text-sm font-medium text-muted-foreground">招待履歴</p>
              {invitations.slice(0, 5).map((inv) => (
                <div key={inv.id} className="flex items-center gap-3 rounded-lg border p-3">
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={inv.avatar_url ? getImageUrl(inv.avatar_url) || "" : ""} />
                    <AvatarFallback>{inv.staff_name.charAt(0)}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{inv.staff_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {inv.role === "manager" ? "ディレクター" : "スタッフ"} / {inv.invited_by_name}が招待
                    </p>
                  </div>
                  <Badge variant={inv.status === "accepted" ? "default" : inv.status === "rejected" ? "destructive" : "secondary"} className="shrink-0">
                    {inv.status === "accepted" ? "承認済" : inv.status === "rejected" ? "辞退" : "保留中"}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3 md:py-6">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base md:text-lg">
              スタッフ一覧
              <span className="ml-2 text-sm md:text-base font-normal text-muted-foreground">
                ({staffList.length}名)
              </span>
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {staffList.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              スタッフがいません
            </div>
          ) : (
            <div className="space-y-2 md:space-y-3">
              {staffList.map((staffMember, index) => (
                <div
                  key={staffMember.id}
                  className={`rounded-lg border p-3 md:p-4 flex gap-2 ${
                    !staffMember.is_active || staffMember.retired_at ? "opacity-50" : ""
                  }`}
                >
                  {/* 並び替えボタン */}
                  <div className="flex flex-col justify-center gap-0.5 shrink-0">
                    <button
                      className="p-0.5 rounded hover:bg-muted disabled:opacity-30"
                      disabled={index === 0}
                      onClick={() => handleMoveStaff(index, "up")}
                    >
                      <ChevronUp className="h-4 w-4 text-muted-foreground" />
                    </button>
                    <button
                      className="p-0.5 rounded hover:bg-muted disabled:opacity-30"
                      disabled={index === staffList.length - 1}
                      onClick={() => handleMoveStaff(index, "down")}
                    >
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </div>
                  <div className="flex-1 min-w-0">
                  {/* モバイルレイアウト */}
                  <div className="md:hidden">
                    <div className="flex items-start gap-3">
                      <Avatar className="h-10 w-10 shrink-0">
                        {staffMember.avatar_url && <AvatarImage src={getImageUrl(staffMember.avatar_url) || undefined} />}
                        <AvatarFallback>{staffMember.name.charAt(0)}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium">{staffMember.name}</span>
                            {staffMember.nickname && (
                              <span className="text-xs text-muted-foreground">({staffMember.nickname})</span>
                            )}
                            {staffMember.notify_line === 1 && (
                              <span title="LINE通知ON">
                                <Bell className="h-3 w-3 text-green-500" />
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            {getRoleBadge(staffMember.role)}
                            {!staffMember.is_active && (
                              <Badge variant="outline" className="text-muted-foreground text-xs">
                                無効
                              </Badge>
                            )}
                            {staffMember.retired_at && (
                              <Badge variant="destructive" className="text-xs">
                                退職
                              </Badge>
                            )}
                            {staffMember.email_verified === 0 && (
                              <Badge variant="destructive" className="text-xs">
                                未認証
                              </Badge>
                            )}
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground truncate mt-0.5">
                          {staffMember.email}
                        </div>
                        {staffMember.salonboard_name && (
                          <div className="flex flex-wrap gap-x-3 mt-0.5">
                            <span className="text-[10px] text-muted-foreground">SB: {staffMember.salonboard_name}</span>
                          </div>
                        )}
                        {staffMember.email_verified === 0 && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="mt-1 h-6 text-xs"
                            onClick={() => handleApproveEmail(staffMember)}
                          >
                            メール認証を承認
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 pt-2 border-t space-y-2">
                      <div className="text-xs text-muted-foreground">
                        {staffMember.retired_at
                          ? `退職: ${formatDate(staffMember.retired_at, "date")}`
                          : `登録: ${formatDate(staffMember.created_at, "date")}`}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 w-8 p-0"
                          onClick={() => router.push(`/customers?staff_id=${staffMember.id}`)}
                          title="担当顧客"
                        >
                          <Users className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className={`h-8 w-8 p-0 ${staffMember.retired_at ? "text-destructive" : ""}`}
                          onClick={() => handleRetire(staffMember)}
                          title={staffMember.retired_at ? "退職取り消し" : "退職にする"}
                        >
                          <UserMinus className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 w-8 p-0"
                          onClick={() => handleToggleVisibility(staffMember)}
                          title={staffMember.is_visible_to_customer ? "お客様に表示中" : "お客様に非表示"}
                        >
                          {staffMember.is_visible_to_customer ? (
                            <Eye className="h-4 w-4 text-primary" />
                          ) : (
                            <EyeOff className="h-4 w-4 text-muted-foreground" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 w-8 p-0"
                          onClick={() => handleToggleActive(staffMember)}
                          title={staffMember.is_active ? "無効にする" : "有効にする"}
                        >
                          {staffMember.is_active ? (
                            <UserX className="h-4 w-4" />
                          ) : (
                            <UserCheck className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0"
                          onClick={() => {
                            setSettingsStaff(staffMember);
                            setSettingsDialogOpen(true);
                          }}
                        >
                          <Settings className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0"
                          title="受付QR"
                          onClick={() => setQrStaff(staffMember)}
                        >
                          <QrCode className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0"
                          onClick={() => handleOpenDialog(staffMember)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        {/* 削除はsystemアプリ(system_admin)のみ — adminからは非表示 */}
                      </div>
                    </div>
                  </div>

                  {/* デスクトップレイアウト */}
                  <div className="hidden md:flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <Avatar>
                        {staffMember.avatar_url && <AvatarImage src={getImageUrl(staffMember.avatar_url) || undefined} />}
                        <AvatarFallback>{staffMember.name.charAt(0)}</AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{staffMember.name}</span>
                          {staffMember.nickname && (
                            <span className="text-sm text-muted-foreground">({staffMember.nickname})</span>
                          )}
                          {getRoleBadge(staffMember.role)}
                          {staffMember.notify_line === 1 && (
                            <span title="LINE通知ON">
                              <Bell className="h-4 w-4 text-green-500" />
                            </span>
                          )}
                          {!staffMember.is_active && (
                            <Badge variant="outline" className="text-muted-foreground">
                              無効
                            </Badge>
                          )}
                          {staffMember.retired_at && (
                            <Badge variant="destructive">
                              退職 {formatDate(staffMember.retired_at, "date")}
                            </Badge>
                          )}
                          {staffMember.email_verified === 0 && (
                            <Badge variant="destructive">
                              未認証
                            </Badge>
                          )}
                          {staffMember.is_visible_to_customer === 0 && !staffMember.retired_at && (
                            <Badge variant="outline">
                              <EyeOff className="h-3 w-3 mr-1" />
                              非表示
                            </Badge>
                          )}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {staffMember.email}
                          {staffMember.salonboard_name && (
                            <span className="ml-3 text-xs">
                              <span className="mr-3">SB: {staffMember.salonboard_name}</span>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      {staffMember.email_verified === 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleApproveEmail(staffMember)}
                        >
                          メール認証を承認
                        </Button>
                      )}
                      <div className="text-sm text-muted-foreground">
                        {staffMember.retired_at
                          ? `退職: ${formatDate(staffMember.retired_at, "date")}`
                          : `登録: ${formatDate(staffMember.created_at, "date")}`}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => router.push(`/customers?staff_id=${staffMember.id}`)}
                          title="担当顧客"
                        >
                          <Users className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className={staffMember.retired_at ? "text-destructive" : ""}
                          onClick={() => handleRetire(staffMember)}
                          title={staffMember.retired_at ? "退職取り消し" : "退職にする"}
                        >
                          <UserMinus className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleToggleVisibility(staffMember)}
                          title={staffMember.is_visible_to_customer ? "お客様に表示中" : "お客様に非表示"}
                        >
                          {staffMember.is_visible_to_customer ? (
                            <Eye className="h-4 w-4 text-primary" />
                          ) : (
                            <EyeOff className="h-4 w-4 text-muted-foreground" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleToggleActive(staffMember)}
                          title={staffMember.is_active ? "無効にする" : "有効にする"}
                        >
                          {staffMember.is_active ? (
                            <UserX className="h-4 w-4" />
                          ) : (
                            <UserCheck className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setSettingsStaff(staffMember);
                            setSettingsDialogOpen(true);
                          }}
                        >
                          <Settings className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleOpenDialog(staffMember)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        {/* 削除はsystemアプリ(system_admin)のみ — adminからは非表示 */}
                      </div>
                    </div>
                  </div>
                  </div>{/* flex-1 wrapper */}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Staff Settings Dialog */}
      <StaffSettingsDialog
        open={settingsDialogOpen}
        onOpenChange={setSettingsDialogOpen}
        staffMember={settingsStaff}
        storeId={currentStore?.id || ""}
      />

      {/* 受付QR Dialog */}
      <WalkinQrDialog
        open={!!qrStaff}
        onOpenChange={(o) => !o && setQrStaff(null)}
        storeId={currentStore?.id || ""}
        staffId={qrStaff?.id || ""}
        staffName={qrStaff?.nickname || qrStaff?.name || ""}
        storeName={currentStore?.name}
      />

    </div>
  );
}
