import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { publicMessagingApi } from '../../api/messaging';
import { Alert, Card, Field, Icon, Input, Spinner } from '../../components/ui';
import { errorMessage, isApiError } from '../../lib/api';
import { useLiff } from '../../lib/liff';
import { getLineIdToken, lineAvailable, usingLineMock } from './CustomerLogin';
import { FriendAddButton } from './FriendAddButton';
import { PublicShell } from './PublicShell';

/**
 * /line/link?token= (or LIFF https://liff.line.me/<liffId>/line/link?linkToken=…&liffId=…) — links the
 * customer's LINE account to the record the staff issued the QR for. The page initialises the LIFF
 * app of the link's LINE account and sends its id token; in development a mock id token is sent.
 */
export default function LineLink() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? params.get('linkToken') ?? '';
  const liffState = useLiff({ linkToken: token.length >= 10 ? token : undefined, liffId: params.get('liffId') });
  const [mockName, setMockName] = useState('LINEユーザー');
  const link = useMutation({
    mutationFn: async () => {
      const idToken = getLineIdToken(mockName.trim() || 'LINEユーザー');
      if (!idToken) throw new Error('LINEアプリでこのページを開いてください');
      return publicMessagingApi.lineLink(token, idToken);
    },
  });
  const conflict = isApiError(link.error) && link.error.code === 'LINE_ALREADY_LINKED';
  const showMock = usingLineMock();
  const preparing = liffState.status === 'loading';

  return (
    <PublicShell>
      <Card className="mt-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#06c755] text-white">
            <Icon name="line" size={20} />
          </span>
          <h1 className="text-lg font-semibold">LINEアカウントの連携</h1>
        </div>
        {token.length < 10 ? (
          <Alert tone="danger" title="リンクが正しくありません">
            店舗スタッフが表示したQRコードを、もう一度読み取ってください。
          </Alert>
        ) : link.isSuccess ? (
          <div className="space-y-3" role="status">
            <Alert tone="success" title="連携が完了しました">
              今後はLINEで予約の確認やお知らせを受け取れます。
            </Alert>
            {link.data.following !== true ? (
              <div className="space-y-2">
                <p className="text-sm">お知らせを受け取るには、LINE公式アカウントを友だち追加してください。</p>
                <FriendAddButton url={liffState.friendUrl} />
              </div>
            ) : null}
            <p className="text-[13px] text-muted-foreground">このページは閉じて構いません。</p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm">
              ボタンを押すと、お使いのLINEアカウントとサロンのお客様情報を連携します。連携後はLINEで予約の確認・リマインドを受け取れます。
            </p>
            {showMock ? (
              <Field label="LINE表示名（開発用モック）" hint="開発環境ではモックのIDトークンを送信します">
                <Input value={mockName} onChange={(e) => setMockName(e.target.value)} maxLength={50} />
              </Field>
            ) : null}
            {conflict ? (
              <Alert tone="warning" title="このLINEアカウントは別のお客様情報に連携済みです">
                お手数ですが、店舗スタッフにお申し付けください。
              </Alert>
            ) : link.error ? (
              <Alert tone="danger">{errorMessage(link.error)}</Alert>
            ) : null}
            <button
              type="button"
              onClick={() => link.mutate()}
              disabled={link.isPending || preparing || !lineAvailable()}
              aria-busy={link.isPending || preparing || undefined}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#06C755] text-[15px] font-semibold text-white shadow-sm hover:brightness-105 disabled:opacity-60"
            >
              {link.isPending || preparing ? <Spinner size={20} /> : <Icon name="line" size={20} />}
              LINEで連携する{showMock ? '（開発用モック）' : ''}
            </button>
            {!preparing && !lineAvailable() ? <p className="text-xs text-muted-foreground">LINEアプリ内で開いてください。</p> : null}
            {liffState.friendUrl ? (
              <div className="space-y-2 border-t border-border pt-4">
                <p className="text-[13px] text-muted-foreground">まだ友だち追加していない方はこちら</p>
                <FriendAddButton url={liffState.friendUrl} />
              </div>
            ) : null}
          </div>
        )}
      </Card>
    </PublicShell>
  );
}
