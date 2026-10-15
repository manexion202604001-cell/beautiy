import { describe, expect, it } from 'vitest';
import { consentSections } from './walkin';

describe('consentSections', () => {
  it('splits a consent body into titled sections with bullet items and free text', () => {
    const body = [
      '## 個人情報について',
      '- 施術以外の目的で利用しません',
      '・第三者に提供しません',
      '',
      '### まつ毛エクステ注意事項',
      '施術後 5 時間は濡らさないでください。',
      '異常を感じたらご連絡ください。',
    ].join('\n');
    expect(consentSections(body)).toEqual([
      { title: '個人情報について', items: ['施術以外の目的で利用しません', '第三者に提供しません'], content: '' },
      { title: 'まつ毛エクステ注意事項', items: [], content: '施術後 5 時間は濡らさないでください。\n異常を感じたらご連絡ください。' },
    ]);
  });

  it('keeps a body without headings as one untitled section and ignores an empty body', () => {
    expect(consentSections('ご来店前にご確認ください。')).toEqual([{ title: '', items: [], content: 'ご来店前にご確認ください。' }]);
    expect(consentSections('前文です\n## その他\n- 項目')).toEqual([
      { title: '', items: [], content: '前文です' },
      { title: 'その他', items: ['項目'], content: '' },
    ]);
    expect(consentSections('')).toEqual([]);
    expect(consentSections(null)).toEqual([]);
  });
});
