import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { customersApi } from '../../../api/customers';
import { walkinApi, type WalkinIntakeDetail, type WalkinIntakeListItem } from '../../../api/walkin';
import { ToastProvider } from '../../../components/ui';
import Consents from './Consents';

vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    can: (p: string) => p !== 'staff.read',
    currentShopId: 'shop-1',
    timezone: 'Asia/Tokyo',
    me: { staff: { id: 'staff-1', display_name: '佐藤' } },
  }),
}));

const row: WalkinIntakeListItem = {
  id: 'w1',
  shop_id: 'shop-1',
  status: 'pending',
  customer_id: null,
  customer_name: '来店 花子',
  customer_name_kana: 'ライテン ハナコ',
  customer_phone: '090-1111-2222',
  customer_birthday: '1990-04-12',
  staff_id: 'staff-1',
  staff_name: '佐藤',
  has_counseling: true,
  consent_submitted_at: '2026-10-13T03:00:00.000Z',
};

const detail: WalkinIntakeDetail = {
  ...row,
  customer_occupation: '会社員',
  customer_visit_reason: 'Instagram',
  consent_snapshot: {
    title: '施術同意書',
    version: 1,
    body_markdown: '## 個人情報について\n- 施術以外の目的で利用しません\n\n## その他\n体調がすぐれない場合はお申し出ください。',
    fields: [{ key: 'patch_test', label: 'パッチテスト', type: 'select', options: ['実施済み'] }],
    answers: { patch_test: '実施済み', walkin_agreed: true },
    agreed_at: '2026-10-13T03:00:00.000Z',
    signer_name: null,
    document_hash: 'abc',
    signature: null,
  },
  counseling_data: {
    eye_counseling: { allergies: ['花粉', '金属'], questions: '', eye_condition: 'はい', eye_condition_area: '右目' },
    hair: { hair_volume: '75' },
  },
  counseling_submitted_at: '2026-10-13T03:05:00.000Z',
};

function mount(items: WalkinIntakeListItem[] = [row, { ...row, id: 'w2', customer_name: '別 次郎', customer_name_kana: '', has_counseling: false, staff_name: null }]) {
  vi.spyOn(walkinApi, 'list').mockResolvedValue({ items, nextCursor: null });
  vi.spyOn(walkinApi, 'get').mockResolvedValue({ intake: detail });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/app/consents']}>
          <Consents />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Consents (同意書一覧・受付保留)', () => {
  it('lists pending intakes and shows the consent and counselling in the detail dialog', async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.getByRole('heading', { name: '同意書一覧（受付保留）' })).toBeInTheDocument();
    expect(await screen.findByText('来店 花子')).toBeInTheDocument();
    expect(screen.getByText('(ライテン ハナコ)')).toBeInTheDocument();
    expect(screen.getByText('カウンセリング済')).toBeInTheDocument();
    expect(screen.getByText('同意書のみ')).toBeInTheDocument();
    expect(screen.getByText('担当: 佐藤')).toBeInTheDocument();
    expect(walkinApi.list).toHaveBeenCalledWith({ shopId: 'shop-1', q: undefined, cursor: undefined });

    await user.click(screen.getByText('来店 花子'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('ふりがな: ライテン ハナコ')).toBeInTheDocument();
    expect(within(dialog).getByText('電話: 090-1111-2222')).toBeInTheDocument();
    expect(within(dialog).getByText('生年月日: 1990-04-12')).toBeInTheDocument();
    expect(within(dialog).getByText('ご職業: 会社員')).toBeInTheDocument();
    expect(within(dialog).getByText('施術同意書')).toBeInTheDocument();
    expect(within(dialog).getByText('個人情報について')).toBeInTheDocument();
    expect(within(dialog).getByText('施術以外の目的で利用しません')).toBeInTheDocument();
    expect(within(dialog).getByText('体調がすぐれない場合はお申し出ください。')).toBeInTheDocument();
    expect(within(dialog).getByText('パッチテスト:')).toBeInTheDocument();
    expect(within(dialog).getByText(/^同意日時: /)).toBeInTheDocument();
    expect(within(dialog).getByText('カウンセリング内容')).toBeInTheDocument();
    expect(within(dialog).getByText('目')).toBeInTheDocument();
    expect(within(dialog).getByText('アレルギーについて:')).toBeInTheDocument();
    expect(within(dialog).getByText('花粉、金属')).toBeInTheDocument();
    // follow-up inputs and slider answers
    expect(within(dialog).getByText('箇所:')).toBeInTheDocument();
    expect(within(dialog).getByText('右目')).toBeInTheDocument();
    expect(within(dialog).getByText('毛量:')).toBeInTheDocument();
    expect(within(dialog).getByText('（0: 少ない 〜 100: 多い）')).toBeInTheDocument();
    // unanswered questions and categories are left out
    expect(within(dialog).queryByText('ご不明な点、ご質問はございますか？:')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('ネイル')).not.toBeInTheDocument();
  });

  it('registers a new customer, links to an existing one and discards', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const create = vi.spyOn(walkinApi, 'create').mockResolvedValue({ ok: true, intakeId: 'w1', customerId: 'c9', consentResponseId: 'r1', counselingCategories: [] });
    const link = vi.spyOn(walkinApi, 'link').mockResolvedValue({ ok: true, intakeId: 'w1', customerId: 'c1', consentResponseId: 'r1', counselingCategories: [], filled: [] });
    const discard = vi.spyOn(walkinApi, 'discard').mockResolvedValue({ ok: true, intakeId: 'w1' });
    const search = vi.spyOn(customersApi, 'search').mockResolvedValue({
      items: [{ id: 'c1', display_name: '来店 花子', customer_number: 'A-001', last_name_kana: 'ライテン', first_name_kana: 'ハナコ', phone: '090-1111-2222' }],
      nextCursor: null,
      total: 1,
    } as unknown as Awaited<ReturnType<typeof customersApi.search>>);
    mount([row]);

    // 新規顧客として登録
    await user.click(await screen.findByText('来店 花子'));
    await user.click(await screen.findByRole('button', { name: '新規顧客として登録' }));
    expect(confirm).toHaveBeenLastCalledWith('「来店 花子」を新規顧客として登録しますか？');
    await waitFor(() => expect(create).toHaveBeenCalledWith('w1'));
    expect(await screen.findByText('新規顧客として登録しました')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // 既存の顧客に紐付け: the search starts from the name the customer typed
    await user.click(screen.getByText('来店 花子'));
    await user.click(await screen.findByRole('button', { name: '既存の顧客に紐付け' }));
    expect(await screen.findByPlaceholderText('顧客名で検索')).toHaveValue('来店 花子');
    await waitFor(() => expect(search).toHaveBeenCalledWith({ q: '来店 花子', limit: 20 }));
    await user.click(await screen.findByText('A-001'));
    await waitFor(() => expect(link).toHaveBeenCalledWith('w1', 'c1'));
    expect(await screen.findByText('既存顧客に紐付けました')).toBeInTheDocument();

    // 破棄
    await user.click(screen.getByText('来店 花子'));
    await user.click(await screen.findByRole('button', { name: '破棄' }));
    expect(confirm).toHaveBeenLastCalledWith('「来店 花子」の受付を破棄しますか？');
    await waitFor(() => expect(discard).toHaveBeenCalledWith('w1'));
  });

  it('shows the empty state and the reception QR of the shop', async () => {
    const user = userEvent.setup();
    vi.spyOn(walkinApi, 'receptionLink').mockResolvedValue({
      url: 'https://app.example.com/consent/honten',
      shop: { id: 'shop-1', name: '本店', slug: 'honten', open: true },
      staff: null,
      consentForms: [{ lineageId: 'l1', templateId: 't1', name: '施術同意書', version: 1, url: 'https://app.example.com/consent/honten?form=l1' }],
    });
    mount([]);
    expect(await screen.findByText('保留中の受付はありません')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '受付QRコード' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('本店')).toBeInTheDocument();
    expect(await within(dialog).findByRole('img', { name: '受付QRコード' })).toBeInTheDocument();
    expect(walkinApi.receptionLink).toHaveBeenCalledWith({ shopId: 'shop-1', staffId: undefined });
    expect(within(dialog).getByRole('button', { name: '印刷' })).toBeEnabled();
  });
});
