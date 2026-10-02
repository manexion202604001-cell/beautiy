"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronDown, ImagePlus, X, Upload, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { menus, menuCategories, type Menu, type MenuCategory } from "@/lib/api";
import { useStore } from "@/contexts/store-context";
import { getImageUrl } from "@/lib/utils";

function getMenuIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const idx = pathParts.indexOf("menus");
  if (idx !== -1 && pathParts[idx + 1] && pathParts[idx + 1] !== "placeholder") {
    return pathParts[idx + 1];
  }
  return null;
}

function getQueryParam(key: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}

type MenuType = "regular" | "coupon";

export default function MenuEdit({ id: propsId }: { id: string }) {
  const router = useRouter();
  const { currentStore } = useStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [resolvedId] = useState<string>(() => getMenuIdFromUrl() || propsId);
  const isNew = resolvedId === "new";

  const [menuType, setMenuType] = useState<MenuType>(() => {
    const typeParam = getQueryParam("type");
    return typeParam === "coupon" ? "coupon" : "regular";
  });

  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [categories, setCategories] = useState<MenuCategory[]>([]);

  // Form state
  const [formData, setFormData] = useState({
    category: "",
    name: "",
    description: "",
    duration: 60,
    price: 0,
    coupon_type: null as "new" | "repeat" | "all" | null,
    presentation_condition: "",
    usage_condition: "",
    expiry_date: "",
    has_expiry: false,
    is_active: 1,
    price_tilde: 0,
  });

  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importJsonText, setImportJsonText] = useState("");

  useEffect(() => {
    if (!currentStore) return;
    fetchCategories();
    if (!isNew) fetchMenu();
  }, [currentStore?.id]);

  const fetchCategories = async () => {
    try {
      const { categories: data } = await menuCategories.list(currentStore?.id);
      setCategories(data);
    } catch (error) {
      console.error("Failed to fetch categories:", error);
    }
  };


  const fetchMenu = async () => {
    try {
      const { menu } = await menus.get(resolvedId);
      setMenuType(menu.menu_type === "coupon" || menu.coupon_type ? "coupon" : "regular");
      setFormData({
        category: menu.category,
        name: menu.name,
        description: menu.description || "",
        duration: menu.duration,
        price: menu.price,
        coupon_type: menu.coupon_type,
        presentation_condition: menu.presentation_condition || "",
        usage_condition: menu.usage_condition || "",
        expiry_date: menu.expiry_date || "",
        has_expiry: !!menu.expiry_date,
        is_active: menu.is_active,
        price_tilde: menu.price_tilde ?? 0,
      });
      // Load sub_categories or fall back to single category
      if (menu.sub_categories) {
        try {
          const cats = JSON.parse(menu.sub_categories) as string[];
          setSelectedCategories(cats);
        } catch {
          if (menu.category) setSelectedCategories([menu.category]);
        }
      } else if (menu.category) {
        setSelectedCategories([menu.category]);
      }
      setImagePreview(getImageUrl(menu.image_url));

    } catch (error) {
      console.error("Failed to fetch menu:", error, "resolvedId:", resolvedId);
      const status = error && typeof error === "object" && "status" in error ? (error as { status: number }).status : "?";
      const msg = error instanceof Error ? error.message : String(error);
      setLoadError(`読み込み失敗 (ID: ${resolvedId}, ${status}: ${msg})`);
    } finally {
      setLoading(false);
    }
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setImageFile(file);
      const reader = new FileReader();
      reader.onloadend = () => setImagePreview(reader.result as string);
      reader.readAsDataURL(file);
    }
  };

  const handleRemoveImage = () => {
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const SB_CONSOLE_SCRIPT = `(()=>{const d={};const tm={CT01:'all',CT02:'new',CT03:'repeat'};const ts=document.querySelector('#TagSL_NM_COUPON_TYPE_CD_01');d.coupon_type=tm[ts?.value]||null;d.name=document.querySelector('#TagTA_NM_COUPON_NAME_01')?.value||'';d.description=document.querySelector('#TagTA_NM_CONTENT_EXPLANATION_01')?.value||'';const cs=document.querySelector('#TagSL_NM_COUPON_CONDITION_CD_01');d.presentation_condition=cs?.options[cs.selectedIndex]?.text||'';d.usage_condition=document.querySelector('#TagIN_NM_USE_CONDITION_01')?.value||'';if(document.querySelector('#TagIN_NM_AUTO_SET_FLG_01')?.checked){d.expiry_date=null}else{const y=document.querySelector('#TagSL_NM_EXPIRATION_DATE_YYYY_01')?.value;const m=document.querySelector('#TagSL_NM_EXPIRATION_DATE_MM_01')?.value;const dd=document.querySelector('#TagSL_NM_EXPIRATION_DATE_DD_01')?.value;d.expiry_date=(y&&m&&dd)?y+'-'+m+'-'+dd:null}d.price=parseInt(document.querySelector('#TagIN_NM_PRICE_01')?.value||'0',10);const tf=document.querySelector('#TagIN_NM_TILDE_FLG_01');d.price_tilde=tf&&tf.checked?1:0;d.duration=parseInt(document.querySelector('#TagSL_NM_SEJYUTSU_AIM_TIME_01')?.value||'60',10);const cats=[];const tbl=document.querySelector('#TagIN_COUPON_CATEGORY table');if(tbl){tbl.querySelectorAll('tr').forEach(tr=>{const th=tr.querySelector('th');const td=tr.querySelector('td');if(!th||!td)return;const p=th.textContent.trim();td.querySelectorAll('li').forEach(li=>{const cb=li.querySelector('input[type="checkbox"]');if(cb&&cb.checked){const nm=li.textContent.trim();if(nm)cats.push(p+'：'+nm)}})})}d.sb_categories=cats;const img=document.querySelector('#TagImgCouponPoto');if(img&&img.src&&!img.src.includes('noneimage')){d.image_url=img.src}const json=JSON.stringify(d);const ta=document.createElement('textarea');ta.value=json;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);alert('コピーしました')})()`;

  const handleSalonboardImport = () => {
    try {
      const data = JSON.parse(importJsonText);

      // Match sb_categories (array of "parent：child") to existing categories
      const matchedCategories: string[] = [];
      const sbCats = (data.sb_categories || []) as string[];
      if (sbCats.length > 0 && categories.length > 0) {
        for (const sbCat of sbCats) {
          // Exact match
          const exact = categories.find((c) => c.name === sbCat);
          if (exact) {
            matchedCategories.push(exact.name);
          } else {
            // Partial match
            const partial = categories.find(
              (c) => sbCat.includes(c.name) || c.name.includes(sbCat)
            );
            if (partial) matchedCategories.push(partial.name);
          }
        }
      }

      setFormData((prev) => ({
        ...prev,
        coupon_type: data.coupon_type || prev.coupon_type,
        name: data.name || prev.name,
        description: data.description || prev.description,
        presentation_condition: data.presentation_condition || prev.presentation_condition,
        usage_condition: data.usage_condition || prev.usage_condition,
        expiry_date: data.expiry_date || "",
        has_expiry: !!data.expiry_date,
        price: typeof data.price === "number" ? data.price : prev.price,
        price_tilde: typeof data.price_tilde === "number" ? data.price_tilde : prev.price_tilde,
        duration: typeof data.duration === "number" ? data.duration : prev.duration,
        ...(matchedCategories.length > 0 ? { category: matchedCategories[0] } : {}),
      }));
      if (matchedCategories.length > 0) {
        setSelectedCategories(matchedCategories);
      }
      setMenuType("coupon");

      if (data.image_url) {
        setImagePreview(data.image_url);
      }

      setImportDialogOpen(false);
      setImportJsonText("");

      const unmatchedCount = sbCats.length - matchedCategories.length;
      if (sbCats.length > 0 && unmatchedCount > 0) {
        alert(`取り込みました。\n${matchedCategories.length}件のカテゴリをマッチ、${unmatchedCount}件は未マッチです。`);
      }
    } catch {
      alert("JSONの形式が正しくありません");
    }
  };

  const handleSubmit = async () => {
    if (!formData.name) {
      alert("名前は必須です");
      return;
    }

    try {
      setSaving(true);
      const primaryCategory = selectedCategories[0] || formData.category;
      const payload: Partial<Menu> & { store_id?: string } = {
        store_id: currentStore?.id,
        category: primaryCategory,
        name: formData.name,
        description: formData.description || null,
        duration: formData.duration,
        price: formData.price,
        menu_type: menuType,
        is_active: formData.is_active,
        coupon_type: menuType === "coupon" ? formData.coupon_type : null,
        presentation_condition: menuType === "coupon" ? (formData.presentation_condition || null) : null,
        usage_condition: menuType === "coupon" ? (formData.usage_condition || null) : null,
        expiry_date: menuType === "coupon" && formData.has_expiry ? (formData.expiry_date || null) : null,
        sub_categories: selectedCategories.length > 0 ? JSON.stringify(selectedCategories) : null,
        price_tilde: formData.price_tilde,
      };

      let menuId: string;

      if (isNew) {
        const result = await menus.create(payload);
        menuId = result.menu.id;
      } else {
        await menus.update(resolvedId, payload);
        menuId = resolvedId;
      }

      if (imageFile) {
        await menus.uploadImage(menuId, imageFile);
      } else if (imagePreview && imagePreview.startsWith("http")) {
        try {
          await menus.importImageFromUrl(menuId, imagePreview);
        } catch {
          // Image import is best-effort
        }
      }

      router.push(menuType === "coupon" ? "/menus/?tab=coupon" : "/menus/");
    } catch (error) {
      console.error("Failed to save menu:", error);
      alert("保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-muted-foreground">読み込み中...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <Button variant="ghost" size="sm" onClick={() => router.push("/menus/")}>
          <ChevronLeft className="h-4 w-4 mr-1" />
          メニュー一覧に戻る
        </Button>
        <Card>
          <CardContent className="py-8 text-center text-destructive">
            {loadError}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => router.push(menuType === "coupon" ? "/menus/?tab=coupon" : "/menus/")}>
          <ChevronLeft className="h-4 w-4 mr-1" />
          メニュー一覧に戻る
        </Button>
        <Button variant="outline" size="sm" onClick={() => setImportDialogOpen(true)}>
          <Upload className="h-4 w-4 mr-1" />
          SBから取込
        </Button>
      </div>

      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>サロンボードから取り込み</DialogTitle>
            <DialogDescription>
              サロンボードのクーポン編集ページで以下のスクリプトを実行し、コピーされたJSONを貼り付けてください
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground">1. SBのコンソールで実行</Label>
              <pre className="bg-muted rounded-md p-2 mt-1 text-[10px] font-mono max-h-16 overflow-hidden whitespace-pre-wrap break-all text-muted-foreground">{SB_CONSOLE_SCRIPT}</pre>
              <Button
                variant="outline"
                size="sm"
                className="mt-1.5 w-full"
                onClick={() => { navigator.clipboard.writeText(SB_CONSOLE_SCRIPT); }}
              >
                <Copy className="h-3 w-3 mr-1.5" />
                スクリプトをコピー
              </Button>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">2. コピーされたJSONを貼り付け</Label>
              <Textarea
                className="mt-1 font-mono text-xs"
                placeholder='{"coupon_type":"new","name":"...","price":14500,...}'
                value={importJsonText}
                onChange={(e) => setImportJsonText(e.target.value)}
                rows={6}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportDialogOpen(false)}>キャンセル</Button>
            <Button onClick={handleSalonboardImport} disabled={!importJsonText.trim()}>取り込み</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <h1 className="text-xl font-bold">
        {isNew
          ? menuType === "coupon"
            ? "新規クーポン"
            : "新規メニュー"
          : menuType === "coupon"
            ? "クーポン編集"
            : "メニュー編集"}
      </h1>

      {/* Coupon form */}
      {menuType === "coupon" ? (
        <div className="space-y-4">
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">クーポン情報</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>種別 <span className="text-destructive">*</span></Label>
                <Select
                  value={formData.coupon_type || "all"}
                  onValueChange={(v) =>
                    setFormData({ ...formData, coupon_type: v as "new" | "repeat" | "all" })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全員</SelectItem>
                    <SelectItem value="new">新規</SelectItem>
                    <SelectItem value="repeat">再来</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>クーポン名 <span className="text-destructive">*</span></Label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="【ご新規様】カット+カラー"
                />
              </div>

              <div className="space-y-2">
                <Label>クーポン内容</Label>
                <Textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="クーポンの詳細説明"
                  rows={3}
                />
              </div>

              <div className="space-y-2">
                <Label>写真</Label>
                <div className="flex items-start gap-4">
                  {imagePreview ? (
                    <div className="relative">
                      <img
                        src={imagePreview}
                        alt="クーポン画像"
                        className="h-24 w-24 rounded-lg object-cover border"
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="absolute -top-2 -right-2 h-6 w-6 p-0 rounded-full"
                        onClick={handleRemoveImage}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-24 w-24 flex flex-col gap-1"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <ImagePlus className="h-6 w-6" />
                      <span className="text-xs">追加</span>
                    </Button>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleImageChange}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 条件 */}
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">提示・利用条件</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>提示条件</Label>
                <Select
                  value={formData.presentation_condition || "none"}
                  onValueChange={(v) =>
                    setFormData({ ...formData, presentation_condition: v === "none" ? "" : v })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="選択してください" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">指定なし</SelectItem>
                    <SelectItem value="予約時">予約時</SelectItem>
                    <SelectItem value="来店時">来店時</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>利用条件</Label>
                <Input
                  value={formData.usage_condition}
                  onChange={(e) => setFormData({ ...formData, usage_condition: e.target.value })}
                  placeholder="営業時間外＋1100円 LED変更料＋1500円"
                />
              </div>

              <div className="space-y-2">
                <Label>有効期限</Label>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="expiry"
                      checked={!formData.has_expiry}
                      onChange={() => setFormData({ ...formData, has_expiry: false, expiry_date: "" })}
                    />
                    <span className="text-sm">設定しない</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="expiry"
                      checked={formData.has_expiry}
                      onChange={() => setFormData({ ...formData, has_expiry: true })}
                    />
                    <span className="text-sm">設定する</span>
                  </label>
                </div>
                {formData.has_expiry && (
                  <Input
                    type="date"
                    value={formData.expiry_date}
                    onChange={(e) => setFormData({ ...formData, expiry_date: e.target.value })}
                    className="w-48"
                  />
                )}
              </div>
            </CardContent>
          </Card>

          {/* カテゴリ・価格 */}
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">カテゴリ・価格</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>カテゴリ</Label>
                {categories.length > 0 ? (
                  <>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="w-full justify-between font-normal">
                          {selectedCategories.length > 0
                            ? `${selectedCategories.length}件選択中`
                            : "カテゴリを選択"}
                          <ChevronDown className="h-4 w-4 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                        <div className="max-h-64 overflow-y-auto p-2">
                          {(() => {
                            const parentCats = categories.filter(c => !c.parent_id);
                            const childCats = categories.filter(c => c.parent_id);
                            const cByParent = new Map<string, MenuCategory[]>();
                            for (const child of childCats) {
                              const list = cByParent.get(child.parent_id!) || [];
                              list.push(child);
                              cByParent.set(child.parent_id!, list);
                            }
                            return parentCats.map(parent => {
                              const kids = cByParent.get(parent.id) || [];
                              if (kids.length === 0) {
                                return (
                                  <label key={parent.id} className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/50 cursor-pointer">
                                    <Checkbox
                                      checked={selectedCategories.includes(parent.name)}
                                      onCheckedChange={() => {
                                        setSelectedCategories(prev =>
                                          prev.includes(parent.name)
                                            ? prev.filter(c => c !== parent.name)
                                            : [...prev, parent.name]
                                        );
                                      }}
                                    />
                                    <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: parent.color }} />
                                    <span className="text-sm">{parent.name}</span>
                                  </label>
                                );
                              }
                              return (
                                <div key={parent.id}>
                                  <div className="flex items-center gap-2 py-1 px-2 text-xs font-medium text-muted-foreground">
                                    <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: parent.color }} />
                                    {parent.name}
                                  </div>
                                  {kids.map(child => {
                                    const dn = child.name.includes('：') ? child.name.split('：').slice(1).join('：') : child.name;
                                    return (
                                      <label key={child.id} className="flex items-center gap-2 py-1.5 pl-7 pr-2 rounded hover:bg-muted/50 cursor-pointer">
                                        <Checkbox
                                          checked={selectedCategories.includes(child.name)}
                                          onCheckedChange={() => {
                                            setSelectedCategories(prev =>
                                              prev.includes(child.name)
                                                ? prev.filter(c => c !== child.name)
                                                : [...prev, child.name]
                                            );
                                          }}
                                        />
                                        <span className="text-sm">{dn}</span>
                                      </label>
                                    );
                                  })}
                                </div>
                              );
                            });
                          })()}
                        </div>
                      </PopoverContent>
                    </Popover>
                    {selectedCategories.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {selectedCategories.map(cat => (
                          <Badge key={cat} variant="secondary" className="text-xs">
                            {cat.includes('：') ? cat.split('：').slice(1).join('：') : cat}
                            <X className="h-3 w-3 ml-1 cursor-pointer" onClick={() =>
                              setSelectedCategories(prev => prev.filter(c => c !== cat))
                            } />
                          </Badge>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <Input
                    value={formData.category}
                    onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                    placeholder="カテゴリ名"
                  />
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>価格（税込） <span className="text-destructive">*</span></Label>
                  <div className="flex items-center gap-1">
                    <span className="text-sm text-muted-foreground">¥</span>
                    <Input
                      type="number"
                      value={formData.price}
                      onChange={(e) => setFormData({ ...formData, price: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={formData.price_tilde === 1}
                      onCheckedChange={(checked) => setFormData({ ...formData, price_tilde: checked ? 1 : 0 })}
                    />
                    <span className="text-sm">「～」を表示</span>
                  </label>
                </div>
                <div className="space-y-2">
                  <Label>所要目安時間 <span className="text-destructive">*</span></Label>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      value={formData.duration}
                      onChange={(e) => setFormData({ ...formData, duration: parseInt(e.target.value) || 0 })}
                    />
                    <span className="text-sm text-muted-foreground shrink-0">分</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        /* Regular menu form */
        <div className="space-y-4">
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">メニュー設定</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>カテゴリ</Label>
                {categories.length > 0 ? (
                  <>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="w-full justify-between font-normal">
                          {selectedCategories.length > 0
                            ? `${selectedCategories.length}件選択中`
                            : "カテゴリを選択"}
                          <ChevronDown className="h-4 w-4 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                        <div className="max-h-64 overflow-y-auto p-2">
                          {(() => {
                            const parentCats = categories.filter(c => !c.parent_id);
                            const childCats = categories.filter(c => c.parent_id);
                            const cByParent = new Map<string, MenuCategory[]>();
                            for (const child of childCats) {
                              const list = cByParent.get(child.parent_id!) || [];
                              list.push(child);
                              cByParent.set(child.parent_id!, list);
                            }
                            return parentCats.map(parent => {
                              const kids = cByParent.get(parent.id) || [];
                              if (kids.length === 0) {
                                return (
                                  <label key={parent.id} className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/50 cursor-pointer">
                                    <Checkbox
                                      checked={selectedCategories.includes(parent.name)}
                                      onCheckedChange={() => {
                                        setSelectedCategories(prev =>
                                          prev.includes(parent.name)
                                            ? prev.filter(c => c !== parent.name)
                                            : [...prev, parent.name]
                                        );
                                      }}
                                    />
                                    <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: parent.color }} />
                                    <span className="text-sm">{parent.name}</span>
                                  </label>
                                );
                              }
                              return (
                                <div key={parent.id}>
                                  <div className="flex items-center gap-2 py-1 px-2 text-xs font-medium text-muted-foreground">
                                    <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: parent.color }} />
                                    {parent.name}
                                  </div>
                                  {kids.map(child => {
                                    const dn = child.name.includes('：') ? child.name.split('：').slice(1).join('：') : child.name;
                                    return (
                                      <label key={child.id} className="flex items-center gap-2 py-1.5 pl-7 pr-2 rounded hover:bg-muted/50 cursor-pointer">
                                        <Checkbox
                                          checked={selectedCategories.includes(child.name)}
                                          onCheckedChange={() => {
                                            setSelectedCategories(prev =>
                                              prev.includes(child.name)
                                                ? prev.filter(c => c !== child.name)
                                                : [...prev, child.name]
                                            );
                                          }}
                                        />
                                        <span className="text-sm">{dn}</span>
                                      </label>
                                    );
                                  })}
                                </div>
                              );
                            });
                          })()}
                        </div>
                      </PopoverContent>
                    </Popover>
                    {selectedCategories.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {selectedCategories.map(cat => (
                          <Badge key={cat} variant="secondary" className="text-xs">
                            {cat.includes('：') ? cat.split('：').slice(1).join('：') : cat}
                            <X className="h-3 w-3 ml-1 cursor-pointer" onClick={() =>
                              setSelectedCategories(prev => prev.filter(c => c !== cat))
                            } />
                          </Badge>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <Input
                    value={formData.category}
                    onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                    placeholder="カテゴリ名"
                  />
                )}
              </div>

              <div className="space-y-2">
                <Label>メニュー名 <span className="text-destructive">*</span></Label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="パリジェンヌラッシュリフト"
                />
              </div>

              <div className="space-y-2">
                <Label>メニュー説明</Label>
                <Textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="メニューの詳細説明"
                  rows={3}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>価格（税込） <span className="text-destructive">*</span></Label>
                  <div className="flex items-center gap-1">
                    <span className="text-sm text-muted-foreground">¥</span>
                    <Input
                      type="number"
                      value={formData.price}
                      onChange={(e) => setFormData({ ...formData, price: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={formData.price_tilde === 1}
                      onCheckedChange={(checked) => setFormData({ ...formData, price_tilde: checked ? 1 : 0 })}
                    />
                    <span className="text-sm">「～」を表示</span>
                  </label>
                </div>
                <div className="space-y-2">
                  <Label>所要目安時間 <span className="text-destructive">*</span></Label>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      value={formData.duration}
                      onChange={(e) => setFormData({ ...formData, duration: parseInt(e.target.value) || 0 })}
                    />
                    <span className="text-sm text-muted-foreground shrink-0">分</span>
                  </div>
                </div>
              </div>

              <div>
                <div className="space-y-2">
                  <Label>掲載</Label>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="active"
                        checked={formData.is_active === 1}
                        onChange={() => setFormData({ ...formData, is_active: 1 })}
                      />
                      <span className="text-sm">掲載</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="active"
                        checked={formData.is_active === 0}
                        onChange={() => setFormData({ ...formData, is_active: 0 })}
                      />
                      <span className="text-sm">非掲載</span>
                    </label>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Save buttons */}
      <div className="flex gap-2 pb-8">
        <Button variant="outline" onClick={() => router.push(menuType === "coupon" ? "/menus/?tab=coupon" : "/menus/")} className="flex-1">
          キャンセル
        </Button>
        <Button onClick={handleSubmit} disabled={saving} className="flex-1">
          {saving ? "保存中..." : isNew ? "登録" : "更新"}
        </Button>
      </div>
    </div>
  );
}
