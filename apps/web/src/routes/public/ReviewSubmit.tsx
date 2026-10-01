import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { reviewsApi } from '../../api/reviews';
import { StarInput } from '../../components/forms/Stars';
import {
  Alert,
  Button,
  EmptyState,
  Field,
  Icon,
  Input,
  PageSpinner,
  Textarea,
} from '../../components/ui';
import { errorMessage, isApiError } from '../../lib/api';
import { formatDateJa } from '../../lib/format';
import { PublicShell, ShopHeader } from './PublicShell';

/** /review/:token (also /r/:token) — single-use review submission */
export default function ReviewSubmit() {
  const { token = '' } = useParams();
  const q = useQuery({
    queryKey: ['public', 'review-request', token],
    queryFn: () => reviewsApi.publicRequest(token),
    retry: false,
    staleTime: Infinity,
  });
  const [rating, setRating] = useState(0);
  const [staffRating, setStaffRating] = useState(0);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ googleReviewUrl: string | null; status: string } | null>(
    null,
  );

  if (q.isLoading) return <PageSpinner />;
  if (q.error || !q.data) {
    const invalid =
      isApiError(q.error) && (q.error.code === 'INVALID_LINK' || q.error.status === 401);
    return (
      <PublicShell>
        <EmptyState
          className="mt-10"
          icon="star"
          title={
            invalid ? 'このリンクは投稿済みか、有効期限が切れています' : '読み込みに失敗しました'
          }
          description={invalid ? 'ご協力ありがとうございました。' : errorMessage(q.error)}
        />
      </PublicShell>
    );
  }
  const v = q.data;
  const header = <ShopHeader name={v.shop.name} sub="口コミのお願い" />;

  if (result) {
    return (
      <PublicShell header={header}>
        <div className="mt-8 flex flex-col items-center text-center">
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success">
            <Icon name="check" size={28} />
          </span>
          <h1 className="text-lg font-semibold">ご協力ありがとうございました</h1>
          <p className="mt-2 text-[13px] text-muted">
            {result.status === 'published'
              ? '口コミを公開しました。'
              : 'いただいた口コミは確認後に公開されます。'}
          </p>
          {result.googleReviewUrl ? (
            <div className="mt-6 w-full rounded-2xl border border-border bg-surface p-4 text-left">
              <p className="text-sm font-medium">よろしければ Google でも感想をお聞かせください</p>
              <p className="mt-1 text-xs text-muted">
                任意です。投稿いただかなくても特典や対応に違いはありません。
              </p>
              <a
                href={result.googleReviewUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-border-strong text-sm font-medium hover:bg-surface-2"
                data-testid="google-review-link"
              >
                Google で口コミを書く <Icon name="external" size={16} />
              </a>
            </div>
          ) : null}
        </div>
      </PublicShell>
    );
  }

  const submit = async () => {
    if (!rating) return setError('評価（星）を選んでください');
    setBusy(true);
    setError(null);
    try {
      const r = await reviewsApi.publicSubmit(token, {
        rating,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(body.trim() ? { body: body.trim() } : {}),
        ...(nickname.trim() ? { reviewerName: nickname.trim() } : {}),
        ...(v.staff && staffRating ? { staffRating } : {}),
      });
      setResult({ googleReviewUrl: r.googleReviewUrl, status: r.status });
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicShell header={header}>
      <h1 className="text-lg font-semibold">ご来店ありがとうございました</h1>
      <p className="mb-5 text-[13px] text-muted">
        {v.visit.date ? `${formatDateJa(v.visit.date)}のご来店` : 'ご来店'}
        {v.visit.menus.length ? ` ・ ${v.visit.menus.join('、')}` : ''}
        {v.staff ? ` ・ 担当 ${v.staff.displayName}` : ''}
      </p>
      {error ? (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}
      <div className="space-y-5 rounded-2xl border border-border bg-surface p-4">
        <div>
          <p className="mb-2 text-sm font-medium">
            総合評価 <span className="text-danger">*</span>
          </p>
          <StarInput value={rating} onChange={setRating} label="総合評価" />
        </div>
        {v.staff ? (
          <div>
            <p className="mb-2 text-sm font-medium">{v.staff.displayName}（担当）の評価（任意）</p>
            <StarInput
              value={staffRating}
              onChange={setStaffRating}
              label="担当スタッフの評価"
              size={32}
            />
          </div>
        ) : null}
        <Field label="タイトル" optional>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={100}
            inputSize="lg"
          />
        </Field>
        <Field label="ご感想" optional hint={`${body.length} / 2000`}>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            maxLength={2000}
            placeholder="仕上がりや接客など、ご自由にお書きください"
          />
        </Field>
        <Field label="ニックネーム" optional hint="公開時に表示されます（本名は表示されません）">
          <Input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            maxLength={30}
            inputSize="lg"
          />
        </Field>
      </div>
      <Button
        variant="primary"
        size="lg"
        className="mt-5 w-full"
        loading={busy}
        onClick={() => void submit()}
        data-testid="submit-review"
      >
        口コミを投稿する
      </Button>
    </PublicShell>
  );
}
