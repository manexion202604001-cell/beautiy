import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  SNS_TEMPLATE_LABEL,
  marketingApi,
  useSnsAssets,
  type SnsAsset,
  type SnsTemplate,
} from '../../../api/marketing';
import { CustomerPicker, type PickedCustomer } from '../../../components/appointments/CustomerPicker';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  InlineLoading,
  Input,
  LoadMore,
  Select,
  Spinner,
  Textarea,
  useToast,
} from '../../../components/ui';
import { isApiError, newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { cn } from '../../../lib/cn';
import { sameOriginApiUrl } from '../../../lib/urls';
import { formatDate } from '../../../lib/format';

/** S-62 SNS素材: SVG (1080×1080) from a karte photo (with consent) or a published review quote */
export function SnsAssetsTab() {
  const [template, setTemplate] = useState<'' | SnsTemplate>('');
  const q = useSnsAssets({ template: template || undefined });
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="テンプレート">
          <Select selectSize="sm" value={template} onChange={(e) => setTemplate(e.target.value as '' | SnsTemplate)}>
            <option value="">すべて</option>
            {(Object.keys(SNS_TEMPLATE_LABEL) as SnsTemplate[]).map((t) => (
              <option key={t} value={t}>
                {SNS_TEMPLATE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          素材を作成
        </Button>
      </div>
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !items.length ? (
        <EmptyState icon="grid" title="SNS素材はまだありません" description="カルテの施術写真（掲載同意あり）や口コミから、投稿用の画像を作成できます。" />
      ) : null}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        {items.map((a) => (
          <AssetCard key={a.id} asset={a} onOpen={() => setPreview(a.id)} />
        ))}
      </div>
      <LoadMore hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
      {creating ? (
        <CreateAssetDialog
          onClose={() => setCreating(false)}
          onCreated={(a) => {
            setCreating(false);
            setPreview(a.id);
          }}
        />
      ) : null}
      {preview ? <AssetPreviewDialog id={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

function useAsset(id: string) {
  // the list endpoint has no download URL → fetch the detail (signed URL, 15 min)
  return useQuery({
    queryKey: ['marketing', 'sns', 'detail', id],
    queryFn: () => marketingApi.snsAsset(id),
    select: (a) => ({ ...a, downloadUrl: sameOriginApiUrl(a.downloadUrl) }),
    staleTime: 10 * 60_000,
  });
}

function AssetCard({ asset, onOpen }: { asset: SnsAsset; onOpen: () => void }) {
  const { timezone: tz } = useAuth();
  const d = useAsset(asset.id);
  return (
    <Card padded={false} className="overflow-hidden">
      <button type="button" onClick={onOpen} className="block w-full" aria-label={`${SNS_TEMPLATE_LABEL[asset.template]}の素材を表示`}>
        <div className="flex aspect-square items-center justify-center bg-surface-2">
          {d.data?.downloadUrl ? (
            <img src={d.data.downloadUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <Spinner />
          )}
        </div>
      </button>
      <div className="p-3">
        <p className="text-[13px] font-medium">{SNS_TEMPLATE_LABEL[asset.template]}</p>
        <p className="line-clamp-1 text-xs text-muted">{asset.caption || asset.hashtags.map((h) => `#${h}`).join(' ') || '—'}</p>
        <p className="mt-0.5 text-[11px] text-subtle">
          {formatDate(asset.created_at, tz, { weekday: false })}
          {asset.karte_asset_id ? ' ・掲載同意あり' : ''}
        </p>
      </div>
    </Card>
  );
}

function AssetPreviewDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const d = useAsset(id);
  const [deleting, setDeleting] = useState(false);
  const del = useMutation({
    mutationFn: () => marketingApi.deleteSnsAsset(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['marketing', 'sns'] });
      toast.success('素材を削除しました');
      onClose();
    },
    onError: (e) => toast.error(e),
  });
  const a = d.data;
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="SNS素材"
      description={a ? `${SNS_TEMPLATE_LABEL[a.template]} ・1080×1080 SVG` : undefined}
      footer={
        <>
          <Button variant="ghost" icon="trash" className="mr-auto text-danger!" onClick={() => setDeleting(true)}>
            削除
          </Button>
          <Button onClick={onClose}>閉じる</Button>
          {a?.downloadUrl ? (
            <a
              href={a.downloadUrl}
              download
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg hover:bg-primary-hover"
            >
              ダウンロード
            </a>
          ) : null}
        </>
      }
    >
      {d.isLoading ? <InlineLoading /> : null}
      {d.error ? <ErrorState error={d.error} /> : null}
      {a ? (
        <div className="space-y-3">
          <div className="mx-auto aspect-square w-full max-w-md overflow-hidden rounded-xl border border-border bg-surface-2">
            {a.downloadUrl ? <img src={a.downloadUrl} alt="作成したSNS素材のプレビュー" className="h-full w-full object-contain" data-testid="sns-preview" /> : null}
          </div>
          {a.caption ? <p className="whitespace-pre-wrap text-[13px]">{a.caption}</p> : null}
          {a.hashtags.length ? <p className="text-[13px] text-primary">{a.hashtags.map((h) => `#${h}`).join(' ')}</p> : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="素材を削除しますか？"
        tone="danger"
        confirmLabel="削除する"
        loading={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </Dialog>
  );
}

function CreateAssetDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (a: SnsAsset) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can, currentShopId } = useAuth();
  const [template, setTemplate] = useState<SnsTemplate>('square_style');
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [karteId, setKarteId] = useState('');
  const [assetId, setAssetId] = useState('');
  const [reviewId, setReviewId] = useState('');
  const [consent, setConsent] = useState(false);
  const [caption, setCaption] = useState('');
  const [tags, setTags] = useState('');
  const [key] = useState(newIdempotencyKey);
  const isReview = template === 'review_quote';
  const canKarte = can('karte.read');

  const kartes = useQuery({
    queryKey: ['marketing', 'kartes', customer?.id],
    queryFn: () => marketingApi.kartes(customer!.id),
    enabled: !isReview && !!customer && canKarte,
  });
  const assets = useQuery({
    queryKey: ['marketing', 'karte-assets', karteId],
    queryFn: () => marketingApi.karteAssets(karteId),
    enabled: !isReview && !!karteId,
  });
  const reviews = useQuery({
    queryKey: ['marketing', 'published-reviews'],
    queryFn: marketingApi.publishedReviews,
    enabled: isReview,
  });
  const photos = (assets.data ?? []).filter((a) => a.asset_type !== 'document');

  const create = useMutation({
    mutationFn: () =>
      marketingApi.createSnsAsset(
        {
          template,
          caption: caption.trim(),
          hashtags: tags.split(/[\s,、]+/).map((t) => t.trim()).filter(Boolean),
          ...(isReview ? { reviewId } : assetId ? { karteAssetId: assetId, customerConsent: consent } : {}),
          shopId: currentShopId ?? undefined,
        },
        key,
      ),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ['marketing', 'sns'] });
      toast.success('SNS素材を作成しました');
      onCreated(a);
    },
    onError: (e) =>
      toast.error(isApiError(e) && e.code === 'CUSTOMER_CONSENT_REQUIRED' ? 'お客様の掲載同意の確認が必要です' : e),
  });

  const valid = isReview ? !!reviewId : !assetId || consent;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="SNS素材を作成"
      dismissable={!create.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!valid}>
            作成
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="テンプレート">
          <Select
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value as SnsTemplate);
              setReviewId('');
            }}
          >
            {(Object.keys(SNS_TEMPLATE_LABEL) as SnsTemplate[]).map((t) => (
              <option key={t} value={t}>
                {SNS_TEMPLATE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        {isReview ? (
          <Field label="引用する口コミ（公開中のみ）" required>
            <Select value={reviewId} onChange={(e) => setReviewId(e.target.value)}>
              <option value="">選択してください</option>
              {(reviews.data?.items ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {'★'.repeat(r.rating)} {(r.title || r.body || '').slice(0, 40)}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <div className="space-y-3 rounded-xl border border-border p-3">
            <p className="text-[13px] font-medium">施術写真（任意）</p>
            {!canKarte ? (
              <Alert tone="info">カルテ写真の利用にはカルテ閲覧権限（karte.read）が必要です。写真なしでも作成できます。</Alert>
            ) : (
              <>
                <CustomerPicker
                  value={customer}
                  onChange={(c) => {
                    setCustomer(c);
                    setKarteId('');
                    setAssetId('');
                  }}
                />
                {customer ? (
                  <Field label="カルテ">
                    <Select
                      value={karteId}
                      onChange={(e) => {
                        setKarteId(e.target.value);
                        setAssetId('');
                      }}
                    >
                      <option value="">{kartes.isLoading ? '読み込み中…' : 'カルテを選択'}</option>
                      {(kartes.data?.items ?? []).map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.visit_date} {k.staff_name ?? ''}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                {karteId ? (
                  assets.isLoading ? (
                    <InlineLoading />
                  ) : photos.length ? (
                    <div role="radiogroup" aria-label="写真" className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {photos.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          role="radio"
                          aria-checked={assetId === p.id}
                          onClick={() => setAssetId(assetId === p.id ? '' : p.id)}
                          className={cn(
                            'aspect-square overflow-hidden rounded-lg border-2',
                            assetId === p.id ? 'border-primary' : 'border-transparent',
                          )}
                        >
                          <img src={sameOriginApiUrl(p.url) ?? undefined} alt={p.caption ?? p.asset_type} className="h-full w-full object-cover" />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted">このカルテには写真がありません。</p>
                  )
                ) : null}
                {assetId ? (
                  <Checkbox
                    label="お客様から写真のSNS掲載について同意を得ています"
                    description="同意がない写真は使用できません。確認内容は監査ログに記録されます。"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                ) : null}
                {template === 'before_after' ? (
                  <p className="text-xs text-muted">ビフォー・アフターはカルテ内のビフォー/アフター写真を組み合わせて作成します。</p>
                ) : null}
              </>
            )}
          </div>
        )}
        <Field label="キャプション" optional>
          <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={3} maxLength={300} />
        </Field>
        <Field label="ハッシュタグ" optional hint="スペースまたはカンマ区切り（# は不要）">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ヘアカラー 秋カラー 渋谷美容室" />
        </Field>
      </div>
    </Dialog>
  );
}

