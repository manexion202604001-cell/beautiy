import { describe, expect, it } from 'vitest';
import { mediaBadges, needsMediaAction } from './mediaSync';

const block = (state: string, provider = 'hotpepper_mail') => ({
  id: `${provider}-${state}`,
  provider,
  state,
  manual: true,
  last_error: null,
  updated_at: '2026-10-13T00:00:00Z',
});

describe('mediaBadges', () => {
  it('shows nothing when no booking medium is involved', () => {
    expect(mediaBadges(undefined)).toEqual([]);
    expect(mediaBadges({ origin: null, blocks: [] })).toEqual([]);
    expect(needsMediaAction({ origin: null, blocks: [] })).toBe(false);
  });

  it('puts a slot that still has to be blocked first (double-booking risk)', () => {
    const sync = {
      origin: {
        provider: 'lime_mail',
        sync_state: 'synced',
        last_synced_at: null,
        last_error: null,
      },
      blocks: [block('pushed', 'lime_mail'), block('action_required')],
    };
    const badges = mediaBadges(sync);
    expect(badges.map((b) => [b.label, b.tone])).toEqual([
      ['HPB 枠止め未対応', 'danger'],
      ['LiME', 'info'],
    ]);
    expect(needsMediaAction(sync)).toBe(true);
    // the detail view also lists finished work
    expect(mediaBadges(sync, { includeDone: true }).map((b) => b.label)).toContain('LiME 枠止め済');
  });

  it('flags reopen requests, errors and imports that need a decision', () => {
    expect(mediaBadges({ origin: null, blocks: [block('remove_required')] })[0]).toMatchObject({
      label: 'HPB 枠再開未対応',
      tone: 'warning',
    });
    expect(mediaBadges({ origin: null, blocks: [block('error')] })[0]).toMatchObject({
      label: 'HPB 連携エラー',
      tone: 'danger',
    });
    expect(
      mediaBadges({
        origin: {
          provider: 'hotpepper_mail',
          sync_state: 'conflict',
          last_synced_at: null,
          last_error: null,
        },
        blocks: [],
      })[0],
    ).toMatchObject({ label: 'HPB 要確認', tone: 'danger' });
    expect(needsMediaAction({ origin: null, blocks: [block('pushed')] })).toBe(false);
  });

  it('falls back to a generic name for an unknown medium', () => {
    expect(
      mediaBadges({
        origin: {
          provider: 'new_media',
          sync_state: 'synced',
          last_synced_at: null,
          last_error: null,
        },
        blocks: [],
      })[0]?.label,
    ).toBe('媒体');
  });
});
