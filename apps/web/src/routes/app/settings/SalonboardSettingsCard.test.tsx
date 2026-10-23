import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SalonboardSettingsCard } from './SalonboardSettingsCard';

const h = vi.hoisted(() => ({
  can: (_p: string) => true as boolean,
  integrations: [] as unknown[],
  agents: [] as unknown[],
  update: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../lib/auth', () => ({ useAuth: () => ({ can: (p: string) => h.can(p) }) }));
vi.mock('../../../components/ui', () => ({ useToast: () => h.toast }));
vi.mock('../../../api/integrations', () => ({
  integrationKeys: { all: ['integrations'] },
  integrationsApi: { update: h.update },
  useIntegrations: () => ({ data: h.integrations, isLoading: false }),
  useSyncAgents: () => ({ data: { data: h.agents } }),
}));

const hp = (over: Record<string, unknown> = {}) => ({
  id: 'hp-1',
  shop_id: 'shop-1',
  provider: 'hotpepper_mail',
  status: 'active',
  config: { staffMap: {}, menuMap: {}, conflictPolicy: 'manual', pushBlocks: false, mail: {} },
  ...over,
});

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SalonboardSettingsCard shopId="shop-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.can = () => true;
  h.integrations = [hp()];
  h.agents = [];
});

describe('店舗設定 › サロンボード', () => {
  it('shows the SALOGIC card and points to 外部連携 when the shop has no SALON BOARD connector', () => {
    h.integrations = [];
    renderCard();
    expect(screen.getByText('サロンボード連携設定')).toBeInTheDocument();
    expect(screen.getByText('注意')).toBeInTheDocument();
    expect(screen.getByText(/自己責任でお願いします/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '外部連携' })).toHaveAttribute(
      'href',
      '/app/integrations',
    );
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('turns slot blocking by the helper on and keeps the HPB mail address', async () => {
    const user = userEvent.setup();
    h.update.mockResolvedValue(
      hp({ config: { ...hp().config, mail: { forwardAddress: 'a+b@example.com' } } }),
    );
    renderCard();
    expect(screen.getByText(/自動枠止め（Chrome）がまだ設定されていません/)).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'サロンボード連携を有効にする' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    await user.type(screen.getByLabelText('HPBメール受信アドレス'), ' a+b@example.com ');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(h.update).toHaveBeenCalledWith('hp-1', {
        config: {
          pushBlocks: true,
          mail: { agentManaged: true, forwardAddress: 'a+b@example.com' },
        },
      }),
    );
    expect(h.toast.success).toHaveBeenCalledWith('サロンボード連携設定を保存しました');
  });

  it('shows the address read-only with copy, and the helper login state', () => {
    h.integrations = [
      hp({
        config: {
          ...hp().config,
          pushBlocks: true,
          mail: { agentManaged: true, forwardAddress: 'salon.yoyaku+shop@example.com' },
        },
      }),
    ];
    h.agents = [
      {
        id: 'ag-1',
        shop_id: 'shop-1',
        name: 'Mac',
        last_seen_at: new Date().toISOString(),
        last_report: {
          status: { hotpepper_mail: { ok: false, message: 'ログインが切れています' } },
        },
      },
    ];
    renderCard();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    const address = screen.getByLabelText('HPBメール受信アドレス');
    expect(address).toHaveValue('salon.yoyaku+shop@example.com');
    expect(address).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'コピー' })).toBeInTheDocument();
    expect(screen.getByText('Mac: 最終実行 たった今')).toBeInTheDocument();
    expect(screen.getByText('サロンボード: ログインが切れています')).toBeInTheDocument();
  });

  it('needs the 外部連携 permission', () => {
    h.can = (p) => p !== 'integration.manage';
    renderCard();
    expect(screen.getByText(/「外部連携」の権限が必要です/)).toBeInTheDocument();
  });
});
