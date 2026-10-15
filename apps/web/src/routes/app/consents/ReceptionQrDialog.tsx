import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Printer } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { walkinApi, walkinKeys } from '../../../api/walkin';
import { QrCode } from '../../../components/forms/QrCode';
import { Button, Dialog, DialogTitle, Select } from '../../../components/shad';

const PRINT_CSS = `
  .walkin-print-portal { display: none; }
  @media print {
    body > *:not(.walkin-print-portal) { display: none !important; }
    .walkin-print-portal { display: block !important; }
    .walkin-print-root {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; min-height: 100vh; gap: 20px; font-family: sans-serif;
    }
  }
`;

/**
 * 受付QRコード: the QR a walk-in customer scans to fill the consent form and the counselling
 * sheets (opens /consent/:shopSlug). With `staffId` the intake is recorded for that staff member.
 */
export function ReceptionQrDialog({
  open,
  onOpenChange,
  shopId,
  staffId,
  staffName,
  options,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shopId: string | null;
  staffId?: string | null;
  staffName?: string | null;
  /** extra controls shown under the QR (e.g. a staff picker) */
  options?: ReactNode;
}) {
  const [formId, setFormId] = useState('');
  const q = { shopId: shopId ?? '', staffId: staffId ?? undefined };
  const linkQ = useQuery({
    queryKey: walkinKeys.receptionLink(q),
    queryFn: () => walkinApi.receptionLink(q),
    enabled: open && !!shopId,
    staleTime: 60_000,
  });
  const link = linkQ.data;
  const forms = link?.consentForms ?? [];
  const picked = forms.find((f) => f.lineageId === formId);
  // the first form is the shop's default: its QR carries no form parameter
  const url = !link || forms.length === 0 ? null : picked && picked !== forms[0] ? picked.url : link.url;
  const shopName = link?.shop.name ?? '';
  const heading = staffName ?? link?.staff?.name ?? '受付';
  const caption = 'QRを読み取って同意書・カウンセリングをご記入ください';

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        className="w-[calc(100vw-2rem)] max-w-sm"
        title={<DialogTitle>受付QRコード</DialogTitle>}
      >
        <div className="flex flex-col items-center gap-3 py-4">
          {shopName ? <p className="text-sm text-muted-foreground">{shopName}</p> : null}
          <p className="text-lg font-bold">{heading}</p>
          {url ? (
            <QrCode value={url} size={220} label="受付QRコード" />
          ) : (
            <div className="grid h-[220px] w-[220px] place-items-center text-center text-xs text-muted-foreground">
              {linkQ.isLoading ? (
                '読み込み中...'
              ) : linkQ.isError ? (
                'QRコードを作成できません'
              ) : (
                <span>
                  同意書フォームが登録されていません。
                  <br />
                  <Link to="/app/kartes/forms" className="text-primary underline-offset-4 hover:underline">
                    問診・同意書フォームの編集
                  </Link>
                  から登録してください。
                </span>
              )}
            </div>
          )}
          {forms.length > 1 ? (
            <div className="w-full">
              <Select
                label="同意書フォーム"
                value={picked?.lineageId ?? forms[0]!.lineageId}
                onValueChange={setFormId}
                options={forms.map((f) => ({ value: f.lineageId, label: f.name }))}
              />
            </div>
          ) : null}
          {options ? <div className="w-full">{options}</div> : null}
          {link && !link.shop.open ? (
            <p className="text-center text-xs text-destructive">この店舗は営業中の設定ではないため、受付ページを開けません。</p>
          ) : null}
          <p className="text-center text-xs text-muted-foreground">
            QRを読み取って同意書・カウンセリングを
            <br />
            ご記入ください
          </p>
        </div>
        <Button onClick={() => window.print()} className="w-full" disabled={!url}>
          <Printer className="mr-2 h-4 w-4" />
          印刷
        </Button>
        <Button variant="outline" className="w-full" disabled={!url} onClick={() => url && window.open(url, '_blank')}>
          <ExternalLink className="mr-2 h-4 w-4" />
          リンクを開く
        </Button>
      </Dialog>
      {open && url
        ? createPortal(
            <div className="walkin-print-portal">
              <style>{PRINT_CSS}</style>
              <div className="walkin-print-root">
                {shopName ? <p style={{ fontSize: 14, color: '#666', margin: 0 }}>{shopName}</p> : null}
                <p style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{heading}</p>
                <QrCode value={url} size={280} label="受付QRコード" />
                <p style={{ fontSize: 12, color: '#666', margin: 0 }}>{caption}</p>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
