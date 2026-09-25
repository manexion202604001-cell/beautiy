'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ImageOff } from 'lucide-react';
import { ActionForm, SubmitButton } from '@/components/client';
import { adjustStockAction, saveProductAction } from '../actions';

export interface ProductValues {
  id?: string; name: string; sku: string | null; brand: string | null; description: string | null; price: number; stock: number;
  subscriptionIntervalDays: number | null; active: boolean; onlineSale: boolean; imageUrl: string | null;
}

export function ProductForm({ product }: { product?: ProductValues }) {
  const router = useRouter();
  const [preview, setPreview] = useState<string | null>(product?.imageUrl ?? null);
  const [removeImage, setRemoveImage] = useState(false);
  const isNew = !product?.id;
  return (
    <ActionForm action={saveProductAction} refresh={!isNew} onSuccess={(r) => { if (isNew && r.ok && r.data?.id) router.push(`/commerce/products/${r.data.id}?created=1`); }}>
      {product?.id && <input type="hidden" name="id" value={product.id} />}
      <div className="form-grid">
        <div className="field full">
          <label htmlFor="name" className="req">商品名</label>
          <input id="name" name="name" className="input" required maxLength={120} defaultValue={product?.name} />
        </div>
        <div className="field">
          <label htmlFor="brand">ブランド</label>
          <input id="brand" name="brand" className="input" maxLength={60} defaultValue={product?.brand ?? ''} />
        </div>
        <div className="field">
          <label htmlFor="sku">SKU / 品番</label>
          <input id="sku" name="sku" className="input" maxLength={60} defaultValue={product?.sku ?? ''} />
        </div>
        <div className="field">
          <label htmlFor="price" className="req">販売価格（税込・円）</label>
          <input id="price" name="price" className="input num" inputMode="numeric" required defaultValue={product?.price ?? ''} />
        </div>
        {isNew ? (
          <div className="field">
            <label htmlFor="stock">初期在庫</label>
            <input id="stock" name="stock" className="input num" inputMode="numeric" defaultValue={0} />
          </div>
        ) : (
          <div className="field">
            <label>在庫</label>
            <div className="input" style={{ background: 'var(--panel-2)' }}>{product!.stock}（右の「在庫調整」から変更）</div>
          </div>
        )}
        <div className="field">
          <label htmlFor="subscriptionIntervalDays">定期便の間隔（日）</label>
          <input id="subscriptionIntervalDays" name="subscriptionIntervalDays" className="input num" inputMode="numeric" placeholder="空欄＝定期便なし" defaultValue={product?.subscriptionIntervalDays ?? ''} />
          <div className="hint">設定すると、ストアで定期便として購入できます（例：30）</div>
        </div>
        <div className="field">
          <label>公開設定</label>
          <label className="checkbox"><input type="checkbox" name="active" defaultChecked={product?.active ?? true} />販売中（POSで選択可能）</label>
          <label className="checkbox"><input type="checkbox" name="onlineSale" defaultChecked={product?.onlineSale ?? true} />オンラインストアで販売</label>
        </div>
        <div className="field full">
          <label htmlFor="description">商品説明</label>
          <textarea id="description" name="description" className="textarea" maxLength={2000} defaultValue={product?.description ?? ''} />
        </div>
        <div className="field full">
          <label htmlFor="image">商品画像</label>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            {preview && !removeImage ? <img src={preview} alt="" className="product-thumb" style={{ width: 88, height: 88 }} /> : <span className="product-thumb" style={{ width: 88, height: 88 }}><ImageOff size={20} /></span>}
            <div className="stack-sm">
              <input id="image" name="image" type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setPreview(URL.createObjectURL(f)); setRemoveImage(false); } }} />
              <div className="hint">JPEG/PNG/WebP、10MBまで。ストアで公開されます。</div>
              {product?.imageUrl && <label className="checkbox"><input type="checkbox" name="removeImage" checked={removeImage} onChange={(e) => setRemoveImage(e.target.checked)} />画像を削除</label>}
            </div>
          </div>
        </div>
      </div>
      <div className="form-actions">
        <SubmitButton pendingText="保存中…">{isNew ? '登録する' : '保存する'}</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function StockForm({ productId, stock }: { productId: string; stock: number }) {
  return (
    <ActionForm action={adjustStockAction} resetOnSuccess>
      <input type="hidden" name="productId" value={productId} />
      <div className="stack">
        <div className="seg" role="radiogroup" aria-label="調整方法">
          <label className="checkbox"><input type="radio" name="mode" value="in" defaultChecked />入庫</label>
          <label className="checkbox"><input type="radio" name="mode" value="out" />出庫・廃棄</label>
          <label className="checkbox"><input type="radio" name="mode" value="set" />棚卸（実数）</label>
        </div>
        <div className="form-grid">
          <div className="field"><label htmlFor="quantity" className="req">数量</label><input id="quantity" name="quantity" className="input num" inputMode="numeric" required placeholder={`現在 ${stock}`} /></div>
          <div className="field"><label htmlFor="reason" className="req">理由</label><input id="reason" name="reason" className="input" required maxLength={200} placeholder="例：仕入れ、破損、棚卸" /></div>
        </div>
        <div className="form-actions"><SubmitButton className="btn secondary" pendingText="調整中…">在庫を調整</SubmitButton></div>
      </div>
    </ActionForm>
  );
}

