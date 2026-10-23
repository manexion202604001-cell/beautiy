import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppointmentDetail, SalonboardSync } from '../../../api/types';
import {
  SalonboardButton,
  SalonboardChip,
  SalonboardRow,
  salonboardReserveUrl,
} from './salonboard';

const h = vi.hoisted(() => ({
  sync: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../../../components/ui', () => ({ useToast: () => h.toast }));
vi.mock('../../../api/appointments', () => ({
  appointmentKeys: { all: ['appointments'] },
  appointmentsApi: { syncSalonboard: h.sync },
}));

const sb = (over: Partial<SalonboardSync> = {}): SalonboardSync => ({
  enabled: true,
  auto: true,
  origin: null,
  reserve_id: null,
  state: null,
  message: null,
  synced_at: null,
  ...over,
});
const appt = (salonboard: SalonboardSync | undefined, over: Partial<AppointmentDetail> = {}) =>
  ({
    id: 'a1',
    status: 'confirmed',
    source: 'phone_hpb',
    media_sync: { origin: null, blocks: [], salonboard },
    ...over,
  }) as unknown as AppointmentDetail;

function wrap(node: ReactNode) {
  const client = new QueryClient();
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => vi.clearAllMocks());

describe('予約詳細 › サロンボード', () => {
  it('links an HPB booking to its SALON BOARD reservation', () => {
    expect(salonboardReserveUrl('BE12345678')).toBe(
      'https://salonboard.com/KLP/reserve/net/reserveDetail/?reserveId=BE12345678',
    );
    expect(salonboardReserveUrl('L-1')).toBeNull();
    wrap(
      <SalonboardChip
        a={appt(sb({ origin: 'hotpepper', reserve_id: 'BE12345678', state: 'synced' }), {
          source: 'external',
        })}
      />,
    );
    const link = screen.getByRole('link', { name: /SB予約詳細/ });
    expect(link).toHaveAttribute('href', salonboardReserveUrl('BE12345678'));
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('title', 'SB連携済 BE12345678');
  });

  it('shows 連携済 / エラー / 連携待ち with the time, for bookings taken elsewhere (phone_hpb included)', () => {
    const { rerender } = wrap(
      <SalonboardRow
        a={appt(
          sb({
            state: 'synced',
            message: 'サロンボードに同じ時間の予定があります',
            synced_at: '2026-10-23T06:10:00Z',
          }),
        )}
        tz="Asia/Tokyo"
      />,
    );
    expect(screen.getByText('SB連携済')).toHaveAttribute(
      'title',
      'SB連携済（サロンボードに同じ時間の予定があります）',
    );
    expect(screen.getByText('2026/10/23 15:10')).toBeInTheDocument();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <SalonboardRow
          a={appt(sb({ state: 'error', message: '自動枠止め: 失敗しました' }))}
          tz="Asia/Tokyo"
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText('SBエラー')).toBeInTheDocument();
    expect(screen.getAllByText('自動枠止め: 失敗しました').length).toBeGreaterThan(0);
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <SalonboardRow a={appt(sb({ state: 'waiting' }))} tz="Asia/Tokyo" />
      </QueryClientProvider>,
    );
    expect(screen.getByText('SB連携待ち')).toBeInTheDocument();
  });

  it('labels the button by state and reports the request', async () => {
    const user = userEvent.setup();
    h.sync.mockResolvedValue({ salonboard: sb({ state: 'waiting' }) });
    const { unmount } = wrap(<SalonboardButton a={appt(sb({ state: 'synced' }))} />);
    await user.click(screen.getByRole('button', { name: 'サロンボードに再同期' }));
    await waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith(
        'サロンボード連携を受け付けました（10分以内に反映）',
      ),
    );
    expect(h.sync).toHaveBeenCalledWith('a1');
    unmount();

    h.sync.mockRejectedValue(new Error('サロンボード連携が有効になっていません'));
    wrap(<SalonboardButton a={appt(sb({ state: 'error' }))} />);
    await user.click(screen.getByRole('button', { name: 'サロンボード連携を再試行' }));
    await waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith(
        'サロンボード連携に失敗しました',
        'サロンボード連携が有効になっていません',
      ),
    );
  });

  it('offers no button for HPB bookings, unconfirmed ones or shops without SALON BOARD', () => {
    const { container } = wrap(
      <>
        <SalonboardButton a={appt(sb({ origin: 'hotpepper', state: 'synced' }))} />
        <SalonboardButton a={appt(sb(), { status: 'tentative' })} />
        <SalonboardButton a={appt(undefined)} />
        <SalonboardButton a={appt(sb({ origin: 'migrated', state: 'synced' }))} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
    wrap(<SalonboardButton a={appt(sb())} />);
    expect(screen.getByRole('button', { name: 'サロンボードに連携' })).toBeInTheDocument();
  });
});
