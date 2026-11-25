export function Brand({ sub }: { sub?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid h-[34px] w-[34px] place-items-center rounded-[10px] bg-accent text-on-accent" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12h4l2-5 3 10 3-8 2 3h6" />
        </svg>
      </div>
      <div>
        <b className="font-display text-[19px] font-extrabold tracking-tight">Fahan</b>
        {sub ? <small className="-mt-0.5 block text-[11px] text-ink-3">{sub}</small> : null}
      </div>
    </div>
  );
}
