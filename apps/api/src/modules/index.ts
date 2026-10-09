import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import ai from './ai/index.js';
import analytics from './analytics/index.js';
import appointments from './appointments/index.js';
import auth from './auth/index.js';
import catalog from './catalog/index.js';
import commerce from './commerce/index.js';
import customers from './customers/index.js';
import files from './files/index.js';
import integrations from './integrations/index.js';
import kartes from './kartes/index.js';
import marketing from './marketing/index.js';
import messaging from './messaging/index.js';
import migration from './migration/index.js';
import ops from './ops/index.js';
import org from './org/index.js';
import payments from './payments/index.js';
import pos from './pos/index.js';
import publicApi from './public/index.js';
import reviews from './reviews/index.js';
import schedules from './schedules/index.js';

/**
 * Modular monolith: each module is a Fastify plugin that owns its routes, and registers its
 * job handlers / event subscribers / periodic tasks / org seeders as import side effects.
 * Modules communicate via service functions and domain events — never via each other's tables
 * directly when a service exists.
 */
export const modules: Record<string, FastifyPluginAsyncZod> = {
  auth,
  org,
  customers,
  catalog,
  schedules,
  appointments,
  files,
  kartes,
  pos,
  payments,
  messaging,
  integrations,
  migration,
  reviews,
  marketing,
  commerce,
  analytics,
  ai,
  ops,
  public: publicApi,
};

export const registerModules: FastifyPluginAsyncZod = async (app) => {
  for (const [name, plugin] of Object.entries(modules)) {
    await app.register(plugin, { prefix: '' }).after((err) => {
      if (err) throw new Error(`module ${name} failed to register: ${err.message}`);
    });
  }
};
