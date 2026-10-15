import { describe, expect, it } from 'vitest';
import { mailPlainText } from './MailTools';

describe('mailPlainText', () => {
  it('prefers the text part', () => {
    expect(mailPlainText({ text: '本文', html: '<p>HTML</p>' })).toBe('本文');
  });

  it('reduces HTML to text and keeps link targets visible', () => {
    const html =
      '<style>p{}</style><p>下記から認証してください</p><a href="https://salonboard.com/x?k=1&amp;b=2">こちら</a><script>alert(1)</script>';
    const t = mailPlainText({ text: null, html });
    expect(t).toContain('下記から認証してください');
    expect(t).toContain('こちら ( https://salonboard.com/x?k=1&b=2 )');
    expect(t).not.toContain('alert');
    expect(t).not.toContain('<');
  });

  it('is empty when the mail has no body', () => {
    expect(mailPlainText({ text: null, html: null })).toBe('');
  });
});
