import cookieParser from 'cookie-parser';
import express, { Router } from 'express';
import helmet from 'helmet';
import { pino, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Deps } from './context';
import { correlation, errorHandler, notFound } from './middleware/core';
import { csrfGuard, loadSession, requireAuth, requirePlatform, requireTenant } from './middleware/session';
import { appointmentRoutes } from './modules/appointments/routes';
import { auditRoutes } from './modules/audit/routes';
import { authRoutes } from './modules/auth/routes';
import { encounterRoutes, timelineRoutes } from './modules/encounters/routes';
import { iamRoutes } from './modules/iam/routes';
import { orgRoutes } from './modules/org/routes';
import { patientRoutes } from './modules/patients/routes';
import { platformRoutes } from './modules/platform/routes';

export function createApp(deps: Deps, log: Logger = pino({ level: deps.config.env === 'test' ? 'silent' : 'info' })) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(correlation);
  if (deps.config.env !== 'test') {
    app.use(
      pinoHttp({
        logger: log,
        redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
        customProps: (req) => ({ correlationId: (req as express.Request).correlationId }),
      }),
    );
  }
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const api = Router();
  api.use(loadSession(deps));
  api.use(csrfGuard);
  api.use('/auth', authRoutes(deps));
  api.use('/platform', requireAuth(), requirePlatform, platformRoutes(deps));

  // Everything below belongs to a hospital workspace and runs against that tenant's own database.
  const tenant = Router();
  tenant.use(requireAuth(), requireTenant);
  tenant.use('/', orgRoutes(deps));
  tenant.use('/', iamRoutes(deps));
  tenant.use('/patients', patientRoutes(deps));
  tenant.use('/patients', timelineRoutes(deps));
  tenant.use('/encounters', encounterRoutes(deps));
  tenant.use('/appointments', appointmentRoutes(deps));
  tenant.use('/audit', auditRoutes(deps));
  api.use(tenant);

  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler(log));
  return app;
}
