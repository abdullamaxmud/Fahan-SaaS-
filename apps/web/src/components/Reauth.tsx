'use client';

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { ErrorNote, useAction } from './ui';

/**
 * Wraps a sensitive call. If the API answers REAUTH_REQUIRED, asks for an authenticator code,
 * confirms it, then retries the original call once.
 */
export function useReauth() {
  const [pending, setPending] = useState<null | { retry: () => Promise<void>; reject: (e: unknown) => void }>(null);

  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'REAUTH_REQUIRED') throw e;
      return new Promise<T>((resolve, reject) => {
        setPending({
          retry: async () => resolve(await fn()),
          reject,
        });
      });
    }
  }

  const dialog = pending ? (
    <ReauthDialog
      onDone={async () => {
        const p = pending;
        setPending(null);
        await p.retry().catch(p.reject);
      }}
      onCancel={() => {
        pending.reject(new ApiError(401, { code: 'REAUTH_CANCELLED', message: 'Change cancelled. Nothing was saved' }));
        setPending(null);
      }}
    />
  ) : null;

  return { guarded, dialog };
}

function ReauthDialog({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const { busy, error, run } = useAction();
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="reauth-t" className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4">
      <form
        className="card w-full max-w-sm p-5 shadow-xl"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await run(() => api('/auth/reauth', { body: { code } }));
          if (ok !== undefined) onDone();
        }}
      >
        <div className="mb-3 flex items-center gap-2 text-accent-2">
          <ShieldCheck size={20} />
          <h2 id="reauth-t" className="text-lg font-bold text-ink">
            Confirm it's you
          </h2>
        </div>
        <p className="mb-3 text-[13px] text-ink-2">This change affects access or security. Enter the 6-digit code from your authenticator app.</p>
        <input
          autoFocus
          className="input mb-3 text-center font-mono text-lg tracking-[0.4em]"
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          aria-label="Authenticator code"
        />
        <ErrorNote error={error} />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || code.length !== 6}>
            Confirm
          </button>
        </div>
      </form>
    </div>
  );
}
