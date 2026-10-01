import { ButtonLink, EmptyState } from '../components/ui';

export function NotFound({ inApp }: { inApp?: boolean }) {
  return (
    <div className={inApp ? 'py-10' : 'mx-auto flex min-h-screen max-w-lg items-center p-6'}>
      <EmptyState
        className="w-full"
        icon="map"
        title="ページが見つかりません"
        description="URLが間違っているか、ページが移動した可能性があります。"
        action={
          <ButtonLink to={inApp ? '/app' : '/'} variant="primary">
            トップへ戻る
          </ButtonLink>
        }
      />
    </div>
  );
}
