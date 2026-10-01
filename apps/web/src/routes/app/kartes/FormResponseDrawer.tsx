import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { openAuthenticatedHtml, sameOriginBlobUrl } from '../../../api/files';
import {
  FORM_KIND_LABEL,
  RESPONSE_STATUS_LABEL,
  formKeys,
  formsApi,
  type VerifyResult,
} from '../../../api/forms';
import { displayFieldValue } from '../../../api/kartes';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  ErrorState,
  InlineLoading,
  KeyValue,
  useToast,
} from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { formatDateTime } from '../../../lib/format';

const VIA_LABEL: Record<string, string> = {
  staff: '店頭（スタッフ）',
  customer_link: 'お客様のスマートフォン',
};

/** Submitted form detail: answers, signature, integrity verification, printable HTML, void */
export function FormResponseDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can, timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: formKeys.response(id ?? ''),
    queryFn: () => formsApi.response(id!),
    enabled: !!id,
  });
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const r = q.data;

  const runVerify = async () => {
    if (!r) return;
    setVerifying(true);
    try {
      setVerify(await formsApi.verify(r.id));
    } catch (e) {
      toast.error(e);
    } finally {
      setVerifying(false);
    }
  };

  const doVoid = async (reason?: string) => {
    if (!r || !reason) return;
    try {
      await formsApi.voidResponse(r.id, reason);
      toast.success('書類を無効化しました');
      void qc.invalidateQueries({ queryKey: formKeys.all });
    } catch (e) {
      toast.error(e);
    } finally {
      setVoiding(false);
    }
  };

  return (
    <Drawer
      open={!!id}
      onClose={() => {
        setVerify(null);
        onClose();
      }}
      width="lg"
      title={r ? r.template_snapshot.name : '書類'}
      description={
        r ? (
          <span className="flex flex-wrap items-center gap-2">
            <Badge size="sm">{FORM_KIND_LABEL[r.template_snapshot.kind]}</Badge>
            <Badge
              size="sm"
              tone={
                r.status === 'submitted' ? 'success' : r.status === 'voided' ? 'neutral' : 'warning'
              }
            >
              {RESPONSE_STATUS_LABEL[r.status]}
            </Badge>
            <span>v{r.template_version}</span>
          </span>
        ) : undefined
      }
      footer={
        r && r.status !== 'pending' ? (
          <>
            {can('form.manage') && r.status === 'submitted' ? (
              <Button
                variant="ghost"
                className="!text-danger mr-auto"
                onClick={() => setVoiding(true)}
              >
                無効化
              </Button>
            ) : null}
            <Button icon="shield" loading={verifying} onClick={() => void runVerify()}>
              改ざん検証
            </Button>
            <Button
              variant="primary"
              icon="external"
              onClick={() =>
                void openAuthenticatedHtml(
                  `/form-responses/${r.id}/html`,
                  r.template_snapshot.name,
                ).catch((e) => toast.error(e))
              }
            >
              印刷用を開く
            </Button>
          </>
        ) : undefined
      }
    >
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} /> : null}
      {r ? (
        <div className="space-y-5">
          {r.status === 'voided' ? (
            <Alert tone="warning" title="この書類は無効化されています">
              {r.void_reason} （{formatDateTime(r.voided_at, tz)}）
            </Alert>
          ) : null}
          {r.status === 'pending' ? <Alert tone="info">お客様の回答待ちです。</Alert> : null}
          {verify ? (
            <Alert
              tone={verify.valid ? 'success' : 'danger'}
              title={verify.valid ? '改ざんは検出されませんでした' : '改ざんの可能性があります'}
            >
              文書ハッシュ {verify.hashMatches ? '一致' : '不一致'} ・ 署名{' '}
              {verify.signature.present ? (verify.signature.intact ? '正常' : '不一致') : 'なし'}
              <span className="mt-1 block break-all font-mono text-[11px] text-muted">
                {verify.documentHash}
              </span>
            </Alert>
          ) : null}
          <KeyValue
            items={[
              { label: '提出日時', value: formatDateTime(r.submitted_at, tz) },
              {
                label: '提出方法',
                value: r.submitted_via ? (VIA_LABEL[r.submitted_via] ?? r.submitted_via) : '—',
              },
              { label: '署名者', value: r.signer_name ?? '—' },
              {
                label: '文書ハッシュ',
                value: (
                  <span className="break-all font-mono text-[11px]">{r.document_hash ?? '—'}</span>
                ),
              },
            ]}
          />
          {r.template_snapshot.bodyMarkdown ? (
            <details className="rounded-xl border border-border p-3 text-[13px]">
              <summary className="cursor-pointer font-medium">同意事項（提出時の版）</summary>
              <p className="mt-2 whitespace-pre-wrap leading-relaxed text-muted">
                {r.template_snapshot.bodyMarkdown}
              </p>
            </details>
          ) : null}
          <section>
            <h3 className="mb-2 text-[13px] font-semibold">回答</h3>
            <KeyValue
              items={r.template_snapshot.fields.map((f) => ({
                label: f.label,
                value: displayFieldValue(r.answers?.[f.key]),
              }))}
            />
          </section>
          {r.signature ? (
            <section>
              <h3 className="mb-2 text-[13px] font-semibold">署名</h3>
              <img
                src={sameOriginBlobUrl(r.signature.url)}
                alt={`${r.signer_name ?? ''}の署名`}
                className="max-h-40 rounded-xl border border-border bg-white"
              />
            </section>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={voiding}
        onClose={() => setVoiding(false)}
        title="書類を無効化しますか？"
        description="提出済みの書類は変更できません。誤りがある場合は無効化して再提出してください。"
        tone="danger"
        confirmLabel="無効化する"
        reason
        reasonRequired
        reasonLabel="無効化の理由"
        onConfirm={(reason) => void doVoid(reason)}
      />
    </Drawer>
  );
}
