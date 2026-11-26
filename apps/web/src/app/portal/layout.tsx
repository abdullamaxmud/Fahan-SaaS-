'use client';

import { PortalShell } from '@/components/PortalShell';
import { SessionProvider } from '@/lib/session';

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider portal>
      <PortalShell>{children}</PortalShell>
    </SessionProvider>
  );
}
