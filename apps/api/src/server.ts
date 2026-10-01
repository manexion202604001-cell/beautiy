import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { config } from './config.js';
import { db } from './db/client.js';
import { registerModules } from './modules/index.js';
import contextPlugin, { newRequestId } from './plugins/context.js';
import errorPlugin from './plugins/errors.js';
import idempotencyPlugin from './plugins/idempotency.js';

export async function buildApp(opts: { logger?: FastifyServerOptions['logger'] } = {}) {
  const app = Fastify({
    logger:
      opts.logger ??
      (config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-line-signature"]'],
            ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
          }),
    genReqId: (req) => newRequestId(req as { headers: Record<string, unknown> }),
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
    ajv: { customOptions: { coerceTypes: 'array' } },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Keep raw body for webhook signature verification (LINE / Stripe)
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: true,
    exposedHeaders: ['x-request-id', 'idempotent-replayed'],
  });
  await app.register(rateLimit, {
    global: true,
    max: config.NODE_ENV === 'test' ? 100000 : config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Salon OS API',
        version: '1.0.0',
        description:
          'LiME型 美容サロンOS API。JSON over HTTPS / バージョン /v1 / cursor pagination / Idempotency-Key / UTC保存・店舗TZ表示。',
      },
      servers: [{ url: config.API_BASE_URL }],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(contextPlugin);
  await app.register(errorPlugin);
  await app.register(idempotencyPlugin);

  app.get('/healthz', { config: { auth: 'public' }, schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { config: { auth: 'public' }, schema: { hide: true } }, async () => {
    await sql`SELECT 1`.execute(db);
    return { status: 'ready' };
  });

  await app.register(registerModules, { prefix: '/v1' });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
