"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  Edit,
  Share2,
  Image as ImageIcon,
  Upload,
  Trash2,
  Save,
  Pencil,
  StickyNote,
  ChevronDown,
  ChevronUp,
  ScanLine,
  Loader2,
  FileCheck,
} from "lucide-react";
import {
  karutes,
  menus as menusApi,
  reservations,
  counselingSheets,
  type Karute,
  type KaruteImage,
  type KaruteMenu,
  type Menu,
  type Reservation,
} from "@/lib/api";
import { formatDate, formatPrice, formatDuration, getImageUrl, cn } from "@/lib/utils";
import { useStore } from "@/contexts/store-context";
import { MenuSelector } from "@/components/menu-selector";
import { FaceCanvas } from "@/components/face-canvas";

type ImageType = "before" | "after" | "other";

function getKaruteIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const idx = pathParts.indexOf("karutes");
  if (
    idx !== -1 &&
    pathParts[idx + 1] &&
    pathParts[idx + 1] !== "placeholder"
  ) {
    return pathParts[idx + 1];
  }
  return null;
}

export default function KaruteDetail({ id: propsId }: { id: string }) {
  const router = useRouter();
  const { currentStore, staff: currentStaff } = useStore();

  const [karuteId, setKaruteId] = useState<string>(() => {
    const urlId = getKaruteIdFromUrl();
    return urlId || propsId;
  });

  useEffect(() => {
    const urlId = getKaruteIdFromUrl();
    if (urlId) {
      setKaruteId(urlId);
    }
  }, []);

  const [karute, setKarute] = useState<Karute | null>(null);
  const [images, setImages] = useState<KaruteImage[]>([]);
  const [karuteMenus, setKaruteMenus] = useState<KaruteMenu[]>([]);
  const [storeMenus, setStoreMenus] = useState<Menu[]>([]);
  const [categoryColors, setCategoryColors] = useState<
    Record<string, string>
  >({});
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadImageType, setUploadImageType] = useState<ImageType>("other");
  const [uploadCaption, setUploadCaption] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Edit form state
  const [editMenuIds, setEditMenuIds] = useState<string[]>([]);
  const [editMemo, setEditMemo] = useState("");
  const [editAssistantMemo, setEditAssistantMemo] = useState("");
  const [editFaceDrawing, setEditFaceDrawing] = useState<string | null>(null);
  const [showSketch, setShowSketch] = useState(false);

  // Delete state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // OCR state
  const [ocrLoading, setOcrLoading] = useState(false);
  const ocrFileInputRef = useRef<HTMLInputElement>(null);

  const handleOcrUpload = useCallback(async (file: File) => {
    setOcrLoading(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const res = await counselingSheets.ocr(base64, file.type, [
        {
          id: "memo",
          label: "施術内容、髪の状態、カラーレシピ、パーマ情報、スタイリングメモなど、画像に書かれている全ての施術記録情報",
          type: "text",
        },
      ]);

      const extracted = res.data.memo as string;
      if (extracted) {
        setEditMemo((prev) => prev ? `${prev}\n\n${extracted}` : extracted);
      }
    } catch (error) {
      console.error("OCR failed:", error);
    } finally {
      setOcrLoading(false);
    }
  }, []);

  // Legacy fields display toggle
  const [showLegacy, setShowLegacy] = useState(false);

  // Fetch karute data
  const hasFetched = useRef(false);
  useEffect(() => {
    if (karuteId === "placeholder") return;
    const fetchKarute = async () => {
      // Only show loading spinner on initial fetch
      if (!hasFetched.current) setLoading(true);
      try {
        const data = await karutes.get(karuteId);
        setKarute(data.karute);
        setImages(data.images);
        setKaruteMenus(data.menus || []);

        // Only populate edit form on initial fetch (not re-fetches triggered by context changes)
        if (!hasFetched.current) {
          populateEditForm(data.karute, data.menus || []);
        }
        hasFetched.current = true;

        // Fetch linked reservation if available
        if (data.karute.reservation_id) {
          try {
            const resData = await reservations.get(data.karute.reservation_id);
            setReservation(resData.reservation);
          } catch { /* ignore */ }
        }

        // Auto-enter edit mode for new (empty) karutes, only if creator
        const k = data.karute;
        const isCreator =
          currentStaff?.role === "system_admin" ||
          currentStaff?.id === k.staff_id;
        if (
          isCreator &&
          !k.memo &&
          !k.assistant_memo &&
          !k.face_drawing &&
          !k.menu_content &&
          (data.menus || []).length === 0
        ) {
          setEditing(true);
        }
      } catch (error) {
        console.error("Failed to fetch karute:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchKarute();
  }, [karuteId, currentStaff?.id, currentStaff?.role]);

  // Fetch store menus for selection
  useEffect(() => {
    if (!currentStore?.id) return;
    const fetchMenus = async () => {
      try {
        const data = await menusApi.list(currentStore.id);
        setStoreMenus(data.menus);
        setCategoryColors(data.categoryColors || {});
      } catch (error) {
        console.error("Failed to fetch menus:", error);
      }
    };
    fetchMenus();
  }, [currentStore?.id]);

  const populateEditForm = (k: Karute, menus: KaruteMenu[]) => {
    setEditMemo(k.memo || "");
    setEditAssistantMemo(k.assistant_memo || "");
    setEditFaceDrawing(k.face_drawing || null);
    setEditMenuIds(menus.map((m) => m.menu_id).filter(Boolean) as string[]);
    setShowSketch(!!k.face_drawing);
  };

  const handleSave = async () => {
    if (!karute) return;
    setSaving(true);
    try {
      const { karute: updated } = await karutes.update(karuteId, {
        memo: editMemo || null,
        assistant_memo: editAssistantMemo || null,
        face_drawing: editFaceDrawing,
        menu_ids: editMenuIds,
      });
      setKarute(updated);
      // Re-fetch to get updated menus
      const data = await karutes.get(karuteId);
      setKaruteMenus(data.menus || []);
      setEditing(false);
    } catch (error) {
      console.error("Failed to update karute:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    if (karute) populateEditForm(karute, karuteMenus);
    setEditing(false);
  };

  const handleDelete = async () => {
    if (!karute) return;
    setDeleting(true);
    try {
      await karutes.delete(karuteId);
      window.location.href = `/customers?id=${karute.customer_id}`;
    } catch (error) {
      console.error("Failed to delete karute:", error);
    } finally {
      setDeleting(false);
      setDeleteDialogOpen(false);
    }
  };

  const handleShare = async () => {
    if (!karute) return;
    setSharing(true);
    try {
      await karutes.share(karuteId);
      setKarute({ ...karute, is_shared_to_customer: 1 });
    } catch (error) {
      console.error("Failed to share karute:", error);
    } finally {
      setSharing(false);
    }
  };

  const handleUploadImage = async (file: File) => {
    setUploading(true);
    try {
      const { image } = await karutes.uploadImage(
        karuteId,
        file,
        uploadImageType,
        uploadCaption || undefined
      );
      setImages((prev) => [...prev, image]);
      setUploadDialogOpen(false);
      setUploadCaption("");
      setUploadImageType("other");
    } catch (error) {
      console.error("Failed to upload image:", error);
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteImage = async (imageId: string) => {
    if (!confirm("この画像を削除しますか？")) return;
    try {
      await karutes.deleteImage(karuteId, imageId);
      setImages((prev) => prev.filter((img) => img.id !== imageId));
    } catch (error) {
      console.error("Failed to delete image:", error);
    }
  };

  const getImageTypeLabel = (type: KaruteImage["image_type"]) => {
    switch (type) {
      case "before":
        return "施術前";
      case "after":
        return "施術後";
      case "other":
      default:
        return "その他";
    }
  };

  // Check if karute has legacy data
  const hasLegacyData =
    karute &&
    (karute.menu_content ||
      karute.hair_condition ||
      karute.color_formula ||
      karute.perm_info ||
      karute.styling_notes ||
      karute.customer_feedback ||
      karute.next_suggestion ||
      karute.internal_memo);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  if (!karute) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-muted-foreground">カルテが見つかりません</p>
        <Button variant="outline" onClick={() => router.back()}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          一覧に戻る
        </Button>
      </div>
    );
  }

  const canEdit =
    currentStaff?.role === "system_admin" ||
    currentStaff?.id === karute.staff_id;

  const beforeImages = images.filter((img) => img.image_type === "before");
  const afterImages = images.filter((img) => img.image_type === "after");
  const otherImages = images.filter((img) => img.image_type === "other");

  return (
    <div className="space-y-4 pb-8">
      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={() => router.back()}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0">
            <h1 className="text-xl font-bold truncate">
              {karute.customer_name || "不明"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {formatDate(karute.visit_date, "date")}
              {karute.staff_name && ` / ${karute.staff_name}`}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 ml-auto">
            {karute.has_consent ? (
              <Badge variant="success">
                <FileCheck className="mr-1 h-3 w-3" />
                同意済み
              </Badge>
            ) : null}
            {karute.is_shared_to_customer === 1 && (
              <Badge variant="success">
                <Share2 className="mr-1 h-3 w-3" />
                共有済
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {karute.is_shared_to_customer !== 1 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleShare}
              disabled={sharing}
            >
              <Share2 className="mr-1 h-4 w-4" />
              {sharing ? "共有中..." : "共有"}
            </Button>
          )}
          {canEdit && (
            <div className="ml-auto flex items-center gap-2">
              {editing ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCancelEdit}
                  >
                    キャンセル
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={saving}>
                    <Save className="mr-1 h-4 w-4" />
                    {saving ? "保存中..." : "保存"}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing(true)}
                  >
                    <Edit className="mr-1 h-4 w-4" />
                    編集
                  </Button>
                  <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                    <DialogTrigger asChild>
                      <Button variant="outline" size="sm" className="text-destructive">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>カルテを削除</DialogTitle>
                        <DialogDescription>
                          このカルテを削除しますか？画像も含めて完全に削除されます。この操作は取り消せません。
                        </DialogDescription>
                      </DialogHeader>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
                          キャンセル
                        </Button>
                        <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
                          {deleting ? "削除中..." : "削除する"}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Reservation Info (read-only) */}
      <Card className="bg-muted/50">
        <CardContent className="p-4 space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground shrink-0">施術日</span>
            <span className="font-medium">{formatDate(karute.visit_date, "date")}</span>
          </div>
          {reservation && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground shrink-0">時間</span>
              <span className="font-medium">
                {formatDate(reservation.start_at, "time")}〜{formatDate(reservation.end_at, "time")}
                {reservation.duration && (
                  <span className="ml-1 text-muted-foreground text-xs">({formatDuration(reservation.duration)})</span>
                )}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground shrink-0">お客様</span>
            <span className="font-medium">{karute.customer_name || "不明"}</span>
          </div>
          {karuteMenus.length > 0 && (
            <div>
              <span className="text-muted-foreground">メニュー</span>
              <div className="mt-1 space-y-0.5">
                {karuteMenus.map((m) => (
                  <div key={m.id} className="flex items-center justify-between">
                    <span>{m.menu_name}</span>
                    <span className="text-muted-foreground text-xs">{formatPrice(m.price)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 1: Photos */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">
            <ImageIcon className="mr-1 inline h-4 w-4" />
            写真 ({images.length})
          </CardTitle>
          {canEdit && (
            <Dialog
              open={uploadDialogOpen}
              onOpenChange={setUploadDialogOpen}
            >
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <Upload className="mr-1 h-4 w-4" />
                  追加
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>写真をアップロード</DialogTitle>
                  <DialogDescription>
                    施術前後の写真を追加します
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label>写真の種類</Label>
                    <div className="flex gap-2">
                      {(["before", "after", "other"] as ImageType[]).map(
                        (type) => (
                          <Button
                            key={type}
                            variant={
                              uploadImageType === type ? "default" : "outline"
                            }
                            size="sm"
                            onClick={() => setUploadImageType(type)}
                          >
                            {getImageTypeLabel(type)}
                          </Button>
                        )
                      )}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="caption">キャプション</Label>
                    <Input
                      id="caption"
                      placeholder="写真の説明（任意）"
                      value={uploadCaption}
                      onChange={(e) => setUploadCaption(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>ファイル選択</Label>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="block w-full text-sm text-muted-foreground file:mr-4 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setUploadDialogOpen(false)}
                  >
                    キャンセル
                  </Button>
                  <Button
                    disabled={uploading}
                    onClick={() => {
                      const file = fileInputRef.current?.files?.[0];
                      if (file) handleUploadImage(file);
                    }}
                  >
                    {uploading ? "アップロード中..." : "アップロード"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </CardHeader>
        <CardContent>
          {images.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
              <ImageIcon className="mb-2 h-8 w-8" />
              <p className="text-sm">写真がありません</p>
            </div>
          ) : (
            <div className="space-y-4">
              {beforeImages.length > 0 && (
                <ImageGroup
                  title="施術前"
                  images={beforeImages}
                  onDelete={canEdit ? handleDeleteImage : undefined}
                />
              )}
              {afterImages.length > 0 && (
                <ImageGroup
                  title="施術後"
                  images={afterImages}
                  onDelete={canEdit ? handleDeleteImage : undefined}
                />
              )}
              {otherImages.length > 0 && (
                <ImageGroup
                  title="その他"
                  images={otherImages}
                  onDelete={canEdit ? handleDeleteImage : undefined}
                />
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 2: Menu Selection */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">メニュー</CardTitle>
        </CardHeader>
        <CardContent>
          {editing ? (
            <MenuSelector
              menus={storeMenus}
              selectedMenuIds={editMenuIds}
              onSelectionChange={setEditMenuIds}
              staffId={karute.staff_id}
              categoryColors={categoryColors}
            />
          ) : karuteMenus.length > 0 ? (
            <div className="space-y-2">
              {karuteMenus.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between text-sm"
                >
                  <span>{m.menu_name}</span>
                  <span className="text-muted-foreground">
                    {m.price.toLocaleString()}円
                  </span>
                </div>
              ))}
              <div className="flex items-center justify-between pt-2 border-t">
                <span className="text-sm font-medium">
                  合計（{karuteMenus.length}件）
                </span>
                <span className="text-base font-bold">
                  {karuteMenus
                    .reduce((sum, m) => sum + m.price, 0)
                    .toLocaleString()}
                  円
                </span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">未選択</p>
          )}
        </CardContent>
      </Card>

      {/* Section 3: Memo */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            <StickyNote className="mr-1 inline h-4 w-4" />
            メモ
          </CardTitle>
        </CardHeader>
        <CardContent>
          {editing ? (
            <div className="space-y-2">
              <input
                ref={ocrFileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleOcrUpload(file);
                  e.target.value = "";
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={ocrLoading}
                onClick={() => ocrFileInputRef.current?.click()}
              >
                {ocrLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    画像を読み込み中...
                  </>
                ) : (
                  <>
                    <ScanLine className="mr-2 h-4 w-4" />
                    画像から読み込む
                  </>
                )}
              </Button>
              <Textarea
                value={editMemo}
                onChange={(e) => setEditMemo(e.target.value)}
                placeholder="施術内容、髪の状態、カラーレシピなど"
                rows={4}
              />
            </div>
          ) : (
            <p
              className={cn(
                "text-sm whitespace-pre-wrap",
                !karute.memo && "text-muted-foreground italic"
              )}
            >
              {karute.memo || "未記入"}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Section 4: Sketch */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            <Pencil className="mr-1 inline h-4 w-4" />
            スケッチ
          </CardTitle>
        </CardHeader>
        <CardContent>
          {editing ? (
            <div className="space-y-3">
              {!showSketch ? (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => setShowSketch(true)}
                >
                  <Pencil className="mr-1 h-4 w-4" />
                  スケッチを描く
                </Button>
              ) : (
                <FaceCanvas
                  initialImage={editFaceDrawing || undefined}
                  onSave={(dataUrl) => setEditFaceDrawing(dataUrl)}
                />
              )}
            </div>
          ) : karute.face_drawing ? (
            <div className="flex items-center justify-center rounded-lg border bg-white p-2">
              <img
                src={karute.face_drawing}
                alt="スケッチ"
                className="max-w-full h-auto"
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">未記入</p>
          )}
        </CardContent>
      </Card>

      {/* Section 5: Assistant Memo */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">アシスタントメモ</CardTitle>
        </CardHeader>
        <CardContent>
          {editing ? (
            <Textarea
              value={editAssistantMemo}
              onChange={(e) => setEditAssistantMemo(e.target.value)}
              placeholder="アシスタント向けの共有メモ"
              rows={3}
            />
          ) : (
            <p
              className={cn(
                "text-sm whitespace-pre-wrap",
                !karute.assistant_memo && "text-muted-foreground italic"
              )}
            >
              {karute.assistant_memo || "未記入"}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Legacy Data (read-only) */}
      {hasLegacyData && (
        <Card>
          <CardHeader className="pb-3">
            <button
              type="button"
              onClick={() => setShowLegacy(!showLegacy)}
              className="flex items-center justify-between w-full"
            >
              <CardTitle className="text-base text-muted-foreground">
                過去の記録
              </CardTitle>
              {showLegacy ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
          </CardHeader>
          {showLegacy && (
            <CardContent className="space-y-3 pt-0">
              {karute.menu_content && (
                <LegacyField title="施術内容" value={karute.menu_content} />
              )}
              {karute.hair_condition && (
                <LegacyField title="髪の状態" value={karute.hair_condition} />
              )}
              {karute.color_formula && (
                <LegacyField
                  title="カラーレシピ"
                  value={karute.color_formula}
                />
              )}
              {karute.perm_info && (
                <LegacyField title="パーマ情報" value={karute.perm_info} />
              )}
              {karute.styling_notes && (
                <LegacyField
                  title="スタイリングノート"
                  value={karute.styling_notes}
                />
              )}
              {karute.customer_feedback && (
                <LegacyField
                  title="お客様の反応"
                  value={karute.customer_feedback}
                />
              )}
              {karute.next_suggestion && (
                <LegacyField
                  title="次回提案"
                  value={karute.next_suggestion}
                />
              )}
              {karute.internal_memo && (
                <LegacyField title="内部メモ" value={karute.internal_memo} />
              )}
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}

// Legacy field (read-only)
function LegacyField({ title, value }: { title: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <p className="text-sm whitespace-pre-wrap">{value}</p>
    </div>
  );
}

// Image group component
function ImageGroup({
  title,
  images,
  onDelete,
}: {
  title: string;
  images: KaruteImage[];
  onDelete?: (id: string) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-muted-foreground">{title}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {images.map((img) => (
          <div key={img.id} className="group relative">
            <div className="aspect-square overflow-hidden rounded-lg border bg-muted">
              <img
                src={getImageUrl(img.image_url) || ""}
                alt={img.caption || title}
                className="h-full w-full object-cover"
              />
            </div>
            {img.caption && (
              <p className="mt-1 text-xs text-muted-foreground truncate">
                {img.caption}
              </p>
            )}
            {onDelete && (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  onDelete(img.id);
                }}
                className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
