import { Plus, FileText } from 'lucide-react';
import { prisma } from '@/lib/server/db';
import { requirePage } from '@/lib/server/session';
import { Card, Empty, PageHeader } from '@/components/ui';
import { ConfirmAction } from '@/components/client';
import { KarteTabs } from '../_components/KarteTabs';
import { TemplateButton } from '../_components/TemplateForm';
import { deleteTemplateAction } from '../actions';

export const metadata = { title: 'カルテテンプレート' };

export default async function TemplatesPage() {
  const ctx = await requirePage('karte.read');
  const canEdit = ctx.can('karte.write');
  const templates = await prisma.karteTemplate.findMany({ where: { organizationId: ctx.org.id }, orderBy: { name: 'asc' } });
  return (
    <>
      <PageHeader title="カルテ" sub="よく使う施術内容・薬剤レシピ・ケアメモをテンプレートにしておくと、カルテ入力が速くなります。" actions={canEdit ? <TemplateButton label={<><Plus size={16} />テンプレート作成</>} /> : undefined} />
      <KarteTabs active="templates" />
      {templates.length === 0 ? (
        <Card><Empty title="テンプレートはまだありません" icon={<FileText size={20} />} action={canEdit ? <TemplateButton label="最初のテンプレートを作成" className="btn sm" /> : undefined}>例: 「カラー（リタッチ）」「縮毛矯正」「メンズカット」など</Empty></Card>
      ) : (
        <div className="grid-3 kt-templates">
          {templates.map((t) => (
            <Card key={t.id} title={t.name} actions={canEdit ? <>
              <TemplateButton label="編集" className="btn ghost sm" template={{ id: t.id, name: t.name, treatmentNote: t.treatmentNote ?? '', formulaNote: t.formulaNote ?? '', careMemo: t.careMemo ?? '' }} />
              <ConfirmAction action={deleteTemplateAction} fields={{ id: t.id }} confirm={`テンプレート「${t.name}」を削除しますか？`} className="btn ghost sm">削除</ConfirmAction>
            </> : undefined}>
              <dl className="kt-tpl">
                {t.treatmentNote && <><dt>施術内容</dt><dd>{t.treatmentNote}</dd></>}
                {t.formulaNote && <><dt>薬剤・レシピ</dt><dd className="mono">{t.formulaNote}</dd></>}
                {t.careMemo && <><dt>ケアメモ</dt><dd>{t.careMemo}</dd></>}
                {!t.treatmentNote && !t.formulaNote && !t.careMemo && <dd className="sub">（内容なし）</dd>}
              </dl>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
