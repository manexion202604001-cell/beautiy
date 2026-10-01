import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { sameOriginBlobUrl } from '../../api/files';
import { ASSET_TYPE_LABEL, kartesApi } from '../../api/kartes';
import { EmptyState, PageSpinner } from '../../components/ui';
import { isApiError } from '../../lib/api';
import { formatDateJa, formatYen } from '../../lib/format';
import { PublicShell, ShopHeader } from './PublicShell';

/** /k/:token — customer-safe karte share (photos, visible fields, homecare, recommended products) */
export default function KarteShare() {
  const { token = '' } = useParams();
  const q = useQuery({
    queryKey: ['public', 'karte-share', token],
    queryFn: () => kartesApi.publicShare(token),
    retry: false,
  });
  if (q.isLoading) return <PageSpinner />;
  if (q.error || !q.data) {
    const invalid =
      isApiError(q.error) &&
      (q.error.code === 'INVALID_LINK' || q.error.status === 401 || q.error.status === 404);
    return (
      <PublicShell>
        <EmptyState
          className="mt-10"
          icon="lock"
          title={invalid ? 'リンクが無効か有効期限が切れています' : '読み込みに失敗しました'}
          description={
            invalid
              ? 'お手数ですが、サロンへお問い合わせください。'
              : '通信環境をご確認のうえ、再度お試しください。'
          }
        />
      </PublicShell>
    );
  }
  const k = q.data;
  const before = k.assets.filter((a) => a.assetType === 'photo_before');
  const after = k.assets.filter((a) => a.assetType === 'photo_after');
  const others = k.assets.filter(
    (a) => a.assetType !== 'photo_before' && a.assetType !== 'photo_after',
  );
  return (
    <PublicShell header={<ShopHeader name={k.shop.name} sub="施術のご報告" />}>
      <h1 className="text-lg font-semibold">{formatDateJa(k.visitDate, { year: true })}のご来店</h1>
      <p className="mb-5 text-[13px] text-muted">
        担当 {k.staff.displayName ?? '—'}
        {k.title ? ` ・ ${k.title}` : ''}
      </p>

      {before.length || after.length ? (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold">ビフォー・アフター</h2>
          <div className="grid grid-cols-2 gap-2">
            {[
              ...before.map((a) => ({ a, label: 'Before' })),
              ...after.map((a) => ({ a, label: 'After' })),
            ].map(({ a, label }) => (
              <figure
                key={a.id}
                className="overflow-hidden rounded-2xl border border-border bg-surface"
              >
                <img
                  src={sameOriginBlobUrl(a.url)}
                  alt={a.caption ?? `${label}の写真`}
                  className="aspect-[3/4] w-full object-cover"
                  loading="lazy"
                />
                <figcaption className="px-3 py-1.5 text-xs text-muted">
                  <span className="font-semibold text-fg">{label}</span> {a.caption ?? ''}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      ) : null}
      {others.length ? (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold">写真</h2>
          <div className="grid grid-cols-2 gap-2">
            {others.map((a) => (
              <figure
                key={a.id}
                className="overflow-hidden rounded-2xl border border-border bg-surface"
              >
                <img
                  src={sameOriginBlobUrl(a.url)}
                  alt={a.caption ?? ASSET_TYPE_LABEL[a.assetType]}
                  className="aspect-square w-full object-cover"
                  loading="lazy"
                />
                {a.caption ? (
                  <figcaption className="px-3 py-1.5 text-xs text-muted">{a.caption}</figcaption>
                ) : null}
              </figure>
            ))}
          </div>
        </section>
      ) : null}

      {k.fields.length ? (
        <section className="mb-6 rounded-2xl border border-border bg-surface p-4">
          <h2 className="mb-2 text-sm font-semibold">本日の施術</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            {k.fields.map((f) => (
              <div key={f.key} className="contents">
                <dt className="text-muted">{f.label}</dt>
                <dd>{f.display}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {k.homecare.advice || k.homecare.products.length ? (
        <section className="mb-6 rounded-2xl border border-border bg-surface p-4">
          <h2 className="mb-2 text-sm font-semibold">ホームケアのアドバイス</h2>
          {k.homecare.advice ? (
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{k.homecare.advice}</p>
          ) : null}
          {k.homecare.products.length ? (
            <>
              <h3 className="mb-1.5 mt-4 text-xs font-semibold text-muted">おすすめの商品</h3>
              <ul className="space-y-2">
                {k.homecare.products.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2.5"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{p.name}</span>
                      {p.brand ? <span className="text-xs text-muted">{p.brand}</span> : null}
                    </span>
                    <a
                      href={`/store/products/${p.id}`}
                      className="shrink-0 text-[13px] font-medium text-primary"
                    >
                      {p.priceTaxIncluded ? formatYen(p.price) : `${formatYen(p.price)}（税抜）`} ›
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}
      {!k.assets.length && !k.fields.length && !k.homecare.advice && !k.homecare.products.length ? (
        <EmptyState icon="file" title="共有された内容はまだありません" />
      ) : null}
      <p className="text-center text-xs text-subtle">
        このページはお客様専用です。第三者への共有はお控えください。
      </p>
    </PublicShell>
  );
}
