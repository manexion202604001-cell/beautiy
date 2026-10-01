import { useState } from 'react';
import { ROLE_LABEL, type ItemInput, type StaffRole } from '../../../api/pos';
import type { Staff } from '../../../api/types';
import { Alert, Button, Checkbox, Dialog, IconButton, Input, Select } from '../../../components/ui';
import { bpToPercentText, evenShares, percentTextToBp } from '../../../lib/money';

type Share = NonNullable<ItemInput['staff']>[number];

interface Row {
  staffId: string;
  percent: string;
  role: StaffRole;
  isNominated: boolean;
}

/** Per-line staff allocation editor (share % must total 100%) */
export function StaffShareDialog({
  lineName,
  value,
  staff,
  onClose,
  onSave,
}: {
  lineName: string;
  value: Share[];
  staff: Staff[];
  onClose: () => void;
  onSave: (shares: Share[]) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    value.length
      ? value.map((s) => ({
          staffId: s.staffId,
          percent: bpToPercentText(s.shareBp),
          role: s.role,
          isNominated: s.isNominated,
        }))
      : [{ staffId: staff[0]?.id ?? '', percent: '100', role: 'main', isNominated: false }],
  );
  const [error, setError] = useState<string | null>(null);
  const total = rows.reduce((s, r) => s + (percentTextToBp(r.percent) ?? 0), 0);
  const set = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const split = () => {
    const shares = evenShares(rows.length);
    setRows((rs) => rs.map((r, i) => ({ ...r, percent: bpToPercentText(shares[i]!) })));
  };

  const save = () => {
    if (!rows.length) {
      onSave([]);
      return;
    }
    const out: Share[] = [];
    for (const r of rows) {
      const bp = percentTextToBp(r.percent);
      if (!r.staffId) return setError('担当スタッフを選択してください');
      if (bp === null) return setError('配分は0〜100%で入力してください');
      out.push({ staffId: r.staffId, shareBp: bp, role: r.role, isNominated: r.isNominated });
    }
    if (out.reduce((s, x) => s + x.shareBp, 0) !== 10000)
      return setError('配分の合計を100%にしてください');
    const keys = new Set(out.map((s) => `${s.staffId}:${s.role}`));
    if (keys.size !== out.length) return setError('同じスタッフ・役割が重複しています');
    onSave(out);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="担当者配分"
      description={`${lineName} の売上を担当者に配分します（合計100%）`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={save}>
            適用する
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <ul className="space-y-3">
          {rows.map((r, i) => (
            <li
              key={i}
              className="grid grid-cols-[1fr_auto] gap-2 rounded-xl border border-border p-3 sm:grid-cols-[1.4fr_1fr_6rem_auto] sm:items-center"
            >
              <Select
                aria-label={`担当者${i + 1}`}
                value={r.staffId}
                onChange={(e) => set(i, { staffId: e.target.value })}
              >
                <option value="">スタッフを選択</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.display_name}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={`役割${i + 1}`}
                value={r.role}
                onChange={(e) => set(i, { role: e.target.value as StaffRole })}
                className="order-3 sm:order-none"
              >
                {(Object.keys(ROLE_LABEL) as StaffRole[]).map((k) => (
                  <option key={k} value={k}>
                    {ROLE_LABEL[k]}
                  </option>
                ))}
              </Select>
              <Input
                aria-label={`配分${i + 1}（%）`}
                value={r.percent}
                onChange={(e) => set(i, { percent: e.target.value })}
                inputMode="decimal"
                trailing="%"
                className="order-4 sm:order-none"
              />
              <IconButton
                icon="trash"
                label={`担当者${i + 1}を削除`}
                size="sm"
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              />
              <Checkbox
                className="order-5 col-span-2 sm:col-span-4"
                label="指名"
                checked={r.isNominated}
                onChange={(e) => set(i, { isNominated: e.target.checked })}
              />
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            icon="plus"
            onClick={() =>
              setRows((rs) => [
                ...rs,
                { staffId: '', percent: '0', role: 'assistant', isNominated: false },
              ])
            }
            disabled={rows.length >= 10}
          >
            担当者を追加
          </Button>
          <Button size="sm" variant="ghost" onClick={split} disabled={rows.length < 2}>
            均等に配分
          </Button>
          <span
            className={`ml-auto text-sm tabular ${total === 10000 ? 'text-success' : 'text-danger'}`}
            aria-live="polite"
          >
            合計 {bpToPercentText(total)}%
          </span>
        </div>
      </div>
    </Dialog>
  );
}
