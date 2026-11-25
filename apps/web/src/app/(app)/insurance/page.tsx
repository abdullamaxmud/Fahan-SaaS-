'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileCheck2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { money, patientName, toMinor } from '@/lib/money';
import { canDo, useMe } from '@/lib/session';
import { Card, ErrorNote, Field, PageHeader, Pill, fieldErrors, useAction } from '@/components/ui';

interface Payer { id: string; code: string; name: string; kind: string; currency: string }
interface Policy { id: string; payerName: string; memberNumber: string; coveragePercent: number; validFrom: string; validTo: string; active: boolean }
interface Invoice { id: string; invoiceNumber: string; patientId: string; patient: { names?: { given?: string; family?: string }; mrn?: string } | null; currency: string; totalMinor: number; patientDueMinor: number; insuranceHoldMinor: number }
interface Claim { id: string; claimNumber: string; status: string; invoiceNumber: string; payerName: string; memberNumber: string; currency: string; claimedMinor: number; approvedMinor: number | null; remittedMinor: number; writtenOffMinor: number; denialCode: string | null; submittedOn: string | null }

const DENIALS = ['not-covered', 'policy-inactive', 'missing-documents', 'pre-authorisation-missing', 'duplicate-claim', 'limit-exceeded', 'coding-error', 'other'];
const tone = (s: string) => (s === 'Settled' ? 'ok' : s === 'Rejected' ? 'crit' : s === 'Accepted' ? 'info' : s === 'Submitted' ? 'warn' : 'plain');

export default function InsurancePage() {
  const { me } = useMe();
  const { t } = useLang();
  const [payers, setPayers] = useState<Payer[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [inv, setInv] = useState<Invoice | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [denials, setDenials] = useState<{ denialCode: string; claims: number; deniedMinor: number }[]>([]);
  const [ageing, setAgeing] = useState<Record<string, number>>({});
  const [payer, setPayer] = useState({ code: '', name: '', kind: 'insurer', currency: 'USD' });
  const [pol, setPol] = useState({ payerId: '', memberNumber: '', coveragePercent: '80', validFrom: '', validTo: '' });
  const [resp, setResp] = useState<Record<string, { approved: string; denialCode: string; note: string; remit: string; ref: string; short: string }>>({});
  const load = useAction();
  const act = useAction();
  const editor = canDo(me, 'ins', 'E');
  const specialist = canDo(me, 'ins', 'S');

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const [p, c, a, b, d, g] = await Promise.all([
        api<Payer[]>('/insurance/payers'),
        api<Claim[]>('/insurance/claims'),
        api<Invoice[]>('/billing/invoices?status=Issued'),
        api<Invoice[]>('/billing/invoices?status=PartiallyPaid'),
        api<typeof denials>('/insurance/reports/denials'),
        api<{ buckets: Record<string, number> }>('/insurance/reports/ageing'),
      ]);
      setPayers(p);
      setClaims(c);
      setInvoices([...a, ...b].filter((i) => i.patientDueMinor > 0));
      setDenials(d);
      setAgeing(g.buckets);
    });
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (inv) void load.run(async () => setPolicies(await api<Policy[]>(`/insurance/policies?patientId=${inv.patientId}`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inv]);

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    const out = await act.run(fn);
    if (out !== undefined) {
      after?.();
      await refresh();
      if (inv) setPolicies(await api<Policy[]>(`/insurance/policies?patientId=${inv.patientId}`));
    }
  };
  const fe = fieldErrors(act.error);
  const r = (id: string) => resp[id] ?? { approved: '', denialCode: 'not-covered', note: '', remit: '', ref: '', short: '' };
  const setR = (id: string, patch: Partial<ReturnType<typeof r>>) => setResp({ ...resp, [id]: { ...r(id), ...patch } });

  return (
    <>
      <PageHeader eyebrow="Spec §5.20" title={t('Insurance & claims', 'Caymiska & sheegashooyinka')}>
        {t(
          'A submitted claim moves the insurer’s share off the patient’s bill. Whatever the payer will not pay goes back to the patient; a short payment is written off with a reason.',
          'Sheegasho la gudbiyay waxay qaybta caymiska ka saartaa biilka bukaanka.',
        )}
      </PageHeader>
      <ErrorNote error={load.error ?? (Object.keys(fe).length ? null : act.error)} />

      <div className="grid gap-4 md:grid-cols-4">
        {Object.entries(ageing).map(([k, v]) => (
          <div key={k} className="card px-4 py-3">
            <span className="eyebrow">{k} {t('days', 'maalmood')}</span>
            <b className="num block text-[22px]">{money(v)}</b>
          </div>
        ))}
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card title={t('Claims', 'Sheegashooyinka')}>
          <ul className="grid gap-2 px-4 pb-4 text-[13px]">
            {claims.map((c) => (
              <li key={c.id} className="rounded-[10px] border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="font-mono">{c.claimNumber}</b>
                  <Pill tone={tone(c.status)}>{c.status}</Pill>
                  <span className="text-ink-2">
                    {c.payerName} · {c.memberNumber} · {c.invoiceNumber}
                  </span>
                  <span className="num ml-auto font-semibold">{money(c.claimedMinor, c.currency)}</span>
                </div>
                {c.approvedMinor !== null && c.status !== 'Draft' ? (
                  <p className="mt-1 text-ink-2">
                    {t('Approved', 'La oggolaaday')} {money(c.approvedMinor, c.currency)}
                    {c.remittedMinor ? ` · ${t('received', 'la helay')} ${money(c.remittedMinor, c.currency)}` : ''}
                    {c.writtenOffMinor ? ` · ${t('written off', 'la cafiyay')} ${money(c.writtenOffMinor, c.currency)}` : ''}
                    {c.denialCode ? ` · ${c.denialCode}` : ''}
                  </p>
                ) : null}
                {specialist && c.status === 'Draft' ? (
                  <button className="btn btn-primary mt-2 h-8" onClick={() => run(() => api(`/insurance/claims/${c.id}/submit`, { body: {} }))}>
                    {t('Submit to payer', 'U gudbi')}
                  </button>
                ) : null}
                {specialist && c.status === 'Submitted' ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <Field label={t('Approved amount', 'Qadarka la oggolaaday')}>
                      <input className="input h-8 w-28" inputMode="decimal" value={r(c.id).approved} onChange={(e) => setR(c.id, { approved: e.target.value })} placeholder={(c.claimedMinor / 100).toFixed(2)} />
                    </Field>
                    <Field label={t('Reason if cut or denied', 'Sababta')}>
                      <select className="input h-8" value={r(c.id).denialCode} onChange={(e) => setR(c.id, { denialCode: e.target.value })}>
                        {DENIALS.map((d) => (
                          <option key={d}>{d}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t('Note', 'Qoraal')}>
                      <input className="input h-8" value={r(c.id).note} onChange={(e) => setR(c.id, { note: e.target.value })} />
                    </Field>
                    <button
                      className="btn btn-primary h-8"
                      onClick={() => {
                        const approved = r(c.id).approved ? toMinor(r(c.id).approved) : c.claimedMinor;
                        void run(() => api(`/insurance/claims/${c.id}/respond`, { body: { decision: 'accept', approvedMinor: approved, ...(approved < c.claimedMinor ? { denialCode: r(c.id).denialCode } : {}), note: r(c.id).note || undefined } }));
                      }}
                    >
                      {t('Accept', 'Aqbal')}
                    </button>
                    <button className="btn h-8 text-crit" onClick={() => run(() => api(`/insurance/claims/${c.id}/respond`, { body: { decision: 'reject', denialCode: r(c.id).denialCode, note: r(c.id).note } }))}>
                      {t('Rejected', 'La diiday')}
                    </button>
                  </div>
                ) : null}
                {specialist && c.status === 'Accepted' ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <Field label={t('Amount received', 'Lacagta la helay')}>
                      <input className="input h-8 w-28" inputMode="decimal" value={r(c.id).remit} onChange={(e) => setR(c.id, { remit: e.target.value })} placeholder={((c.approvedMinor ?? 0) / 100).toFixed(2)} />
                    </Field>
                    <Field label={t('Remittance ref', 'Tixraaca')}>
                      <input className="input h-8 w-32" value={r(c.id).ref} onChange={(e) => setR(c.id, { ref: e.target.value })} />
                    </Field>
                    <Field label={t('Short-pay reason', 'Sababta yaraanta')}>
                      <input className="input h-8" value={r(c.id).short} onChange={(e) => setR(c.id, { short: e.target.value })} />
                    </Field>
                    <button
                      className="btn btn-primary h-8"
                      onClick={() => run(() => api(`/insurance/claims/${c.id}/remit`, { body: { amountMinor: r(c.id).remit ? toMinor(r(c.id).remit) : c.approvedMinor, reference: r(c.id).ref, shortPayReason: r(c.id).short || undefined } }))}
                    >
                      {t('Record remittance', 'Diiwaangeli')}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
            {!claims.length ? <li className="text-ink-3">{t('No claims yet.', 'Sheegasho weli ma jirto.')}</li> : null}
          </ul>
        </Card>

        <div className="grid gap-4">
          {editor ? (
            <Card title={t('Claim an invoice', 'Sheego biil')}>
              <div className="grid gap-3 px-4 pb-4 text-[13px]">
                <Field label={t('Invoice with a balance', 'Biil haraa leh')}>
                  <select className="input h-9" value={inv?.id ?? ''} onChange={(e) => setInv(invoices.find((i) => i.id === e.target.value) ?? null)}>
                    <option value="">{t('Choose…', 'Dooro…')}</option>
                    {invoices.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.invoiceNumber} · {patientName(i.patient)} · {money(i.patientDueMinor, i.currency)}
                      </option>
                    ))}
                  </select>
                </Field>
                {inv ? (
                  <>
                    <ul className="grid gap-1.5">
                      {policies.map((p) => (
                        <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line p-2.5">
                          <b>{p.payerName}</b> {p.memberNumber} · {p.coveragePercent}% · {p.validFrom} → {p.validTo}
                          {p.active ? <Pill tone="ok">{t('active', 'firfircoon')}</Pill> : <Pill tone="crit">{t('expired', 'dhacay')}</Pill>}
                          <button className="btn btn-primary ml-auto h-8" disabled={act.busy} onClick={() => run(() => api('/insurance/claims', { body: { invoiceId: inv.id, policyId: p.id } }), () => setInv(null))}>
                            <FileCheck2 size={15} /> {t('Draft claim', 'Diyaari sheegasho')}
                          </button>
                        </li>
                      ))}
                      {!policies.length ? <li className="text-ink-3">{t('This patient has no policy on file.', 'Bukaankan caymis kuma diiwaangashana.')}</li> : null}
                    </ul>
                    <form
                      className="grid gap-2 sm:grid-cols-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(() => api('/insurance/policies', { body: { patientId: inv.patientId, payerId: pol.payerId, memberNumber: pol.memberNumber, coveragePercent: Number(pol.coveragePercent), validFrom: pol.validFrom, validTo: pol.validTo } }), () => setPol({ ...pol, memberNumber: '' }));
                      }}
                    >
                      <b className="sm:col-span-2">{t('Add a policy', 'Ku dar caymis')}</b>
                      <Field label={t('Payer', 'Bixiyaha')}>
                        <select className="input h-9" required value={pol.payerId} onChange={(e) => setPol({ ...pol, payerId: e.target.value })}>
                          <option value="">—</option>
                          {payers.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label={t('Member number', 'Lambarka xubinta')} error={fe.memberNumber}>
                        <input className="input h-9" required value={pol.memberNumber} onChange={(e) => setPol({ ...pol, memberNumber: e.target.value })} />
                      </Field>
                      <Field label={t('Coverage %', 'Boqolkiiba')}>
                        <input className="input h-9" inputMode="numeric" required value={pol.coveragePercent} onChange={(e) => setPol({ ...pol, coveragePercent: e.target.value })} />
                      </Field>
                      <div className="grid grid-cols-2 gap-2">
                        <Field label={t('From', 'Laga bilaabo')}>
                          <input className="input h-9" type="date" required value={pol.validFrom} onChange={(e) => setPol({ ...pol, validFrom: e.target.value })} />
                        </Field>
                        <Field label={t('To', 'Ilaa')} error={fe.validTo}>
                          <input className="input h-9" type="date" required value={pol.validTo} onChange={(e) => setPol({ ...pol, validTo: e.target.value })} />
                        </Field>
                      </div>
                      <button className="btn h-9 justify-self-start">{t('Save policy', 'Kaydi')}</button>
                    </form>
                  </>
                ) : null}
              </div>
            </Card>
          ) : null}

          <Card title={t('Denials by reason', 'Diidmooyinka sababtooda')}>
            <ul className="grid gap-1 px-4 pb-4 text-[13px]">
              {denials.map((d) => (
                <li key={d.denialCode} className="flex gap-2">
                  {d.denialCode} <span className="text-ink-3">× {d.claims}</span>
                  <span className="num ml-auto">{money(d.deniedMinor)}</span>
                </li>
              ))}
              {!denials.length ? <li className="text-ink-3">{t('No denials.', 'Diidmo ma jirto.')}</li> : null}
            </ul>
          </Card>

          <Card title={t('Payers', 'Bixiyayaasha')}>
            <div className="grid gap-3 px-4 pb-4 text-[13px]">
              <ul className="grid gap-1">
                {payers.map((p) => (
                  <li key={p.id} className="flex gap-2">
                    <span className="font-mono text-[11.5px] text-ink-3">{p.code}</span> {p.name} <span className="ml-auto text-ink-3">{p.kind} · {p.currency}</span>
                  </li>
                ))}
              </ul>
              {specialist ? (
                <form
                  className="grid gap-2 sm:grid-cols-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(() => api('/insurance/payers', { body: payer }), () => setPayer({ ...payer, code: '', name: '' }));
                  }}
                >
                  <Field label={t('Code', 'Koodh')} error={fe.code}>
                    <input className="input h-9" required value={payer.code} onChange={(e) => setPayer({ ...payer, code: e.target.value })} />
                  </Field>
                  <Field label={t('Name', 'Magaca')} error={fe.name}>
                    <input className="input h-9" required value={payer.name} onChange={(e) => setPayer({ ...payer, name: e.target.value })} />
                  </Field>
                  <Field label={t('Kind', 'Nooca')}>
                    <select className="input h-9" value={payer.kind} onChange={(e) => setPayer({ ...payer, kind: e.target.value })}>
                      {['insurer', 'employer', 'ngo', 'government'].map((k) => (
                        <option key={k}>{k}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('Settles in', 'Lacagta')}>
                    <select className="input h-9" value={payer.currency} onChange={(e) => setPayer({ ...payer, currency: e.target.value })}>
                      <option>USD</option>
                      <option>SOS</option>
                    </select>
                  </Field>
                  <button className="btn h-9 justify-self-start">{t('Add payer', 'Ku dar')}</button>
                </form>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
