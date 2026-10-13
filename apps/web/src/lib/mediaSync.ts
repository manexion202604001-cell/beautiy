import type { AppointmentMediaSync } from '../api/types';

/** Short names for the calendar; the long form goes in the title / detail */
export const MEDIA_SHORT: Record<string, string> = {
  hotpepper_mail: 'HPB',
  lime_mail: 'LiME',
  mock_booking: '媒体',
};
export const MEDIA_NAME: Record<string, string> = {
  hotpepper_mail: 'ホットペッパー（サロンボード）',
  lime_mail: 'LiME',
  mock_booking: '外部予約媒体',
};

export interface MediaBadge {
  key: string;
  label: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  title: string;
}

const mediaName = (p: string) => MEDIA_NAME[p] ?? p;
const mediaShort = (p: string) => MEDIA_SHORT[p] ?? '媒体';

/**
 * What staff must know about a reservation and the booking media, most urgent first:
 * a slot that still has to be blocked on a medium is a double-booking risk.
 */
export function mediaBadges(
  sync: AppointmentMediaSync | null | undefined,
  opts: { includeDone?: boolean } = {},
): MediaBadge[] {
  if (!sync) return [];
  const out: MediaBadge[] = [];
  for (const b of sync.blocks) {
    const short = mediaShort(b.provider);
    const name = mediaName(b.provider);
    if (b.state === 'action_required')
      out.push({
        key: b.id,
        label: `${short} 枠止め未対応`,
        tone: 'danger',
        title: `${name}の枠をまだ止めていません。媒体の管理画面で枠を止めて「対応済み」にしてください`,
      });
    else if (b.state === 'remove_required')
      out.push({
        key: b.id,
        label: `${short} 枠再開未対応`,
        tone: 'warning',
        title: `${name}で止めた枠をまだ再開していません`,
      });
    else if (b.state === 'error')
      out.push({
        key: b.id,
        label: `${short} 連携エラー`,
        tone: 'danger',
        title: b.last_error ?? `${name}への反映に失敗しました`,
      });
    else if (b.state === 'pending')
      out.push({
        key: b.id,
        label: `${short} 反映待ち`,
        tone: 'warning',
        title: `${name}への反映を待っています`,
      });
    else if (opts.includeDone && b.state === 'pushed')
      out.push({
        key: b.id,
        label: `${short} 枠止め済`,
        tone: 'success',
        title: `${name}の枠を止めました`,
      });
    else if (opts.includeDone && b.state === 'removed')
      out.push({
        key: b.id,
        label: `${short} 枠再開済`,
        tone: 'neutral',
        title: `${name}の枠を再開しました`,
      });
  }
  if (sync.origin) {
    const short = mediaShort(sync.origin.provider);
    const name = mediaName(sync.origin.provider);
    const bad = sync.origin.sync_state === 'error' || sync.origin.sync_state === 'conflict';
    out.push(
      bad
        ? {
            key: 'origin',
            label: `${short} 要確認`,
            tone: 'danger',
            title:
              sync.origin.last_error ?? `${name}からの取り込みに確認が必要です（外部連携 › 競合）`,
          }
        : { key: 'origin', label: short, tone: 'info', title: `${name}から取り込んだ予約` },
    );
  }
  const rank = { danger: 0, warning: 1, info: 2, success: 3, neutral: 4 } as const;
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

/** true when a slot still has to be blocked / reopened by hand on some medium */
export function needsMediaAction(sync: AppointmentMediaSync | null | undefined): boolean {
  return !!sync?.blocks.some(
    (b) => b.state === 'action_required' || b.state === 'remove_required' || b.state === 'error',
  );
}
