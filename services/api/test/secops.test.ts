import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.35 / §11.1: access reviews (privilege review) and confidential security incidents. */
let h: Harness;
let H: Hospital;
let review: string;

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'hadmin', role: 'hospital-admin' },
    { key: 'cashier', role: 'cashier' },
    { key: 'nurse', role: 'nurse' },
    { key: 'auditor', role: 'security-auditor' },
    { key: 'dpo', role: 'dpo' },
    { key: 'quality', role: 'quality-officer' },
  ]);
});
afterAll(async () => {
  await h?.stop();
});

describe('access reviews', () => {
  it('administrators start a review of every active account; only one runs at a time', async () => {
    expect((await H.staff.cashier!.c.post('/security/access-reviews', { title: 'Q4 review' })).status).toBe(403);
    expect((await H.staff.cashier!.c.get('/security/access-reviews')).status).toBe(403);
    const r = await H.admin.post('/security/access-reviews', { title: 'Q4 2026 access review' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    review = r.body.data.id;
    expect(r.body.data.summary.total).toBe(7); // admin + six staff
    expect((await H.staff.dpo!.c.post('/security/access-reviews', { title: 'Another' })).body.error.code).toBe('REVIEW_OPEN');
    expect((await H.staff.auditor!.c.get(`/security/access-reviews/${review}`)).status).toBe(200);
  });

  it('nobody certifies their own access; a revoke cuts the account off at once', async () => {
    expect((await H.staff.hadmin!.c.post(`/security/access-reviews/${review}/items/${H.staff.hadmin!.id}/decide`, { decision: 'keep' })).body.error.code).toBe('FOUR_EYES');
    expect((await H.staff.hadmin!.c.post(`/security/access-reviews/${review}/items/${H.staff.nurse!.id}/decide`, { decision: 'keep' })).body.data.decision).toBe('keep');
    expect((await H.staff.cashier!.c.get('/auth/me')).status).toBe(200);
    const r = await H.staff.hadmin!.c.post(`/security/access-reviews/${review}/items/${H.staff.cashier!.id}/decide`, { decision: 'revoke', note: 'Left the cashier role in October' });
    expect(r.body.data.decision).toBe('revoke');
    expect((await H.staff.cashier!.c.get('/auth/me')).status).toBe(401);
    const u = await h.data.tenant('fahan_t_hiil').collection('users').findOne({ email: 'cashier@hiil.test' });
    expect(u!.status).toBe('Suspended');
  });

  it('the review completes when every account has a decision', async () => {
    const items = (await H.admin.get(`/security/access-reviews/${review}`)).body.data.items as { userId: string; decision: string | null }[];
    // The super-admin certifies the hospital admin; the hospital admin certifies everyone else.
    for (const i of items.filter((x) => !x.decision)) {
      const decider = i.userId === H.staff.hadmin!.id ? H.admin : H.staff.hadmin!.c;
      expect((await decider.post(`/security/access-reviews/${review}/items/${i.userId}/decide`, { decision: 'keep' })).status).toBe(200);
    }
    const done = (await H.admin.get(`/security/access-reviews/${review}`)).body.data;
    expect(done).toMatchObject({ status: 'Completed', summary: { total: 7, kept: 6, revoked: 1 } });
  });
});

describe('security incidents', () => {
  let inc: string;

  it('are confidential: reported and read by security roles only', async () => {
    expect((await H.staff.nurse!.c.post('/security/incidents', { title: 'Shared password seen', severity: 'medium', category: 'security', description: 'A password was written on a sticky note.' })).status).toBe(403);
    const r = await H.staff.quality!.c.post('/security/incidents', { title: 'Lab results printed to wrong ward', severity: 'high', category: 'privacy', description: 'Two reports for ward 3 were printed at the ward 5 printer.' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'Detected', number: expect.stringMatching(/^SEC-\d{4}-0001$/) });
    inc = r.body.data.id;
    expect((await H.staff.nurse!.c.get('/security/incidents')).status).toBe(403);
  });

  it('move Detected → Investigated → Remediated → Closed with written remediation and root cause', async () => {
    expect((await H.staff.quality!.c.post(`/security/incidents/${inc}/advance`, { note: 'Looking into it' })).status).toBe(403);
    expect((await H.staff.auditor!.c.post(`/security/incidents/${inc}/advance`, { note: 'Printer mapping checked', relatedAuditSeqs: [3, 4] })).body.data.status).toBe('Investigated');
    expect((await H.staff.auditor!.c.post(`/security/incidents/${inc}/advance`, { note: 'Fixed' })).status).toBe(400);
    expect((await H.staff.auditor!.c.post(`/security/incidents/${inc}/advance`, { note: 'Fixed', remediation: 'Printer queue for ward 3 re-pointed; both reports retrieved and shredded.' })).body.data.status).toBe('Remediated');
    expect((await H.staff.auditor!.c.post(`/security/incidents/${inc}/advance`, { note: 'Done' })).status).toBe(400);
    expect((await H.staff.auditor!.c.post(`/security/incidents/${inc}/advance`, { note: 'Closing', rootCause: 'Printer was moved without updating the ward mapping.' })).body.data.status).toBe('Closed');
    expect((await H.staff.auditor!.c.post(`/security/incidents/${inc}/advance`, { note: 'Again please' })).body.error.code).toBe('INVALID_TRANSITION');
  });

  it('the reporter cannot close their own incident', async () => {
    const id = (await H.staff.dpo!.c.post('/security/incidents', { title: 'Unusual export volume', severity: 'medium', category: 'privacy', description: 'Many CSV exports by one analyst in an hour.' })).body.data.id;
    await H.staff.dpo!.c.post(`/security/incidents/${id}/advance`, { note: 'Reviewed exports' });
    await H.staff.dpo!.c.post(`/security/incidents/${id}/advance`, { note: 'Limited', remediation: 'Export access narrowed to the analyst’s own reports.' });
    expect((await H.staff.dpo!.c.post(`/security/incidents/${id}/advance`, { note: 'Close', rootCause: 'Role had wider export rights than needed.' })).body.error.code).toBe('FOUR_EYES');
    expect((await H.staff.auditor!.c.post(`/security/incidents/${id}/advance`, { note: 'Close', rootCause: 'Role had wider export rights than needed.' })).body.data.status).toBe('Closed');
  });
});
