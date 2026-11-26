import { timingSafeEqual } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express, { Router } from 'express';
import helmet from 'helmet';
import { pino, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Deps } from './context';
import { correlation, errorHandler, notFound } from './middleware/core';
import { csrfGuard, loadSession, requireAuth, requirePlatform, requireTenant } from './middleware/session';
import { accountingRoutes } from './modules/accounting/routes';
import { admissionRoutes } from './modules/admissions/routes';
import { billingRoutes } from './modules/billing/routes';
import { paymentWebhookRoutes } from './modules/billing/webhook';
import { renderMetrics, requestMetrics } from './ops/metrics';
import { appointmentRoutes } from './modules/appointments/routes';
import { auditRoutes } from './modules/audit/routes';
import { bloodBankRoutes } from './modules/bloodbank/routes';
import { authRoutes } from './modules/auth/routes';
import { clinicalRoutes } from './modules/clinical/routes';
import { emergencyRoutes } from './modules/emergency/routes';
import { encounterRoutes, timelineRoutes } from './modules/encounters/routes';
import { equipmentRoutes } from './modules/equipment/routes';
import { iamRoutes } from './modules/iam/routes';
import { icuRoutes } from './modules/icu/routes';
import { DIAGNOSTICS, RADIOLOGY, imagingRoutes } from './modules/imaging/routes';
import { insuranceRoutes } from './modules/insurance/routes';
import { fhirRoutes } from './modules/fhir/routes';
import { homeRoutes } from './modules/home/routes';
import { hrRoutes } from './modules/hr/routes';
import { integrationRoutes } from './modules/integrations/routes';
import { intelRoutes } from './modules/intel/routes';
import { inventoryRoutes } from './modules/inventory/routes';
import { migrationRoutes } from './modules/migrations/routes';
import { securityRoutes } from './modules/security/routes';
import { settingsRoutes } from './modules/settings/routes';
import { studioRoutes } from './modules/studio/routes';
import { procurementRoutes } from './modules/procurement/routes';
import { qualityRoutes } from './modules/quality/routes';
import { labRoutes } from './modules/lab/routes';
import { maternityRoutes } from './modules/maternity/routes';
import { nursingRoutes } from './modules/nursing/routes';
import { orgRoutes } from './modules/org/routes';
import { patientRoutes } from './modules/patients/routes';
import { pharmacyRoutes } from './modules/pharmacy/routes';
import { portalFence, portalRoutes } from './modules/portal/routes';
import { platformRoutes } from './modules/platform/routes';
import { referralRoutes } from './modules/referrals/routes';
import { surgeryRoutes } from './modules/surgery/routes';
import { teleRoutes } from './modules/telemedicine/routes';

export function createApp(deps: Deps, log: Logger = pino({ level: deps.config.env === 'test' ? 'silent' : 'info' })) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(correlation);
  app.use(requestMetrics);
  if (deps.config.env !== 'test') {
    app.use(
      pinoHttp({
        logger: log,
        redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
        customProps: (req) => ({ correlationId: (req as express.Request).correlationId }),
      }),
    );
  }
  // Provider callbacks carry their own signature over the raw body, so they are mounted before JSON parsing and outside the session.
  app.use('/api/v1/webhooks/payments', paymentWebhookRoutes(deps));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Readiness (spec §13.4): only take traffic when the database answers.
  app.get('/health/ready', async (_req, res) => {
    try {
      await deps.data.control().command({ ping: 1 });
      res.json({ status: 'ready', db: 'ok' });
    } catch {
      res.status(503).json({ status: 'not-ready', db: 'unreachable' });
    }
  });

  /** Prometheus metrics, only with the configured bearer token; off when no token is set. */
  app.get('/metrics', (req, res, next) => {
    const t = deps.config.metricsToken;
    const given = req.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!t) return next();
    if (given.length !== t.length || !timingSafeEqual(Buffer.from(given), Buffer.from(t))) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Metrics need the monitoring token', correlationId: req.correlationId } });
    res.type('text/plain; version=0.0.4').send(renderMetrics());
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // FHIR facade (spec §12.1): API clients with bearer tokens, outside the cookie session and CSRF guard.
  app.use('/api/v1/fhir/:tenant', fhirRoutes(deps));

  const api = Router();
  api.use(loadSession(deps));
  api.use(csrfGuard);
  api.use('/auth', authRoutes(deps));
  api.use('/platform', requireAuth(), requirePlatform, platformRoutes(deps));
  api.use('/home', requireAuth(), homeRoutes(deps));

  // Everything below belongs to a hospital workspace and runs against that tenant's own database.
  const tenant = Router();
  tenant.use(requireAuth(), requireTenant);
  // Patients and caregivers reach only the portal; the rest of the hospital API is closed to them.
  tenant.use(portalFence(deps));
  tenant.use('/', portalRoutes(deps));
  tenant.use('/', orgRoutes(deps));
  tenant.use('/', settingsRoutes(deps));
  tenant.use('/', iamRoutes(deps));
  tenant.use('/patients', patientRoutes(deps));
  tenant.use('/patients', timelineRoutes(deps));
  tenant.use('/encounters', encounterRoutes(deps));
  tenant.use('/', clinicalRoutes(deps));
  tenant.use('/', admissionRoutes(deps));
  tenant.use('/emergency', emergencyRoutes(deps));
  tenant.use('/nursing', nursingRoutes(deps));
  tenant.use('/surgery', surgeryRoutes(deps));
  tenant.use('/maternity', maternityRoutes(deps));
  tenant.use('/', referralRoutes(deps));
  tenant.use('/inventory', inventoryRoutes(deps));
  tenant.use('/lab', labRoutes(deps));
  tenant.use('/equipment', equipmentRoutes(deps));
  tenant.use('/pharmacy', pharmacyRoutes(deps));
  tenant.use('/bloodbank', bloodBankRoutes(deps));
  tenant.use('/accounting', accountingRoutes(deps));
  tenant.use('/billing', billingRoutes(deps));
  tenant.use('/insurance', insuranceRoutes(deps));
  tenant.use('/procurement', procurementRoutes(deps));
  tenant.use('/hr', hrRoutes(deps));
  tenant.use('/intel', intelRoutes(deps));
  tenant.use('/studio', studioRoutes(deps));
  tenant.use('/integrations', integrationRoutes(deps));
  tenant.use('/migrations', migrationRoutes(deps));
  tenant.use('/security', securityRoutes(deps));
  tenant.use('/quality', qualityRoutes(deps));
  tenant.use('/telemedicine', teleRoutes(deps));
  tenant.use('/icu', icuRoutes(deps));
  tenant.use('/radiology', imagingRoutes(deps, RADIOLOGY));
  tenant.use('/diagnostics', imagingRoutes(deps, DIAGNOSTICS));
  tenant.use('/appointments', appointmentRoutes(deps));
  tenant.use('/audit', auditRoutes(deps));
  api.use(tenant);

  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler(log));
  return app;
}
