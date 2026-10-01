import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';
import { Field, Input } from './Field';
import { Tabs } from './Tabs';

describe('Field', () => {
  it('wires label, hint and error to the control', () => {
    render(
      <Field
        label="メールアドレス"
        hint="ログインに使います"
        error="形式が正しくありません"
        required
      >
        <Input />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'メールアドレス' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(input).toHaveAccessibleDescription('形式が正しくありません');
    expect(screen.getByRole('alert')).toHaveTextContent('形式が正しくありません');
  });
});

describe('Tabs', () => {
  function Harness() {
    const [v, setV] = useState<'a' | 'b' | 'c'>('a');
    return (
      <Tabs
        label="テスト"
        value={v}
        onChange={setV}
        items={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B', disabled: true },
          { value: 'c', label: 'C' },
        ]}
      />
    );
  }
  it('supports arrow-key navigation skipping disabled tabs', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const a = screen.getByRole('tab', { name: 'A' });
    expect(a).toHaveAttribute('aria-selected', 'true');
    a.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'C' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'C' })).toHaveFocus();
  });
});

describe('ConfirmDialog', () => {
  it('requires a reason when configured and passes it to onConfirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onClose={() => undefined}
        onConfirm={onConfirm}
        title="キャンセルしますか？"
        reason
        reasonRequired
        reasonLabel="キャンセル理由"
        confirmLabel="キャンセルする"
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'キャンセルしますか？' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const confirm = screen.getByRole('button', { name: 'キャンセルする' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: /キャンセル理由/ }), '体調不良');
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('体調不良');
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ConfirmDialog open onClose={onClose} onConfirm={() => undefined} title="確認" />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
