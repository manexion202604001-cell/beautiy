export class EmailService {
  private apiKey: string;
  private fromAddress: string;

  constructor(apiKey: string, fromAddress: string = 'SALOGIC <noreply@example.com>') {
    this.apiKey = apiKey;
    this.fromAddress = fromAddress;
  }

  async sendVerificationEmail(to: string, name: string, token: string, verifyUrl: string): Promise<void> {
    const link = `${verifyUrl}?token=${encodeURIComponent(token)}`;

    await this.send({
      to,
      subject: '【SALOGIC】メールアドレスの確認',
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #333;">メールアドレスの確認</h2>
          <p>${name}さん、SALOGICへのご登録ありがとうございます。</p>
          <p>以下のボタンをクリックして、メールアドレスを確認してください。</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${link}" style="display: inline-block; padding: 12px 32px; background-color: #000; color: #fff; text-decoration: none; border-radius: 6px; font-weight: bold;">
              メールアドレスを確認
            </a>
          </div>
          <p style="color: #666; font-size: 14px;">ボタンが動作しない場合は、以下のURLをブラウザにコピーしてください：</p>
          <p style="color: #666; font-size: 12px; word-break: break-all;">${link}</p>
          <p style="color: #999; font-size: 12px; margin-top: 30px;">このリンクは24時間で有効期限が切れます。</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
          <p style="color: #999; font-size: 12px;">このメールに心当たりがない場合は、無視してください。</p>
        </div>
      `,
    });
  }

  async sendPasswordResetEmail(to: string, name: string, resetUrl: string): Promise<void> {
    await this.send({
      to,
      subject: '【SALOGIC】パスワードリセット',
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #333;">パスワードリセット</h2>
          <p>${name}さん、パスワードリセットのリクエストを受け付けました。</p>
          <p>以下のボタンをクリックして、新しいパスワードを設定してください。</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" style="display: inline-block; padding: 12px 32px; background-color: #000; color: #fff; text-decoration: none; border-radius: 6px; font-weight: bold;">
              パスワードをリセット
            </a>
          </div>
          <p style="color: #666; font-size: 14px;">ボタンが動作しない場合は、以下のURLをブラウザにコピーしてください：</p>
          <p style="color: #666; font-size: 12px; word-break: break-all;">${resetUrl}</p>
          <p style="color: #999; font-size: 12px; margin-top: 30px;">このリンクは1時間で有効期限が切れます。</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
          <p style="color: #999; font-size: 12px;">このメールに心当たりがない場合は、無視してください。パスワードは変更されません。</p>
        </div>
      `,
    });
  }

  private async send(params: { to: string; subject: string; html: string }): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: this.fromAddress,
        to: params.to,
        subject: params.subject,
        html: params.html,
      }),
    });

    const responseBody = await response.text();

    if (!response.ok) {
      console.error('Resend API error:', response.status, responseBody);
      throw new Error(`Failed to send email: ${response.status}`);
    }

    console.log('Resend API success:', response.status, 'to:', params.to, 'response:', responseBody);
  }
}
