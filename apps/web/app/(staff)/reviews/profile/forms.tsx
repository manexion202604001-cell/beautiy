'use client';
import { useEffect, useState } from 'react';
import { ActionForm, SubmitButton } from '@/components/client';
import { Field } from '@/components/ui';
import { saveShopProfileAction, saveStaffProfileAction } from '../actions';

function ImageInput({ current, label }: { current: string | null; label: string }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [remove, setRemove] = useState(false);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const shown = preview ?? (remove ? null : current);
  return (
    <div className="field full">
      <label>{label}</label>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {shown ? <img src={shown} alt="" className="upload-preview" /> : <div className="upload-preview" style={{ display: 'grid', placeItems: 'center' }}><span className="sub">未設定</span></div>}
        <div className="stack-sm">
          <input type="file" name="image" accept="image/jpeg,image/png,image/webp,image/gif" className="input" onChange={(e) => {
            const f = e.target.files?.[0];
            setPreview(f ? URL.createObjectURL(f) : null);
          }} />
          <div className="hint">JPEG/PNG/WebP/GIF・10MBまで。公開ページに表示されます。</div>
          {current && !preview && <label className="checkbox"><input type="checkbox" name="removeImage" checked={remove} onChange={(e) => setRemove(e.target.checked)} />画像を削除する</label>}
        </div>
      </div>
    </div>
  );
}

export interface ShopProfile { id: string; name: string; description: string | null; accessInfo: string | null; hygieneInfo: string | null; imageUrl: string | null; instagramUrl: string | null; websiteUrl: string | null }

export function ShopProfileForm({ shop }: { shop: ShopProfile }) {
  return (
    <ActionForm action={saveShopProfileAction} key={shop.id}>
      <input type="hidden" name="shopId" value={shop.id} />
      <div className="form-grid">
        <ImageInput current={shop.imageUrl} label="メイン画像" />
        <Field label="紹介文" full hint="サロンのコンセプトや得意なスタイルなど"><textarea name="description" className="textarea" rows={5} maxLength={2000} defaultValue={shop.description ?? ''} /></Field>
        <Field label="アクセス" full hint="最寄り駅からの道順、駐車場など"><textarea name="accessInfo" className="textarea" rows={3} maxLength={1000} defaultValue={shop.accessInfo ?? ''} /></Field>
        <Field label="衛生管理・サロン情報" full hint="消毒・換気の取り組み、設備、支払い方法など"><textarea name="hygieneInfo" className="textarea" rows={4} maxLength={2000} defaultValue={shop.hygieneInfo ?? ''} /></Field>
        <Field label="Instagram" hint="URL または @ユーザー名"><input name="instagramUrl" className="input" maxLength={200} defaultValue={shop.instagramUrl ?? ''} placeholder="@yoursalon" /></Field>
        <Field label="Webサイト"><input name="websiteUrl" type="url" className="input" maxLength={300} defaultValue={shop.websiteUrl ?? ''} placeholder="https://" /></Field>
      </div>
      <div className="form-actions"><SubmitButton pendingText="保存中…">店舗プロフィールを保存</SubmitButton></div>
    </ActionForm>
  );
}

export interface StaffProfile { id: string; displayName: string; publicBio: string | null; specialties: string | null; imageUrl: string | null; instagramUrl: string | null }

export function StaffProfileForm({ member, self }: { member: StaffProfile; self: boolean }) {
  return (
    <ActionForm action={saveStaffProfileAction} key={member.id}>
      {!self && <input type="hidden" name="membershipId" value={member.id} />}
      <div className="form-grid">
        <ImageInput current={member.imageUrl} label="プロフィール写真" />
        <Field label="自己紹介" full><textarea name="publicBio" className="textarea" rows={5} maxLength={1500} defaultValue={member.publicBio ?? ''} placeholder="得意なスタイルや大切にしていること" /></Field>
        <Field label="得意な技術・スタイル" hint="読点（、）区切りでタグとして表示されます"><input name="specialties" className="input" maxLength={200} defaultValue={member.specialties ?? ''} placeholder="ショート、透明感カラー、髪質改善" /></Field>
        <Field label="Instagram" hint="URL または @ユーザー名"><input name="instagramUrl" className="input" maxLength={200} defaultValue={member.instagramUrl ?? ''} /></Field>
      </div>
      <div className="form-actions"><SubmitButton pendingText="保存中…">プロフィールを保存</SubmitButton></div>
    </ActionForm>
  );
}
