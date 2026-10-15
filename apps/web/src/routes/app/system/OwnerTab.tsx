import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useOrganization } from '../../../api/org';
import { ownerProfileOf, useSaveOwnerProfile, type OwnerType } from '../../../api/storeSettings';
import { MfaDialog, PasswordDialog } from '../../../components/layout/AccountDialogs';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Separator,
} from '../../../components/shad';
import { Alert, AlertDescription } from '../../../components/shad/alert';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';

const EMPTY = {
  owner_type: '' as OwnerType | '',
  company_name: '',
  company_postal_code: '',
  company_phone: '',
  company_address: '',
  company_email: '',
};

/** オーナー情報: 事業形態 and company details of the organization */
export function OwnerProfileCard() {
  const orgQ = useOrganization();
  const save = useSaveOwnerProfile();
  const [form, setForm] = useState(EMPTY);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // same object for as long as the loaded organization is unchanged (query data is shared structurally)
  const saved = ownerProfileOf(orgQ.data);
  useEffect(() => {
    if (!saved) return;
    setForm({
      owner_type: saved.ownerType,
      company_name: saved.companyName || '',
      company_postal_code: saved.companyPostalCode || '',
      company_phone: saved.companyPhone || '',
      company_address: saved.companyAddress || '',
      company_email: saved.companyEmail || '',
    });
  }, [saved]);

  const saving = save.isPending;
  const submit = () => {
    if (!form.owner_type) return;
    setMessage(null);
    const company = form.owner_type === 'company';
    save.mutate(
      {
        ownerType: form.owner_type,
        companyName: (company && form.company_name.trim()) || null,
        companyPostalCode: (company && form.company_postal_code.trim()) || null,
        companyPhone: (company && form.company_phone.trim()) || null,
        companyAddress: (company && form.company_address.trim()) || null,
        companyEmail: (company && form.company_email.trim()) || null,
      },
      {
        onSuccess: () => setMessage({ type: 'success', text: 'オーナー情報を保存しました' }),
        onError: (e) => setMessage({ type: 'error', text: errorMessage(e) || '保存に失敗しました' }),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>オーナー情報</CardTitle>
        <CardDescription>事業形態や会社情報を設定します</CardDescription>
      </CardHeader>
      <CardContent className="sy-4">
        {message ? (
          <Alert variant={message.type === 'error' ? 'destructive' : 'default'}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        ) : null}
        <div className="sy-2">
          <Label>事業形態</Label>
          <Select
            label="事業形態"
            value={form.owner_type}
            onValueChange={(v) => setForm({ ...form, owner_type: v as OwnerType })}
            placeholder="選択してください"
            options={[
              { value: 'individual', label: '個人' },
              { value: 'company', label: '法人' },
            ]}
          />
        </div>
        {form.owner_type === 'company' ? (
          <>
            <Separator />
            <div className="sy-2">
              <Label htmlFor="company-name">会社名</Label>
              <Input
                id="company-name"
                value={form.company_name}
                onChange={(e) => setForm({ ...form, company_name: e.target.value })}
                placeholder="株式会社○○"
              />
            </div>
            <div className="sy-2">
              <Label htmlFor="company-postal-code">郵便番号</Label>
              <Input
                id="company-postal-code"
                value={form.company_postal_code}
                onChange={(e) => setForm({ ...form, company_postal_code: e.target.value })}
                placeholder="123-4567"
              />
            </div>
            <div className="sy-2">
              <Label htmlFor="company-address">住所</Label>
              <Input
                id="company-address"
                value={form.company_address}
                onChange={(e) => setForm({ ...form, company_address: e.target.value })}
                placeholder="東京都..."
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="sy-2">
                <Label htmlFor="company-phone">電話番号</Label>
                <Input
                  id="company-phone"
                  value={form.company_phone}
                  onChange={(e) => setForm({ ...form, company_phone: e.target.value })}
                  placeholder="03-1234-5678"
                />
              </div>
              <div className="sy-2">
                <Label htmlFor="company-email">メールアドレス</Label>
                <Input
                  id="company-email"
                  type="email"
                  value={form.company_email}
                  onChange={(e) => setForm({ ...form, company_email: e.target.value })}
                  placeholder="info@example.com"
                />
              </div>
            </div>
          </>
        ) : null}
        <Separator />
        <Button onClick={submit} disabled={saving || !form.owner_type}>
          {saving ? '保存中...' : '保存'}
        </Button>
      </CardContent>
    </Card>
  );
}

/** アカウント: password, two-factor sign-in and switching to another organization */
export function AccountCard() {
  const { me, switchOrganization } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [pwOpen, setPwOpen] = useState(false);
  const [mfaOpen, setMfaOpen] = useState(false);
  const otherOrgs = (me?.organizations ?? []).filter((o) => o.id !== me?.organization.id);

  return (
    <Card>
      <CardHeader>
        <CardTitle>アカウント</CardTitle>
        <CardDescription>{me?.user.email}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="sy-4">
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <div className="font-medium">パスワード</div>
              <div className="text-sm text-muted-foreground">ログイン用のパスワードを変更します</div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setPwOpen(true)}>
              パスワード変更
            </Button>
          </div>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <div className="font-medium">二段階認証</div>
              <div className="text-sm text-muted-foreground">
                {me?.user.mfa_enabled ? '有効' : '無効'}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setMfaOpen(true)}>
              二段階認証
            </Button>
          </div>
          {otherOrgs.map((o) => (
            <div key={o.id} className="flex items-center justify-between rounded-lg border p-4">
              <div>
                <div className="font-medium">{o.name}</div>
                <div className="text-sm text-muted-foreground">所属している別の法人</div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  switchOrganization(o.id)
                    .then(() => {
                      navigate('/app');
                      toast.success(`${o.name} に切り替えました`);
                    })
                    .catch((e) => toast.error(e));
                }}
              >
                切り替え
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
      <PasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
      <MfaDialog open={mfaOpen} onClose={() => setMfaOpen(false)} />
    </Card>
  );
}
