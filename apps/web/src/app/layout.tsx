import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { LangProvider } from '@/lib/i18n';
import './globals.css';

// Fonts are self-hosted (OFL, see src/fonts/LICENSE-*): no call to an outside font service at build time or when
// a page loads, so builds work offline and patients' browsers are not reported to a third party.
const display = localFont({ src: '../fonts/bricolage-grotesque-latin-wght-normal.woff2', variable: '--font-display', weight: '200 800', display: 'swap' });
const body = localFont({ src: '../fonts/instrument-sans-latin-wght-normal.woff2', variable: '--font-body', weight: '400 700', display: 'swap' });
const mono = localFont({
  src: [
    { path: '../fonts/ibm-plex-mono-latin-400-normal.woff2', weight: '400' },
    { path: '../fonts/ibm-plex-mono-latin-500-normal.woff2', weight: '500' },
    { path: '../fonts/ibm-plex-mono-latin-600-normal.woff2', weight: '600' },
  ],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = { title: 'Fahan', description: 'Hospital operating platform' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <LangProvider>{children}</LangProvider>
      </body>
    </html>
  );
}
