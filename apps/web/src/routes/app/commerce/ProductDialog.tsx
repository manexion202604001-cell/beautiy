import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  commerceApi,
  commerceKeys,
  useProduct,
  type Product,
  type ProductInput,
} from '../../../api/commerce';
import { IMAGE_ACCEPT, sameOriginBlobUrl, uploadFile } from '../../../api/files';
import {
  Alert,
  Button,
  Dialog,
  Field,
  IconButton,
  InlineLoading,
  Input,
  Select,
  Switch,
  Textarea,
  useToast,
} from '../../../components/ui';
import { errorMessage, isApiError, newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatYen } from '../../../lib/format';
import { useStableKey } from '../../../lib/hooks';
import { inclusivePrice, parseYen } from '../../../lib/money';

interface ImageItem {
  fileId: string;
  url: string;
}

/** Create / edit a product (images via files presign → PUT → complete) */
export function ProductDialog({
  product,
  onClose,
}: {
  product: Product | null;
  onClose: () => void;
}) {
  const detail = useProduct(product?.id);
  if (product && detail.isLoading) {
    return (
      <Dialog open onClose={onClose} title="商品を編集" size="lg">
        <InlineLoading />
      </Dialog>
    );
  }
  return <ProductForm product={detail.data ?? product} onClose={onClose} />;
}

function ProductForm({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const { currentShopId, me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [key, regenerate] = useStableKey(newIdempotencyKey);
  const [f, setF] = useState({
    name: product?.name ?? '',
    brand: product?.brand ?? '',
    category: product?.category ?? '',
    description: product?.description ?? '',
    price: product ? String(product.price) : '',
    priceTaxIncluded: product?.price_tax_included ?? true,
    taxRateBp: String(product?.tax_rate_bp ?? 1000),
    cost: product?.cost !== null && product?.cost !== undefined ? String(product.cost) : '',
    sku: product?.sku ?? '',
    barcode: product?.barcode ?? '',
    scope: product ? (product.shop_id ? 'shop' : 'common') : me?.allShops ? 'common' : 'shop',
    isOnline: product?.is_online ?? false,
    stockManaged: product?.stock_managed ?? true,
    status: product?.status ?? 'active',
  });
  const [images, setImages] = useState<ImageItem[]>(() => product?.images ?? []);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const price = parseYen(f.price);

  useEffect(() => {
    if (product?.images) setImages(product.images);
  }, [product?.images]);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of [...files].slice(0, 10 - images.length)) {
        const up = await uploadFile(file, 'product_image');
        setImages((xs) => [...xs, { fileId: up.id, url: URL.createObjectURL(file) }]);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const save = async () => {
    const errs: Record<string, string> = {};
    if (!f.name.trim()) errs.name = '商品名を入力してください';
    if (price === null || price < 0) errs.price = '0以上の金額で入力してください';
    const cost = f.cost ? parseYen(f.cost) : null;
    if (f.cost && (cost === null || cost < 0)) errs.cost = '0以上の金額で入力してください';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const input: ProductInput = {
      name: f.name.trim(),
      brand: f.brand.trim() || null,
      category: f.category.trim() || null,
      description: f.description.trim() || null,
      price: price!,
      priceTaxIncluded: f.priceTaxIncluded,
      taxRateBp: Number(f.taxRateBp),
      cost,
      sku: f.sku.trim() || null,
      barcode: f.barcode.trim() || null,
      imageFileIds: images.map((i) => i.fileId),
      isOnline: f.isOnline,
      stockManaged: f.stockManaged,
      status: f.status as 'active' | 'inactive',
    };
    setSaving(true);
    setError(null);
    try {
      if (product) await commerceApi.updateProduct(product.id, input);
      else
        await commerceApi.createProduct(
          { ...input, shopId: f.scope === 'shop' ? currentShopId : null },
          key,
        );
      void qc.invalidateQueries({ queryKey: commerceKeys.all });
      toast.success(product ? '商品を更新しました' : '商品を登録しました');
      onClose();
    } catch (e) {
      if (isApiError(e)) {
        if (e.code === 'SKU_DUPLICATE') setErrors({ sku: e.message });
        else if (e.code === 'BARCODE_DUPLICATE') setErrors({ barcode: e.message });
        else setError(e.message);
        if (!product && e.status > 0) regenerate();
      } else setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={product ? '商品を編集' : '商品を登録'}
      dismissable={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={uploading}
            onClick={() => void save()}
            data-testid="save-product"
          >
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="商品名" required error={errors.name} className="sm:col-span-2">
            <Input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={200} />
          </Field>
          <Field label="ブランド" optional>
            <Input value={f.brand} onChange={(e) => set('brand', e.target.value)} maxLength={100} />
          </Field>
          <Field label="カテゴリ" optional>
            <Input
              value={f.category}
              onChange={(e) => set('category', e.target.value)}
              maxLength={100}
              placeholder="シャンプー / トリートメント …"
            />
          </Field>
          <Field label="販売価格" required error={errors.price}>
            <Input
              value={f.price}
              onChange={(e) => set('price', e.target.value)}
              inputMode="numeric"
              leading="¥"
            />
          </Field>
          <Field label="税率">
            <Select value={f.taxRateBp} onChange={(e) => set('taxRateBp', e.target.value)}>
              <option value="1000">10%（標準）</option>
              <option value="800">8%（軽減）</option>
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Switch
              checked={f.priceTaxIncluded}
              onChange={(v) => set('priceTaxIncluded', v)}
              label="税込価格で入力"
              description={
                price !== null
                  ? `税込 ${formatYen(inclusivePrice(price, f.priceTaxIncluded, Number(f.taxRateBp)))}`
                  : undefined
              }
            />
          </div>
          <Field label="原価" optional error={errors.cost}>
            <Input
              value={f.cost}
              onChange={(e) => set('cost', e.target.value)}
              inputMode="numeric"
              leading="¥"
            />
          </Field>
          <Field label="対象">
            <Select
              value={f.scope}
              onChange={(e) => set('scope', e.target.value)}
              disabled={!!product}
            >
              <option value="common">法人共通</option>
              <option value="shop">この店舗のみ</option>
            </Select>
          </Field>
          <Field label="SKU" optional error={errors.sku}>
            <Input
              value={f.sku}
              onChange={(e) => set('sku', e.target.value)}
              maxLength={64}
              className="font-mono"
            />
          </Field>
          <Field label="バーコード（JAN）" optional error={errors.barcode}>
            <Input
              value={f.barcode}
              onChange={(e) => set('barcode', e.target.value)}
              maxLength={64}
              inputMode="numeric"
              className="font-mono"
            />
          </Field>
          <Field label="説明" optional className="sm:col-span-2">
            <Textarea
              value={f.description}
              onChange={(e) => set('description', e.target.value)}
              rows={3}
              maxLength={5000}
            />
          </Field>
        </div>
        <div className="space-y-3 rounded-xl bg-surface-2 p-3">
          <Switch
            checked={f.isOnline}
            onChange={(v) => set('isOnline', v)}
            label="ECで販売する"
            description="オンラインストアに掲載します（在庫はEC倉庫を使用）"
          />
          <Switch
            checked={f.stockManaged}
            onChange={(v) => set('stockManaged', v)}
            label="在庫を管理する"
          />
          <Switch
            checked={f.status === 'active'}
            onChange={(v) => set('status', v ? 'active' : 'inactive')}
            label="販売中"
          />
        </div>
        <div>
          <p className="mb-1.5 text-[13px] font-medium">商品画像（最大10枚）</p>
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div
                key={img.fileId}
                className="relative h-20 w-20 overflow-hidden rounded-xl border border-border"
              >
                <img
                  src={sameOriginBlobUrl(img.url)}
                  alt={`商品画像${i + 1}`}
                  className="h-full w-full object-cover"
                />
                <IconButton
                  icon="x"
                  size="xs"
                  label={`商品画像${i + 1}を外す`}
                  className="absolute right-0.5 top-0.5 bg-surface/90"
                  onClick={() => setImages((xs) => xs.filter((x) => x.fileId !== img.fileId))}
                />
              </div>
            ))}
            {images.length < 10 ? (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="flex h-20 w-20 flex-col items-center justify-center rounded-xl border border-dashed border-border-strong text-xs text-muted hover:bg-surface-2"
              >
                {uploading ? 'アップロード中…' : '＋ 追加'}
              </button>
            ) : null}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            className="sr-only"
            data-testid="product-image-input"
            onChange={(e) => void onFiles(e.target.files)}
          />
        </div>
      </div>
    </Dialog>
  );
}
