import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from '../../config.js';
import { uuid } from '../../lib/schemas.js';
import { signup } from '../org/service.js';
import { signupSchema } from '../org/schemas.js';
import * as svc from './service.js';

const authRateLimit = { rateLimit: { max: config.NODE_ENV === 'test' ? 100000 : 20, timeWindow: '1 minute' } };

const plugin: FastifyPluginAsyncZod = async (app) => {
  const meta = (req: { ip: string; headers: Record<string, unknown> }) => ({
    ip: req.ip,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
  });

  app.post(
    '/auth/signup',
    { config: { auth: 'public', ...authRateLimit }, schema: { tags: ['auth'], summary: '新規法人登録(オンボーディング)', body: signupSchema } },
    async (req, reply) => {
      const created = await signup(req.body);
      const result = await svc.login(req.body.email, req.body.password, created.organizationId, meta(req));
      return reply.status(201).send({ ...created, auth: result });
    },
  );

  app.post(
    '/auth/login',
    {
      config: { auth: 'public', ...authRateLimit },
      schema: {
        tags: ['auth'],
        summary: 'ログイン',
        description: '複数法人所属時は organization_required を返す。MFA有効時は mfa_required を返し /auth/otp/verify で完了する。',
        body: z.object({ email: z.string().email(), password: z.string().min(1), organizationId: uuid.optional() }),
      },
    },
    (req) => svc.login(req.body.email, req.body.password, req.body.organizationId, meta(req)),
  );

  app.post(
    '/auth/otp/verify',
    {
      config: { auth: 'public', ...authRateLimit },
      schema: { tags: ['auth'], summary: 'OTP確認(MFA)', body: z.object({ challengeId: uuid, code: z.string().regex(/^\d{6}$/) }) },
    },
    (req) => svc.verifyOtp(req.body.challengeId, req.body.code, meta(req)),
  );

  app.post(
    '/auth/refresh',
    { config: { auth: 'public', ...authRateLimit }, schema: { tags: ['auth'], summary: 'トークン更新(ローテーション)', body: z.object({ refreshToken: z.string().min(10) }) } },
    (req) => svc.refresh(req.body.refreshToken, meta(req)),
  );

  app.post(
    '/auth/logout',
    { config: { auth: 'public' }, schema: { tags: ['auth'], summary: 'ログアウト', body: z.object({ refreshToken: z.string().min(10) }) } },
    async (req, reply) => {
      await svc.logout(req.body.refreshToken);
      return reply.status(204).send();
    },
  );

  app.post(
    '/auth/accept-invite',
    {
      config: { auth: 'public', ...authRateLimit },
      schema: { tags: ['auth'], summary: 'スタッフ招待の受諾', body: z.object({ token: z.string().min(10), password: z.string().min(10).max(200) }) },
    },
    (req) => svc.acceptInvite(req.body.token, req.body.password, meta(req)),
  );

  app.post(
    '/auth/switch-organization',
    { schema: { tags: ['auth'], summary: '法人切替', body: z.object({ organizationId: uuid }) } },
    (req) => svc.switchOrganization(req.staff().userId, req.body.organizationId, meta(req)),
  );

  app.post(
    '/auth/password',
    { config: authRateLimit, schema: { tags: ['auth'], summary: 'パスワード変更', body: z.object({ currentPassword: z.string(), newPassword: z.string().min(10).max(200) }) } },
    async (req, reply) => {
      await svc.changePassword(req.staff().userId, req.body.currentPassword, req.body.newPassword);
      return reply.status(204).send();
    },
  );

  app.put('/auth/mfa', { schema: { tags: ['auth'], summary: 'MFA設定', body: z.object({ enabled: z.boolean() }) } }, async (req) => {
    await svc.setMfa(req.staff().userId, req.body.enabled);
    return { enabled: req.body.enabled };
  });

  app.get('/me', { schema: { tags: ['auth'], summary: '自分の権限/所属' } }, async (req) => {
    const actor = req.staff();
    const base = await svc.me(actor.userId, actor.organizationId, actor.staffId);
    return {
      ...base,
      permissions: [...actor.permissions].sort(),
      shopIds: actor.shopIds,
      allShops: actor.allShops,
    };
  });
};

export default plugin;
