import type { FastifyError, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import { AppError, fromPgError } from '../lib/errors.js';

async function errorPlugin(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError | Error, req, reply) => {
    const requestId = req.id;
    let appErr: AppError | null;

    if (err instanceof AppError) {
      appErr = err;
    } else if (err instanceof ZodError) {
      // validation raised inside services (e.g. settings merge)
      appErr = new AppError('validation', 'VALIDATION_ERROR', '入力内容に誤りがあります', {
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
      });
    } else if (hasZodFastifySchemaValidationErrors(err)) {
      appErr = new AppError('validation', 'VALIDATION_ERROR', '入力内容に誤りがあります', {
        issues: err.validation.map((v) => ({
          path: v.instancePath,
          message: v.message,
          params: v.params,
        })),
        context: err.validationContext,
      });
    } else if (isResponseSerializationError(err)) {
      req.log.error({ err, cause: err.cause }, 'response serialization error');
      appErr = new AppError('system', 'RESPONSE_SERIALIZATION_ERROR', 'レスポンス生成に失敗しました');
    } else if ((err as FastifyError).statusCode === 429) {
      appErr = new AppError('rate_limit', 'RATE_LIMITED', 'リクエストが多すぎます。しばらくしてから再試行してください');
    } else if ((err as FastifyError).validation) {
      appErr = new AppError('validation', 'VALIDATION_ERROR', err.message);
    } else if ((err as FastifyError).statusCode && (err as FastifyError).statusCode! < 500) {
      const fe = err as FastifyError;
      appErr = new AppError(
        fe.statusCode === 404 ? 'not_found' : fe.statusCode === 413 ? 'validation' : 'validation',
        fe.code ?? 'BAD_REQUEST',
        fe.message,
        undefined,
        fe.statusCode,
      );
    } else {
      appErr = fromPgError(err);
    }

    if (!appErr) {
      req.log.error({ err }, 'unhandled error');
      appErr = new AppError('system', 'INTERNAL_ERROR', 'システムエラーが発生しました');
    } else if (appErr.status >= 500) {
      req.log.error({ err }, appErr.message);
    } else {
      req.log.info({ code: appErr.code, status: appErr.status }, appErr.message);
    }

    void reply.status(appErr.status).send({
      error: {
        code: appErr.code,
        category: appErr.category,
        message: appErr.message,
        ...(appErr.details !== undefined ? { details: appErr.details } : {}),
        requestId,
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: { code: 'ROUTE_NOT_FOUND', category: 'not_found', message: `${req.method} ${req.url} は存在しません`, requestId: req.id },
    });
  });
}

export default fp(errorPlugin, { name: 'errors' });
