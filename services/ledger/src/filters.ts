import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { DomainError } from './errors.js';

/** One error shape for the whole API: { error: { code, message, details? } }. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('ErrorFilter');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof DomainError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: {
          code: 'validation_error',
          message: 'Invalid request',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    if (err instanceof HttpException) {
      return res.status(err.getStatus()).json({ error: { code: 'http_error', message: err.message } });
    }
    this.log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
  }
}
