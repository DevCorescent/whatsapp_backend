import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Gives every failure the same shape the app already reads.
 *
 * Nest's default puts the sentence worth showing in `message` and a generic label such as
 * "Bad Request" in `error`. The guards in this codebase do the opposite: `error` holds
 * the sentence. Every caller reads `error`, so a refusal that explained itself clearly —
 * why a role cannot be assigned, why a domain is taken — reached the screen as "Bad
 * Request" and the explanation was thrown away.
 *
 * One shape, decided here rather than in each of the thirty places that read a response:
 *
 *   { success: false, error: "<the sentence>", statusCode, ...details }
 *
 * `message` is kept alongside it so anything already reading that keeps working.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const payload = exception instanceof HttpException ? exception.getResponse() : null;
    const extras: Record<string, unknown> = {};
    let message: string;

    if (typeof payload === 'string') {
      message = payload;
    } else if (payload && typeof payload === 'object') {
      const body = payload as Record<string, unknown>;
      // Validation errors arrive as an array of sentences; the first is the one to show,
      // and the rest travel as `issues` for a form that wants to mark several fields.
      const raw = body.message ?? body.error;
      if (Array.isArray(raw)) {
        message = String(raw[0] ?? 'Request failed');
        extras.issues = raw;
      } else {
        message = String(raw ?? 'Request failed');
      }
      for (const [k, v] of Object.entries(body)) {
        if (!['message', 'error', 'statusCode'].includes(k)) extras[k] = v;
      }
    } else {
      message = 'Something went wrong on our side.';
    }

    // An unexpected failure is worth a stack trace in the log; a refusal is not.
    if (status >= 500) {
      this.logger.error(
        `${status} ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
      // Never hand an internal message to the browser — it can name tables and paths.
      message = 'Something went wrong on our side.';
    }

    res.status(status).json({
      success: false,
      error:   message,
      message,
      statusCode: status,
      ...extras,
    });
  }
}
