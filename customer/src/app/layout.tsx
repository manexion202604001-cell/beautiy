import type { Metadata, Viewport } from "next";
import { Montserrat } from "next/font/google";
import "./globals.css";

const montserrat = Montserrat({
  subsets: ["latin"],
  weight: ["200", "700"],
  variable: "--font-montserrat",
});

export const metadata: Metadata = {
  title: "SALOGIC",
  description: "SALOGIC - サロン予約・マイページ",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "SALOGIC",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#b8936a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" className={montserrat.variable}>
      <body className="min-h-screen bg-background antialiased">
        {children}
      </body>
    </html>
  );
}
