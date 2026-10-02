"use client";

import { useEffect, useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { auth, staffApi } from "@/lib/api";
import { useStore } from "@/contexts/store-context";
import { getImageUrl } from "@/lib/utils";
import Link from "next/link";
import { ChevronRight, CalendarCog, Camera, X, QrCode } from "lucide-react";
import { WalkinQrDialog } from "@/components/walkin-qr-dialog";
import { PrelinkQrDialog } from "@/components/prelink-qr-dialog";

export default function SettingsPage() {
  const { staff, currentStore, refreshStores } = useStore();
  const [qrOpen, setQrOpen] = useState(false);
  const [prelinkQrOpen, setPrelinkQrOpen] = useState(false);
  const [nickname, setNickname] = useState("");
  const [minimoName, setMinimoName] = useState("");
  const [salonboardStaffId, setSalonboardStaffId] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Avatar state
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (staff) {
      setNickname(staff.nickname || "");
      setMinimoName(staff.minimo_name || "");
      setSalonboardStaffId(staff.salonboard_staff_id || "");
      setAvatarPreview(getImageUrl(staff.avatar_url));
    }
  }, [staff]);

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

  const handleSave = async () => {
    if (!staff) return;
    setSaving(true);
    setMessage(null);
    try {
      // Upload avatar if a new file was selected
      if (avatarFile) {
        await staffApi.uploadAvatar(staff.id, avatarFile);
        setAvatarFile(null);
      } else if (avatarPreview === null && staff.avatar_url) {
        // Avatar was removed
        await auth.updateProfile({ nickname: nickname.trim() || null, minimo_name: minimoName.trim() || null, avatar_url: "" });
        await staffApi.update(staff.id, { salonboard_staff_id: salonboardStaffId.trim() || null });
        await refreshStores();
        setMessage({ type: "success", text: "保存しました" });
        return;
      }

      await auth.updateProfile({ nickname: nickname.trim() || null, minimo_name: minimoName.trim() || null });
      await staffApi.update(staff.id, { salonboard_staff_id: salonboardStaffId.trim() || null });
      await refreshStores();
      setMessage({ type: "success", text: "保存しました" });
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "保存に失敗しました" });
    } finally {
      setSaving(false);
    }
  };

  if (!staff) return null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">設定</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">プロフィール</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Avatar + 登録名 横並び */}
          <div className="flex items-center gap-4">
            <div className="relative shrink-0">
              {avatarPreview ? (
                <>
                  <Avatar className="h-16 w-16">
                    <AvatarImage src={avatarPreview} />
                    <AvatarFallback className="text-lg">{(staff.nickname || staff.name).charAt(0)}</AvatarFallback>
                  </Avatar>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="absolute -top-1 -right-1 h-5 w-5 p-0 rounded-full"
                    onClick={handleRemoveAvatar}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="h-16 w-16 rounded-full flex flex-col gap-0.5"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Camera className="h-5 w-5" />
                  <span className="text-[10px]">追加</span>
                </Button>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground">登録名</p>
              <p className="text-sm font-medium">{staff.name}</p>
              {staff.staff_code && (
                <p className="text-xs text-muted-foreground mt-0.5">スタッフID: <span className="font-mono font-medium text-foreground">{staff.staff_code}</span></p>
              )}
              {avatarPreview && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-1 h-7 text-xs"
                  onClick={() => fileInputRef.current?.click()}
                >
                  写真を変更
                </Button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleAvatarChange}
            />
          </div>

          {/* ニックネーム + 保存 横並び */}
          <div className="space-y-1.5">
            <Label htmlFor="nickname" className="text-xs">ニックネーム</Label>
            <div className="flex items-center gap-2">
              <Input
                id="nickname"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="お客様に表示される名前"
                className="flex-1"
              />
              <Button onClick={handleSave} disabled={saving} className="shrink-0">
                {saving ? "保存中..." : "保存"}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              予約サイトでお客様に表示される名前です。未設定の場合は登録名が表示されます。
            </p>
          </div>

          {/* minimo表示名 */}
          <div className="space-y-1.5">
            <Label htmlFor="minimoName" className="text-xs">minimo表示名</Label>
            <Input
              id="minimoName"
              value={minimoName}
              onChange={(e) => setMinimoName(e.target.value)}
              placeholder="minimoで使用している名前（姓+名）"
            />
            <p className="text-[11px] text-muted-foreground">
              minimoからの予約でスタッフを自動で割り当てるために使用します。
            </p>
          </div>

          {/* サロンボード スタッフID */}
          <div className="space-y-1.5">
            <Label htmlFor="salonboardStaffId" className="text-xs">サロンボード スタッフID</Label>
            <Input
              id="salonboardStaffId"
              value={salonboardStaffId}
              onChange={(e) => setSalonboardStaffId(e.target.value)}
              placeholder="例: W000787523"
            />
            <p className="text-[11px] text-muted-foreground">
              サロンボードの予約連携で使用するスタッフIDです。
            </p>
          </div>

          {message && (
            <div
              className={`rounded-md p-2 text-sm ${
                message.type === "success"
                  ? "bg-green-50 text-green-700"
                  : "bg-destructive/15 text-destructive"
              }`}
            >
              {message.text}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-4">
          <Link href="/reservation-settings" className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CalendarCog className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="font-medium">予約受付設定</p>
                <p className="text-sm text-muted-foreground">営業時間・予約設定・個人の休日</p>
              </div>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground" />
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-4">
          <button onClick={() => setQrOpen(true)} className="flex w-full items-center justify-between" disabled={!currentStore}>
            <div className="flex items-center gap-3">
              <QrCode className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <p className="font-medium">受付QRコード</p>
                <p className="text-sm text-muted-foreground">同意書・カウンセリング受付用（印刷して掲示）</p>
              </div>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground" />
          </button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-4">
          <button onClick={() => setPrelinkQrOpen(true)} className="flex w-full items-center justify-between" disabled={!currentStore}>
            <div className="flex items-center gap-3">
              <QrCode className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <p className="font-medium">事前連携QRコード</p>
                <p className="text-sm text-muted-foreground">システム切替案内用。名前・電話の入力だけでLINE連携（同意書なし）</p>
              </div>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground" />
          </button>
        </CardContent>
      </Card>

      {currentStore && (
        <PrelinkQrDialog
          open={prelinkQrOpen}
          onOpenChange={setPrelinkQrOpen}
          storeId={currentStore.id}
          storeName={currentStore.name}
        />
      )}

      {staff && currentStore && (
        <WalkinQrDialog
          open={qrOpen}
          onOpenChange={setQrOpen}
          storeId={currentStore.id}
          staffId={staff.id}
          staffName={staff.nickname || staff.name}
          storeName={currentStore.name}
        />
      )}
    </div>
  );
}
