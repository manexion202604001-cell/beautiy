import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appointmentsApi } from '../../../api/appointments';
import { customersApi } from '../../../api/customers';
import { formsApi, type FormResponseDetail, type FormResponseListItem } from '../../../api/forms';
import type { AppointmentDetail, CustomerDetail } from '../../../api/types';
import { ToastProvider } from '../../../components/ui';
import ReservationDetail from './ReservationDetail';

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ can: () => true, currentShopId: 'shop-1', timezone: 'Asia/Tokyo' }),
}));

const appt = (over: Partial<AppointmentDetail> = {}): AppointmentDetail =>
  ({
    id: 'a1',
    shop_id: 'shop-1',
    customer_id: 'c1',
    staff_id: 'staff-1',
    is_nominated: true,
    booking_reference: 'R1',
    start_at: '2026-10-13T01:00:00.000Z',
    end_at: '2026-10-13T02:00:00.000Z',
    occupied_start_at: '2026-10-13T01:00:00.000Z',
    occupied_end_at: '2026-10-13T02:00:00.000Z',
    status: 'confirmed',
    source: 'staff',
    source_detail: {},
    estimated_total: 5500,
    version: 1,
    customer_name: '山田 花子',
    customer_last_name_kana: 'ヤマダ',
    customer_first_name_kana: 'ハナコ',
    customer_phone: '090-1111-2222',
    customer_visit_count: 2,
    is_new_customer: false,
    staff_name: '佐藤',
    services: [],
    resources: [],
    media_sync: { origin: null, blocks: [] },
    has_consent: true,
    ...over,
  }) as unknown as AppointmentDetail;

function mount(a: AppointmentDetail) {
  vi.spyOn(appointmentsApi, 'get').mockResolvedValue(a);
  vi.spyOn(formsApi, 'templates').mockResolvedValue([]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/app/calendar/a1']}>
          <Routes>
            <Route path="/app/calendar/:id" element={<ReservationDetail />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => vi.restoreAllMocks());

describe('予約詳細', () => {
  it('shows the menu text of a booking without menu rows', async () => {
    mount(appt({ source_detail: { menuName: 'カット＋カラー（SB）' } }));
    expect(await screen.findByText('カット＋カラー（SB）')).toBeInTheDocument();
    expect(screen.getByText('指名')).toBeInTheDocument();
  });

  it('opens the signed consent with the customer details, the consent text and when it was agreed', async () => {
    vi.spyOn(formsApi, 'responses').mockResolvedValue({
      items: [
        {
          id: 'r1',
          appointment_id: 'a1',
          status: 'submitted',
          submitted_at: '2026-10-13T00:30:00.000Z',
        } as FormResponseListItem,
      ],
      nextCursor: null,
    });
    vi.spyOn(formsApi, 'response').mockResolvedValue({
      id: 'r1',
      answers: { walkin_occupation: '会社員' },
      submitted_at: '2026-10-13T00:30:00.000Z',
      signed_at: null,
      template_snapshot: { bodyMarkdown: '## 個人情報について\n施術以外の目的で利用しません' },
    } as unknown as FormResponseDetail);
    vi.spyOn(customersApi, 'get').mockResolvedValue({
      id: 'c1',
      last_name_kana: 'ヤマダ',
      first_name_kana: 'ハナコ',
      birthday: '1990-04-01',
      phone: '090-1111-2222',
      occupation: null,
      acquisition_source: 'Instagram',
    } as unknown as CustomerDetail);
    const user = mount(appt());

    await user.click(await screen.findByText('同意済み'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('個人情報について')).toBeInTheDocument();
    expect(within(dialog).getByText('施術以外の目的で利用しません')).toBeInTheDocument();
    expect(within(dialog).getByText('山田 花子')).toBeInTheDocument();
    expect(within(dialog).getByText('ヤマダ ハナコ')).toBeInTheDocument();
    expect(await within(dialog).findByText('1990-04-01')).toBeInTheDocument();
    expect(within(dialog).getByText('090-1111-2222')).toBeInTheDocument();
    expect(within(dialog).getByText('会社員')).toBeInTheDocument();
    expect(within(dialog).getByText('Instagram')).toBeInTheDocument();
    expect(within(dialog).getByText('同意日時: 2026年10月13日 09:30')).toBeInTheDocument();
  });
});
