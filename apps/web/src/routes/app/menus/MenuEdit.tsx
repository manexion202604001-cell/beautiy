import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ImagePlus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { catalogApi, catalogKeys, useCategories } from '../../../api/catalog';
import { sameOriginBlobUrl, uploadFile } from '../../../api/files';
import type { MenuCategory, MenuInput } from '../../../api/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Select,
  Textarea,
} from '../../../components/shad';
import { Popover } from '../../../components/shad/popover';
import { useToast } from '../../../components/ui';
import { errorMessage, isApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { DEFAULT_CATEGORY_COLOR, childLabel } from './model';
import {
  SbCouponFormImportDialog,
  SbImportButton,
  matchSbCategories,
  type SbCouponForm,
} from './SbImportDialogs';
import { importSbImages } from '../../../api/menuSbImport';

type MenuType = 'regular' | 'coupon';
type CouponType = 'all' | 'new' | 'repeat';

interface FormState {
  /** free-text category, used only while the shop has no categories yet */
  category: string;
  name: string;
  description: string;
  duration: number;
  price: number;
  couponType: CouponType | null;
  presentationCondition: string;
  usageCondition: string;
  expiryDate: string;
  hasExpiry: boolean;
  isActive: boolean;
  priceTilde: boolean;
}

const EMPTY: FormState = {
  category: '',
  name: '',
  description: '',
  duration: 60,
  price: 0,
  couponType: null,
  presentationCondition: '',
  usageCondition: '',
  expiryDate: '',
  hasExpiry: false,
  isActive: true,
  priceTilde: false,
};

/** Picture formats the menu picture accepts (apps/api files/policy.ts: menu_image) */
const MENU_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';

const Required = () => <span className="text-destructive">*</span>;

/** カテゴリ: tick one or more categories (children are listed under their parent) */
function CategoryPicker({
  categories,
  selected,
  onChange,
}: {
  categories: MenuCategory[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  // a child whose parent is not in this shop's list is offered as a row of its own
  const topIds = new Set(categories.filter((c) => !c.parent_id).map((c) => c.id));
  const parents = categories.filter((c) => !c.parent_id || !topIds.has(c.parent_id));
  const childrenOf = new Map<string, MenuCategory[]>();
  for (const c of categories) {
    if (!c.parent_id || !topIds.has(c.parent_id)) continue;
    childrenOf.set(c.parent_id, [...(childrenOf.get(c.parent_id) ?? []), c]);
  }
  const byId = new Map(categories.map((c) => [c.id, c]));
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  return (
    <>
      <Popover
        align="start"
        label="カテゴリ"
        contentClassName="w-full p-0"
        trigger={(props) => (
          <Button variant="outline" className="w-full justify-between font-normal" {...props}>
            {selected.length > 0 ? `${selected.length}件選択中` : 'カテゴリを選択'}
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        )}
      >
        <div className="max-h-64 overflow-y-auto p-2">
          {parents.map((p) => {
            const children = childrenOf.get(p.id) ?? [];
            const dot = (
              <div
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: p.color ?? DEFAULT_CATEGORY_COLOR }}
              />
            );
            return children.length === 0 ? (
              <label
                key={p.id}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-muted/50"
              >
                <Checkbox checked={selected.includes(p.id)} onCheckedChange={() => toggle(p.id)} />
                {dot}
                <span className="text-sm">{p.name}</span>
              </label>
            ) : (
              <div key={p.id}>
                <div className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-muted-foreground">
                  {dot}
                  {p.name}
                </div>
                {children.map((c) => (
                  <label
                    key={c.id}
                    className="flex cursor-pointer items-center gap-2 rounded-sm py-1.5 pl-7 pr-2 hover:bg-muted/50"
                  >
                    <Checkbox checked={selected.includes(c.id)} onCheckedChange={() => toggle(c.id)} />
                    <span className="text-sm">{childLabel(c.name)}</span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      </Popover>
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {selected.map((id) => {
            const c = byId.get(id);
            if (!c) return null;
            return (
              <Badge key={id} variant="secondary" className="text-xs">
                {childLabel(c.name)}
                <X
                  className="ml-1 h-3 w-3 cursor-pointer"
                  role="button"
                  aria-label={`${childLabel(c.name)} を外す`}
                  onClick={() => onChange(selected.filter((s) => s !== id))}
                />
              </Badge>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

/** 新規メニュー / 新規クーポン / メニュー編集 / クーポン編集 */
export default function MenuEdit() {
  // /app/menus/new has no :id
  const { id } = useParams();
  const isNew = !id;
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { currentShopId: shopId } = useAuth();

  const [menuType, setMenuType] = useState<MenuType>(() =>
    params.get('type') === 'coupon' ? 'coupon' : 'regular',
  );
  const [form, setForm] = useState<FormState>(EMPTY);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  /** file id of the picture the menu had when the form opened */
  const [savedImageId, setSavedImageId] = useState<string | null>(null);
  const [wasListed, setWasListed] = useState(true);
  /** a new menu already created by a save whose picture upload then failed: saving again updates it */
  const [createdId, setCreatedId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** picture URL brought in by 「SBから取込」: the server fetches it when the form is saved */
  const [sbImageUrl, setSbImageUrl] = useState<string | null>(null);
  const [sbOpen, setSbOpen] = useState(false);

  const categoriesQ = useCategories(shopId ?? undefined);
  const categories = useMemo(() => categoriesQ.data ?? [], [categoriesQ.data]);

  // always read the menu afresh: the form must not start from a cached copy
  const menuQ = useQuery({
    queryKey: [...catalogKeys.menu(id ?? ''), 'edit'],
    queryFn: () => catalogApi.menu(id ?? ''),
    enabled: !!id,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
  });

  const loaded = useRef(false);
  useEffect(() => {
    const menu = menuQ.data;
    if (!menu || loaded.current) return;
    loaded.current = true;
    const coupon = menu.menu_type === 'coupon' || !!menu.coupon_type;
    setMenuType(coupon ? 'coupon' : 'regular');
    // 掲載 as this shop sees it: an organization-wide menu can be hidden by the shop's override
    const override = menu.overrides.find((o) => o.shop_id === shopId);
    const listed = menu.status === 'active' && override?.is_available !== false;
    setWasListed(listed);
    setForm({
      category: '',
      name: menu.name,
      description: menu.description ?? '',
      duration: menu.duration_min,
      price: menu.price,
      couponType: menu.coupon_type ?? null,
      presentationCondition: menu.presentation_condition ?? '',
      usageCondition: menu.usage_condition ?? '',
      expiryDate: menu.expiry_date ?? '',
      hasExpiry: !!menu.expiry_date,
      isActive: listed,
      priceTilde: menu.price_tilde ?? false,
    });
    setSelectedCategories(
      menu.sub_category_ids?.length ? menu.sub_category_ids : menu.category_id ? [menu.category_id] : [],
    );
    setSavedImageId(menu.image_file_id ?? null);
    setImagePreview(menu.image_url ? sameOriginBlobUrl(menu.image_url) : null);
  }, [menuQ.data, shopId]);

  const listPath = menuType === 'coupon' ? '/app/menus?tab=coupon' : '/app/menus';

  /** 「SBから取込」: fills the form with a SALON BOARD coupon (saved only by 登録 / 更新) */
  const applySb = (data: SbCouponForm) => {
    const matched = matchSbCategories(data.categories, categories);
    setForm((f) => ({
      ...f,
      couponType: data.couponType ?? f.couponType,
      name: data.name || f.name,
      description: data.description || f.description,
      presentationCondition: data.presentationCondition || f.presentationCondition,
      usageCondition: data.usageCondition || f.usageCondition,
      expiryDate: data.expiryDate ?? '',
      hasExpiry: !!data.expiryDate,
      price: data.price ?? f.price,
      priceTilde: data.priceTilde ?? f.priceTilde,
      duration: data.durationMin ?? f.duration,
    }));
    if (matched.length > 0) setSelectedCategories(matched);
    setMenuType('coupon');
    if (data.imageUrl) {
      setImageFile(null);
      setImagePreview(data.imageUrl);
      setSbImageUrl(data.imageUrl);
    }
    const unmatched = data.categories.length - matched.length;
    if (data.categories.length > 0 && unmatched > 0) {
      toast.info(
        '取り込みました。',
        `${matched.length}件のカテゴリをマッチ、${unmatched}件は未マッチです。`,
      );
    }
  };
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const handleSave = async () => {
    if (!form.name) {
      toast.error('名前は必須です');
      return;
    }
    if (!shopId) return;
    if (form.duration < 5 || form.duration > 720) {
      toast.error('所要目安時間は5〜720分で入力してください');
      return;
    }
    if (form.price < 0) {
      toast.error('価格は0円以上で入力してください');
      return;
    }
    try {
      setSaving(true);
      const coupon = menuType === 'coupon';
      // without categories the form takes a category name: it becomes this shop's first category
      let categoryIds = selectedCategories.filter((c) => categories.some((x) => x.id === c));
      if (categories.length === 0 && form.category.trim()) {
        const created = await catalogApi.createCategory({ shopId, name: form.category.trim() });
        categoryIds = [created.id];
      }
      const input: MenuInput = {
        subCategoryIds: categoryIds,
        name: form.name,
        description: form.description || null,
        durationMin: form.duration,
        price: form.price,
        menuType,
        couponType: coupon ? (form.couponType ?? 'all') : null,
        presentationCondition: coupon ? form.presentationCondition || null : null,
        usageCondition: coupon ? form.usageCondition || null : null,
        expiryDate: coupon && form.hasExpiry ? form.expiryDate || null : null,
        priceTilde: form.priceTilde,
      };
      let menuId = id ?? createdId;
      if (menuId) {
        await catalogApi.updateMenu(menuId, input);
        if (form.isActive !== wasListed) {
          await catalogApi.setListing(menuId, shopId, form.isActive);
          setWasListed(form.isActive);
        }
      } else {
        const created = await catalogApi.createMenu({
          ...input,
          shopId,
          status: form.isActive ? 'active' : 'inactive',
        });
        menuId = created.id;
        setCreatedId(created.id);
        setWasListed(form.isActive);
      }
      if (imageFile) {
        const file = await uploadFile(imageFile, 'menu_image');
        await catalogApi.updateMenu(menuId, { imageFileId: file.id });
      } else if (sbImageUrl && imagePreview === sbImageUrl) {
        // a picture that cannot be fetched leaves the menu as it is (as in SALOGIC)
        await importSbImages([{ menuId, url: sbImageUrl }]);
      } else if (!imagePreview && savedImageId) {
        await catalogApi.updateMenu(menuId, { imageFileId: null });
      }
      await qc.invalidateQueries({ queryKey: catalogKeys.all });
      navigate(listPath);
    } catch (e) {
      toast.error('保存に失敗しました', errorMessage(e));
      await qc.invalidateQueries({ queryKey: catalogKeys.all });
    } finally {
      setSaving(false);
    }
  };

  if (id && menuQ.isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <p className="text-muted-foreground">読み込み中...</p>
      </div>
    );
  }

  if (id && menuQ.isError) {
    const status = isApiError(menuQ.error) ? menuQ.error.status : '?';
    return (
      <div className="mx-auto max-w-2xl sy-4">
        <Button variant="ghost" size="sm" onClick={() => navigate('/app/menus')}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          メニュー一覧に戻る
        </Button>
        <Card>
          <CardContent className="py-8 text-center text-destructive">
            読み込み失敗 (ID: {id}, {status}: {errorMessage(menuQ.error)})
          </CardContent>
        </Card>
      </div>
    );
  }

  const categoryField = (
    <div className="sy-2">
      <Label>カテゴリ</Label>
      {categories.length > 0 ? (
        <CategoryPicker categories={categories} selected={selectedCategories} onChange={setSelectedCategories} />
      ) : (
        <Input
          aria-label="カテゴリ"
          value={form.category}
          onChange={(e) => set({ category: e.target.value })}
          placeholder="カテゴリ名"
        />
      )}
    </div>
  );

  const priceAndDuration = (
    <div className="grid grid-cols-2 gap-4">
      <div className="sy-2">
        <Label htmlFor="menu-price">
          価格（税込） <Required />
        </Label>
        <div className="flex items-center gap-1">
          <span className="text-sm text-muted-foreground">¥</span>
          <Input
            id="menu-price"
            type="number"
            value={form.price}
            onChange={(e) => set({ price: parseInt(e.target.value) || 0 })}
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox checked={form.priceTilde} onCheckedChange={(v) => set({ priceTilde: v })} />
          <span className="text-sm">「～」を表示</span>
        </label>
      </div>
      <div className="sy-2">
        <Label htmlFor="menu-duration">
          所要目安時間 <Required />
        </Label>
        <div className="flex items-center gap-1">
          <Input
            id="menu-duration"
            type="number"
            value={form.duration}
            onChange={(e) => set({ duration: parseInt(e.target.value) || 0 })}
          />
          <span className="shrink-0 text-sm text-muted-foreground">分</span>
        </div>
      </div>
    </div>
  );

  const photoField = (alt: string) => (
    <div className="sy-2">
      <Label>写真</Label>
      <div className="flex items-start gap-4">
        {imagePreview ? (
          <div className="relative">
            <img src={imagePreview} alt={alt} className="h-24 w-24 rounded-lg border object-cover" />
            <Button
              type="button"
              variant="destructive"
              size="sm"
              aria-label="写真を削除"
              className="absolute -right-2 -top-2 h-6 w-6 rounded-full p-0"
              onClick={() => {
                setImageFile(null);
                setImagePreview(null);
                if (fileInput.current) fileInput.current.value = '';
              }}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="flex h-24 w-24 flex-col gap-1"
            onClick={() => fileInput.current?.click()}
          >
            <ImagePlus className="h-6 w-6" />
            <span className="text-xs">追加</span>
          </Button>
        )}
        <input
          ref={fileInput}
          type="file"
          accept={MENU_IMAGE_ACCEPT}
          aria-label="写真を選択"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setImageFile(file);
            const reader = new FileReader();
            reader.onloadend = () => setImagePreview(reader.result as string);
            reader.readAsDataURL(file);
          }}
        />
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-2xl sy-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => navigate(listPath)}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          メニュー一覧に戻る
        </Button>
        <SbImportButton label="SBから取込" onClick={() => setSbOpen(true)} />
      </div>
      <SbCouponFormImportDialog open={sbOpen} onOpenChange={setSbOpen} onApply={applySb} />

      <h1 className="text-xl font-bold">
        {isNew
          ? menuType === 'coupon'
            ? '新規クーポン'
            : '新規メニュー'
          : menuType === 'coupon'
            ? 'クーポン編集'
            : 'メニュー編集'}
      </h1>

      {menuType === 'coupon' ? (
        <div className="sy-4">
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">クーポン情報</CardTitle>
            </CardHeader>
            <CardContent className="sy-4">
              <div className="sy-2">
                <Label>
                  種別 <Required />
                </Label>
                <Select
                  label="種別"
                  value={form.couponType ?? 'all'}
                  onValueChange={(v) => set({ couponType: v as CouponType })}
                  options={[
                    { value: 'all', label: '全員' },
                    { value: 'new', label: '新規' },
                    { value: 'repeat', label: '再来' },
                  ]}
                />
              </div>
              <div className="sy-2">
                <Label htmlFor="menu-name">
                  クーポン名 <Required />
                </Label>
                <Input
                  id="menu-name"
                  value={form.name}
                  onChange={(e) => set({ name: e.target.value })}
                  placeholder="【ご新規様】カット+カラー"
                />
              </div>
              <div className="sy-2">
                <Label htmlFor="menu-description">クーポン内容</Label>
                <Textarea
                  id="menu-description"
                  value={form.description}
                  onChange={(e) => set({ description: e.target.value })}
                  placeholder="クーポンの詳細説明"
                  rows={3}
                />
              </div>
              {photoField('クーポン画像')}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">提示・利用条件</CardTitle>
            </CardHeader>
            <CardContent className="sy-4">
              <div className="sy-2">
                <Label>提示条件</Label>
                <Select
                  label="提示条件"
                  value={form.presentationCondition || 'none'}
                  onValueChange={(v) => set({ presentationCondition: v === 'none' ? '' : v })}
                  placeholder="選択してください"
                  options={[
                    { value: 'none', label: '指定なし' },
                    { value: '予約時', label: '予約時' },
                    { value: '来店時', label: '来店時' },
                    // a condition brought over from the previous system stays selectable
                    ...(form.presentationCondition && !['予約時', '来店時'].includes(form.presentationCondition)
                      ? [{ value: form.presentationCondition, label: form.presentationCondition }]
                      : []),
                  ]}
                />
              </div>
              <div className="sy-2">
                <Label htmlFor="menu-usage">利用条件</Label>
                <Input
                  id="menu-usage"
                  value={form.usageCondition}
                  onChange={(e) => set({ usageCondition: e.target.value })}
                  placeholder="営業時間外＋1100円 LED変更料＋1500円"
                />
              </div>
              <div className="sy-2">
                <Label>有効期限</Label>
                <div className="flex items-center gap-4">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name="expiry"
                      checked={!form.hasExpiry}
                      onChange={() => set({ hasExpiry: false, expiryDate: '' })}
                    />
                    <span className="text-sm">設定しない</span>
                  </label>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name="expiry"
                      checked={form.hasExpiry}
                      onChange={() => set({ hasExpiry: true })}
                    />
                    <span className="text-sm">設定する</span>
                  </label>
                </div>
                {form.hasExpiry ? (
                  <Input
                    type="date"
                    aria-label="有効期限"
                    value={form.expiryDate}
                    onChange={(e) => set({ expiryDate: e.target.value })}
                    className="w-48"
                  />
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">カテゴリ・価格</CardTitle>
            </CardHeader>
            <CardContent className="sy-4">
              {categoryField}
              {priceAndDuration}
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="sy-4">
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">メニュー設定</CardTitle>
            </CardHeader>
            <CardContent className="sy-4">
              {categoryField}
              <div className="sy-2">
                <Label htmlFor="menu-name">
                  メニュー名 <Required />
                </Label>
                <Input
                  id="menu-name"
                  value={form.name}
                  onChange={(e) => set({ name: e.target.value })}
                  placeholder="パリジェンヌラッシュリフト"
                />
              </div>
              <div className="sy-2">
                <Label htmlFor="menu-description">メニュー説明</Label>
                <Textarea
                  id="menu-description"
                  value={form.description}
                  onChange={(e) => set({ description: e.target.value })}
                  placeholder="メニューの詳細説明"
                  rows={3}
                />
              </div>
              {photoField('メニュー画像')}
              {priceAndDuration}
              <div>
                <div className="sy-2">
                  <Label>掲載</Label>
                  <div className="flex items-center gap-4">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="radio"
                        name="active"
                        checked={form.isActive}
                        onChange={() => set({ isActive: true })}
                      />
                      <span className="text-sm">掲載</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="radio"
                        name="active"
                        checked={!form.isActive}
                        onChange={() => set({ isActive: false })}
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

      <div className="flex gap-2 pb-8">
        <Button variant="outline" onClick={() => navigate(listPath)} className="flex-1">
          キャンセル
        </Button>
        <Button onClick={() => void handleSave()} disabled={saving} className="flex-1">
          {saving ? '保存中...' : isNew ? '登録' : '更新'}
        </Button>
      </div>
    </div>
  );
}
