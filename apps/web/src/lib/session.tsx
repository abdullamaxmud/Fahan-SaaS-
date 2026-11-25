'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Level, ModuleKey, Permissions, Scope } from '@fahan/policy';
import { levelRank } from '@fahan/policy';
import { ApiError, api } from './api';

export interface Me {
  id: string;
  kind: 'platform' | 'tenant';
  name: string;
  email: string;
  roles: string[];
  perms: Permissions;
  scope: Scope;
  branchId: string | null;
  tenant: { id: string; slug: string; name: string } | null;
  mfa: 'ok' | 'pending' | 'enroll';
}

const Ctx = createContext<{ me: Me; refresh: () => Promise<void> } | null>(null);

/** Loads the signed-in user; sends them to sign-in or MFA when the API says so. */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>('/auth/me');
      if (m.mfa !== 'ok') return router.replace('/mfa');
      setMe(m);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace('/login');
      else throw e;
    }
  }, [router]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!me) {
    return <div className="grid min-h-screen place-items-center text-ink-3">Loading your workspace…</div>;
  }
  return <Ctx.Provider value={{ me, refresh }}>{children}</Ctx.Provider>;
}

export function useMe() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useMe outside SessionProvider');
  return c;
}

/** UI hint only — the API enforces the real decision on every request. */
export const canDo = (me: Me, m: ModuleKey, l: Level) => levelRank(me.perms[m]) >= levelRank(l);
