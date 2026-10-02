"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  ArrowLeft,
  Calendar,
  User,
  Scissors,
  Share2,
  Edit,
  Trash2,
  ImagePlus,
  X,
  Camera,
  Pencil,
  ClipboardList,
} from "lucide-react";
import { karutes, type Karute, type KaruteImage } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { FaceCanvas } from "@/components/face-canvas";
import { CounselingSheetForm } from "@/components/counseling-sheet-form";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787";

type EditForm = {
  visit_date: string;
  menu_content: string;
  hair_condition: string;
  color_formula: string;
  perm_info: string;
  styling_notes: string;
  customer_feedback: string;
  next_suggestion: string;
  internal_memo: string;
  face_drawing: string;
};

// Helper to get karute ID from URL
function getKaruteIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const karutesIndex = pathParts.indexOf('karutes');
  if (karutesIndex !== -1 && pathParts[karutesIndex + 1]) {
    const urlId = pathParts[karutesIndex + 1];
    if (urlId !== 'placeholder') {
      return urlId;
    }
  }
  return null;
}

export default function KaruteDetail({ id: propsId }: { id: string }) {
  const router = useRouter();

  // Get ID from URL immediately on mount
  const [id, setId] = useState<string>(() => {
    const urlId = getKaruteIdFromUrl();
    return urlId || propsId;
  });

  const [karute, setKarute] = useState<Karute | null>(null);
  const [images, setImages] = useState<KaruteImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [idResolved, setIdResolved] = useState(false);

  // Resolve ID on client side
  useEffect(() => {
    const urlId = getKaruteIdFromUrl();
    if (urlId && urlId !== 'placeholder') {
      setId(urlId);
    }
    setIdResolved(true);
  }, []);

  // Edit dialog
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editForm, setEditForm] = useState<EditForm>({
    visit_date: "",
    menu_content: "",
    hair_condition: "",
    color_formula: "",
    perm_info: "",
    styling_notes: "",
    customer_feedback: "",
    next_suggestion: "",
    internal_memo: "",
    face_drawing: "",
  });
  const [saving, setSaving] = useState(false);

  // Image upload
  const [isImageDialogOpen, setIsImageDialogOpen] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageType, setImageType] = useState<"before" | "after" | "other">("other");
  const [imageCaption, setImageCaption] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Delete confirmation
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteImageId, setDeleteImageId] = useState<string | null>(null);

  // Fetch karute detail
  useEffect(() => {
    // Wait for ID resolution and ensure ID is valid
    if (!idResolved || !id || id === 'placeholder') {
      return;
    }

    const fetchKarute = async () => {
      setLoading(true);
      try {
        const { karute: data, images: imgs } = await karutes.get(id);
        setKarute(data);
        setImages(imgs);
      } catch (error) {
        console.error("Failed to fetch karute:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchKarute();
  }, [id, idResolved]);

  const handleShare = async () => {
    if (!karute) return;
    try {
      await karutes.share(id);
      setKarute({ ...karute, is_shared_to_customer: 1 });
    } catch (error) {
      console.error("Failed to share karute:", error);
    }
  };

  const openEditDialog = () => {
    if (!karute) return;
    setEditForm({
      visit_date: karute.visit_date || "",
      menu_content: karute.menu_content || "",
      hair_condition: karute.hair_condition || "",
      color_formula: karute.color_formula || "",
      perm_info: karute.perm_info || "",
      styling_notes: karute.styling_notes || "",
      customer_feedback: karute.customer_feedback || "",
      next_suggestion: karute.next_suggestion || "",
      internal_memo: karute.internal_memo || "",
      face_drawing: karute.face_drawing || "",
    });
    setIsEditDialogOpen(true);
  };

  const handleSave = async () => {
    if (!karute) return;
    setSaving(true);
    try {
      const { karute: updated } = await karutes.update(id, editForm);
      setKarute({ ...karute, ...updated });
      setIsEditDialogOpen(false);
    } catch (error) {
      console.error("Failed to update karute:", error);
      alert("カルテの更新に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingImage(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("image_type", imageType);
      if (imageCaption) {
        formData.append("caption", imageCaption);
      }

      const token = localStorage.getItem("admin_token");
      const res = await fetch(`${API_URL}/api/karutes/${id}/images`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });

      if (!res.ok) {
        throw new Error("Failed to upload image");
      }

      const { image } = await res.json();
      setImages([...images, image]);
      setIsImageDialogOpen(false);
      setImageCaption("");
      setImageType("other");
    } catch (error) {
      console.error("Failed to upload image:", error);
      alert("画像のアップロードに失敗しました");
    } finally {
      setUploadingImage(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleDeleteImage = async () => {
    if (!deleteImageId) return;
    try {
      const token = localStorage.getItem("admin_token");
      const res = await fetch(`${API_URL}/api/karutes/${id}/images/${deleteImageId}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!res.ok) {
        throw new Error("Failed to delete image");
      }

      setImages(images.filter((img) => img.id !== deleteImageId));
      setDeleteImageId(null);
    } catch (error) {
      console.error("Failed to delete image:", error);
      alert("画像の削除に失敗しました");
    }
  };

  const handleDeleteKarute = async () => {
    try {
      const token = localStorage.getItem("admin_token");
      const res = await fetch(`${API_URL}/api/karutes/${id}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!res.ok) {
        throw new Error("Failed to delete karute");
      }

      router.back();
    } catch (error) {
      console.error("Failed to delete karute:", error);
      alert("カルテの削除に失敗しました");
    }
  };

  const getImageTypeLabel = (type: string) => {
    switch (type) {
      case "before":
        return "施術前";
      case "after":
        return "施術後";
      default:
        return "その他";
    }
  };

  // Show loading while resolving ID or fetching data
  if (!idResolved || loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  // If ID resolved but still placeholder, show error
  if (id === 'placeholder') {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">無効なカルテIDです</div>
      </div>
    );
  }

  if (!karute) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">カルテが見つかりません</div>
      </div>
    );
  }

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-xl md:text-2xl font-bold">カルテ詳細</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={openEditDialog}>
            <Edit className="mr-1 h-4 w-4" />
            <span className="hidden sm:inline">編集</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Tabs defaultValue="karute">
        <TabsList>
          <TabsTrigger value="karute" className="gap-1.5">
            <Scissors className="h-4 w-4" />
            カルテ
          </TabsTrigger>
          <TabsTrigger value="counseling" className="gap-1.5">
            <ClipboardList className="h-4 w-4" />
            カウンセリングシート
          </TabsTrigger>
        </TabsList>

        <TabsContent value="karute" className="mt-4 space-y-4 md:space-y-6">

      {/* Customer & Basic Info */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start gap-4">
            <Avatar className="h-12 w-12">
              <AvatarFallback className="text-lg">
                {karute.customer_name?.charAt(0) || "?"}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-lg font-semibold">{karute.customer_name}</span>
                {karute.is_shared_to_customer ? (
                  <Badge variant="success">共有済み</Badge>
                ) : (
                  <Button variant="outline" size="sm" onClick={handleShare}>
                    <Share2 className="mr-1 h-3 w-3" />
                    共有
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground flex-wrap">
                <span className="flex items-center gap-1">
                  <Calendar className="h-4 w-4" />
                  {formatDate(karute.visit_date, "date")}
                </span>
                <span className="flex items-center gap-1">
                  <User className="h-4 w-4" />
                  担当: {karute.staff_name}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Treatment Details */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Scissors className="h-4 w-4" />
            施術内容
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {karute.menu_content && (
            <div>
              <Label className="text-muted-foreground text-xs">メニュー</Label>
              <p className="mt-1">{karute.menu_content}</p>
            </div>
          )}

          {karute.hair_condition && (
            <div>
              <Label className="text-muted-foreground text-xs">髪の状態</Label>
              <p className="mt-1 whitespace-pre-wrap">{karute.hair_condition}</p>
            </div>
          )}

          {karute.color_formula && (
            <div>
              <Label className="text-muted-foreground text-xs">カラー配合</Label>
              <p className="mt-1 font-mono text-sm bg-muted px-2 py-1 rounded">
                {karute.color_formula}
              </p>
            </div>
          )}

          {karute.perm_info && (
            <div>
              <Label className="text-muted-foreground text-xs">パーマ情報</Label>
              <p className="mt-1 whitespace-pre-wrap">{karute.perm_info}</p>
            </div>
          )}

          {karute.styling_notes && (
            <div>
              <Label className="text-muted-foreground text-xs">スタイリングメモ</Label>
              <p className="mt-1 whitespace-pre-wrap">{karute.styling_notes}</p>
            </div>
          )}

          {karute.customer_feedback && (
            <div>
              <Label className="text-muted-foreground text-xs">お客様フィードバック</Label>
              <p className="mt-1 whitespace-pre-wrap">{karute.customer_feedback}</p>
            </div>
          )}

          {karute.next_suggestion && (
            <div>
              <Label className="text-muted-foreground text-xs">次回提案</Label>
              <p className="mt-1 whitespace-pre-wrap">{karute.next_suggestion}</p>
            </div>
          )}

          {karute.internal_memo && (
            <div className="bg-yellow-50 dark:bg-yellow-950 p-3 rounded-lg">
              <Label className="text-muted-foreground text-xs">内部メモ（非公開）</Label>
              <p className="mt-1 whitespace-pre-wrap">{karute.internal_memo}</p>
            </div>
          )}

          {!karute.menu_content &&
            !karute.hair_condition &&
            !karute.color_formula &&
            !karute.perm_info &&
            !karute.styling_notes &&
            !karute.customer_feedback &&
            !karute.next_suggestion &&
            !karute.internal_memo && (
              <div className="text-center py-4 text-muted-foreground">
                施術内容が記録されていません
              </div>
            )}
        </CardContent>
      </Card>

      {/* Face Drawing */}
      {karute.face_drawing && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Pencil className="h-4 w-4" />
              フェイス描画
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex justify-center">
              <div className="border rounded-lg overflow-hidden bg-white max-w-[280px]">
                <img
                  src={karute.face_drawing}
                  alt="フェイス描画"
                  className="w-full h-auto"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Images */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Camera className="h-4 w-4" />
              施術写真
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsImageDialogOpen(true)}
            >
              <ImagePlus className="mr-1 h-4 w-4" />
              追加
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {images.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              写真がありません
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {images.map((image) => (
                <div key={image.id} className="relative group">
                  <div className="aspect-square rounded-lg overflow-hidden bg-muted">
                    <img
                      src={`${API_URL}${image.image_url}`}
                      alt={image.caption || "施術写真"}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <Badge
                    variant="secondary"
                    className="absolute top-2 left-2 text-xs"
                  >
                    {getImageTypeLabel(image.image_type)}
                  </Badge>
                  <Button
                    variant="destructive"
                    size="icon"
                    className="absolute top-2 right-2 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => setDeleteImageId(image.id)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                  {image.caption && (
                    <p className="text-xs text-muted-foreground mt-1 truncate">
                      {image.caption}
                    </p>
                  )}
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
              <CardTitle className="text-base flex items-center gap-2">
                <ClipboardList className="h-4 w-4" />
                カウンセリングシート
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CounselingSheetForm customerId={karute.customer_id} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>カルテ編集</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>来店日</Label>
              <Input
                type="date"
                value={editForm.visit_date}
                onChange={(e) =>
                  setEditForm({ ...editForm, visit_date: e.target.value })
                }
              />
            </div>

            <div className="space-y-2">
              <Label>施術内容</Label>
              <Input
                value={editForm.menu_content}
                onChange={(e) =>
                  setEditForm({ ...editForm, menu_content: e.target.value })
                }
                placeholder="カット、カラー..."
              />
            </div>

            <div className="space-y-2">
              <Label>髪の状態</Label>
              <Textarea
                value={editForm.hair_condition}
                onChange={(e) =>
                  setEditForm({ ...editForm, hair_condition: e.target.value })
                }
                placeholder="髪質、ダメージ状態..."
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <Label>カラー配合</Label>
              <Input
                value={editForm.color_formula}
                onChange={(e) =>
                  setEditForm({ ...editForm, color_formula: e.target.value })
                }
                placeholder="8AB:6N = 1:1 + 6%OX"
              />
            </div>

            <div className="space-y-2">
              <Label>パーマ情報</Label>
              <Textarea
                value={editForm.perm_info}
                onChange={(e) =>
                  setEditForm({ ...editForm, perm_info: e.target.value })
                }
                placeholder="ロッド、放置時間..."
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <Label>スタイリングメモ</Label>
              <Textarea
                value={editForm.styling_notes}
                onChange={(e) =>
                  setEditForm({ ...editForm, styling_notes: e.target.value })
                }
                placeholder="スタイリングのポイント..."
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <Label>お客様フィードバック</Label>
              <Textarea
                value={editForm.customer_feedback}
                onChange={(e) =>
                  setEditForm({ ...editForm, customer_feedback: e.target.value })
                }
                placeholder="お客様からの感想..."
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <Label>次回提案</Label>
              <Textarea
                value={editForm.next_suggestion}
                onChange={(e) =>
                  setEditForm({ ...editForm, next_suggestion: e.target.value })
                }
                placeholder="次回の施術提案..."
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <Label>内部メモ（非公開）</Label>
              <Textarea
                value={editForm.internal_memo}
                onChange={(e) =>
                  setEditForm({ ...editForm, internal_memo: e.target.value })
                }
                placeholder="スタッフ間共有メモ..."
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Pencil className="h-4 w-4" />
                フェイス描画
              </Label>
              <FaceCanvas
                onSave={(dataUrl) =>
                  setEditForm({ ...editForm, face_drawing: dataUrl })
                }
                initialImage={editForm.face_drawing || undefined}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              キャンセル
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Image Upload Dialog */}
      <Dialog open={isImageDialogOpen} onOpenChange={setIsImageDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>写真を追加</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>写真の種類</Label>
              <Select
                value={imageType}
                onValueChange={(v) => setImageType(v as "before" | "after" | "other")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="before">施術前</SelectItem>
                  <SelectItem value="after">施術後</SelectItem>
                  <SelectItem value="other">その他</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>キャプション（任意）</Label>
              <Input
                value={imageCaption}
                onChange={(e) => setImageCaption(e.target.value)}
                placeholder="写真の説明..."
              />
            </div>

            <input
              type="file"
              ref={fileInputRef}
              accept="image/*"
              onChange={handleImageUpload}
              className="hidden"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsImageDialogOpen(false)}>
              キャンセル
            </Button>
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingImage}
            >
              {uploadingImage ? "アップロード中..." : "写真を選択"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Image Confirmation */}
      <AlertDialog open={!!deleteImageId} onOpenChange={() => setDeleteImageId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>写真を削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteImage}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Karute Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>カルテを削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              このカルテと関連する写真がすべて削除されます。この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteKarute}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
