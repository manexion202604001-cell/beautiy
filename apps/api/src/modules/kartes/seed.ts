import { randomUUID } from 'node:crypto';
import { registerOrgSeeder } from '../../lib/org-seeders.js';
import type { FormField, KarteField } from './schemas.js';

const LENGTHS = ['ベリーショート', 'ショート', 'ボブ', 'ミディアム', 'セミロング', 'ロング'];
const DAMAGE = ['1 (健康毛)', '2', '3', '4', '5 (ハイダメージ)'];
const CONCERNS = ['パサつき', '広がり', 'うねり・くせ', '白髪', 'ボリューム不足', 'ダメージ', '頭皮のかゆみ・乾燥', 'ツヤ不足'];

export const DEFAULT_KARTE_TEMPLATES: { name: string; category: string; isDefault?: boolean; fields: KarteField[] }[] = [
  {
    name: 'カット',
    category: 'cut',
    isDefault: true,
    fields: [
      { key: 'request', label: 'ご要望', type: 'textarea' },
      { key: 'length_before', label: '施術前の長さ', type: 'select', options: LENGTHS },
      { key: 'length_after', label: '仕上がりの長さ', type: 'select', options: LENGTHS, customerVisible: true },
      { key: 'style_name', label: 'スタイル', type: 'text', customerVisible: true },
      { key: 'hair_texture', label: '髪質', type: 'select', options: ['細い', '普通', '太い'] },
      { key: 'hair_volume', label: '毛量', type: 'select', options: ['少ない', '普通', '多い'] },
      { key: 'curl', label: 'くせ', type: 'select', options: ['なし', '弱い', '普通', '強い'] },
      {
        key: 'techniques',
        label: '技法',
        type: 'multiselect',
        options: ['レイヤー', 'グラデーション', 'ワンレングス', '前髪カット', 'すきバサミ', '刈り上げ'],
      },
      { key: 'styling_advice', label: 'スタイリングのポイント', type: 'textarea', customerVisible: true },
      { key: 'next_visit', label: '次回のおすすめ', type: 'text', customerVisible: true },
    ],
  },
  {
    name: 'カラー',
    category: 'color',
    fields: [
      { key: 'request', label: 'ご要望', type: 'textarea' },
      {
        key: 'color_type',
        label: '施術内容',
        type: 'select',
        options: ['ワンメイク', 'リタッチ', 'ハイライト', 'ブリーチ', 'ダブルカラー', '白髪染め'],
        required: true,
      },
      { key: 'current_level', label: '施術前の明るさ(レベル)', type: 'number', min: 1, max: 20 },
      { key: 'target_level', label: '仕上がりの明るさ(レベル)', type: 'number', min: 1, max: 20, customerVisible: true },
      { key: 'gray_ratio', label: '白髪の割合', type: 'select', options: ['なし', '1割未満', '1〜3割', '3〜5割', '5割以上'] },
      { key: 'formula', label: 'カラーレシピ', type: 'color_formula', helpText: '例: 根元 8N:7A=1:1 OX6% 30分 / 毛先 10Ash OX3% 20分' },
      { key: 'patch_test', label: 'パッチテスト', type: 'select', options: ['実施済み(異常なし)', '未実施', '異常あり'], required: true },
      { key: 'scalp_condition', label: '頭皮の状態', type: 'select', options: ['良好', '乾燥', '敏感', '炎症あり'] },
      { key: 'result_color', label: '仕上がりの色味', type: 'text', customerVisible: true },
      { key: 'aftercare', label: '色持ちのためのアドバイス', type: 'textarea', customerVisible: true },
    ],
  },
  {
    name: 'パーマ',
    category: 'perm',
    fields: [
      { key: 'request', label: 'ご要望', type: 'textarea' },
      {
        key: 'perm_type',
        label: '施術内容',
        type: 'select',
        options: ['コールドパーマ', 'デジタルパーマ', 'エアウェーブ', '縮毛矯正', 'ストレートパーマ'],
        required: true,
      },
      { key: 'damage_level', label: 'ダメージレベル', type: 'select', options: DAMAGE },
      { key: 'rods', label: 'ロッド(種類・本数)', type: 'text' },
      { key: 'winding', label: '巻き方', type: 'multiselect', options: ['平巻き', 'スパイラル', 'ピンパーマ', '根元パーマ', '毛先のみ'] },
      { key: 'processing', label: '放置時間・工程', type: 'textarea' },
      { key: 'curl_strength', label: '仕上がりのウェーブ', type: 'select', options: ['ゆるめ', '普通', 'しっかり'], customerVisible: true },
      { key: 'styling_advice', label: 'スタイリング・お手入れ方法', type: 'textarea', customerVisible: true },
    ],
  },
  {
    name: 'トリートメント',
    category: 'treatment',
    fields: [
      {
        key: 'treatment_type',
        label: 'メニュー',
        type: 'select',
        options: ['サロントリートメント', '酸熱トリートメント', '髪質改善', 'ヘッドスパ', 'システムトリートメント'],
        required: true,
      },
      { key: 'concerns', label: 'お悩み', type: 'multiselect', options: CONCERNS },
      { key: 'damage_level', label: 'ダメージレベル', type: 'select', options: DAMAGE },
      { key: 'steps', label: '施術工程', type: 'textarea' },
      { key: 'result', label: '仕上がり', type: 'textarea', customerVisible: true },
      { key: 'homecare_tip', label: 'おうちでのケア方法', type: 'textarea', customerVisible: true },
    ],
  },
];

const COLOR_CONSENT = `# カラー施術に関する同意書

ヘアカラー剤には、まれにかぶれ・かゆみ・発疹などのアレルギー反応を起こす成分(ジアミン等)が含まれています。
安全に施術を受けていただくため、以下の内容をご確認ください。

## ご確認事項

- 施術の48時間前までにパッチテスト(皮膚アレルギー試験)を行うことを推奨しています。
- 過去にヘアカラーでかぶれ・かゆみ等の症状が出たことがある方は施術をお受けできません。
- 頭皮に傷・湿疹・炎症がある場合、施術をお断りすることがあります。
- 施術中・施術後にかゆみ・痛み・腫れ等を感じた場合は、ただちにスタッフへお知らせください。
- 髪の状態や履歴により、仕上がりの色味・明るさがご希望と異なる場合があります。
- ブリーチ等の施術により、髪のダメージ・切れ毛が生じる場合があります。

上記の内容を理解したうえで、施術を受けることに同意します。`;

export const DEFAULT_FORM_TEMPLATES: {
  kind: 'counseling' | 'consent' | 'pre_visit';
  name: string;
  requiresSignature: boolean;
  bodyMarkdown: string | null;
  fields: FormField[];
}[] = [
  {
    kind: 'counseling',
    name: 'カウンセリングシート',
    requiresSignature: false,
    bodyMarkdown: null,
    fields: [
      {
        key: 'menus',
        label: '本日のご希望メニュー',
        type: 'multiselect',
        options: ['カット', 'カラー', 'パーマ', '縮毛矯正', 'トリートメント', 'ヘッドスパ'],
        required: true,
      },
      { key: 'hair_concerns', label: '髪のお悩み', type: 'multiselect', options: CONCERNS, mapsTo: 'hair_concerns' },
      { key: 'styling_time', label: '毎日のスタイリング時間', type: 'select', options: ['5分未満', '5〜15分', '15分以上'] },
      { key: 'recent_treatments', label: '最近の施術歴(カラー・パーマ・縮毛矯正など)', type: 'textarea' },
      { key: 'allergies', label: 'アレルギー・敏感肌など', type: 'textarea', mapsTo: 'allergies' },
      { key: 'avoid', label: '避けたいスタイル', type: 'textarea' },
      { key: 'request', label: 'ご要望', type: 'textarea' },
    ],
  },
  {
    kind: 'consent',
    name: 'カラー施術同意書',
    requiresSignature: true,
    bodyMarkdown: COLOR_CONSENT,
    fields: [
      { key: 'patch_test', label: 'パッチテスト', type: 'select', options: ['実施済み', '実施しない(リスクを理解した上で施術を希望)'], required: true },
      {
        key: 'past_reaction',
        label: '過去にヘアカラーでかぶれ・かゆみ等の症状が出たことがありますか',
        type: 'select',
        options: ['はい', 'いいえ'],
        required: true,
      },
      { key: 'scalp_trouble', label: '頭皮に傷・湿疹・炎症はありますか', type: 'select', options: ['はい', 'いいえ'], required: true },
      { key: 'pregnancy', label: '妊娠中・授乳中ですか', type: 'select', options: ['はい', 'いいえ', '回答しない'], mapsTo: 'pregnancy' },
      { key: 'agree', label: '上記の内容を理解し、施術に同意します', type: 'checkbox', required: true },
    ],
  },
  {
    kind: 'pre_visit',
    name: '事前アンケート',
    requiresSignature: false,
    bodyMarkdown: 'ご来店前にご記入いただくと、当日のカウンセリングがスムーズになります。',
    fields: [
      {
        key: 'visit_reason',
        label: 'ご来店のきっかけ',
        type: 'select',
        options: ['Instagram', 'ホットペッパービューティー', 'Google', 'ご友人の紹介', '通りがかり', 'その他'],
      },
      { key: 'hair_concerns', label: '髪のお悩み', type: 'multiselect', options: CONCERNS, mapsTo: 'hair_concerns' },
      { key: 'preferred_style', label: 'なりたいイメージ', type: 'textarea', mapsTo: 'preferred_style' },
      { key: 'allergies', label: 'アレルギー(カラー剤・金属など)', type: 'textarea', mapsTo: 'allergies' },
      { key: 'medical_notes', label: '体調・持病・服用中のお薬など', type: 'textarea', mapsTo: 'medical_notes' },
      { key: 'conversation', label: '施術中の会話', type: 'select', options: ['たくさん話したい', '適度に話したい', '静かに過ごしたい'] },
      { key: 'request', label: 'その他ご要望', type: 'textarea' },
    ],
  },
];

registerOrgSeeder(
  'kartes.templates',
  async (ctx, { organizationId }) => {
    await ctx.trx
      .insertInto('karte_templates')
      .values(
        DEFAULT_KARTE_TEMPLATES.map((t) => ({
          organization_id: organizationId,
          name: t.name,
          category: t.category,
          fields: JSON.stringify(t.fields),
          is_default: t.isDefault ?? false,
        })),
      )
      .execute();
    await ctx.trx
      .insertInto('form_templates')
      .values(
        DEFAULT_FORM_TEMPLATES.map((t) => {
          const id = randomUUID();
          return {
            id,
            lineage_id: id,
            organization_id: organizationId,
            kind: t.kind,
            name: t.name,
            fields: JSON.stringify(t.fields),
            body_markdown: t.bodyMarkdown,
            requires_signature: t.requiresSignature,
            status: 'active',
          };
        }),
      )
      .execute();
  },
  200,
);
