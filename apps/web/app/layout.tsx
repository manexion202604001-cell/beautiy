import './globals.css';
import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: { default: 'MANEXION Salon OS', template: '%s | MANEXION Salon OS' },
  description: '美容サロンの顧客・予約・カルテ・会計・再来店をひとつの顧客IDでつなぐ業務OS',
  manifest: '/manifest.webmanifest',
  applicationName: 'MANEXION Salon OS',
};

export const viewport: Viewport = { themeColor: '#0b1428', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
