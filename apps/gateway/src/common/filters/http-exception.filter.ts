import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { isTransientDbError } from '@lib/prisma';
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
/**
 * Prisma failures that are really the caller's doing, and the answer each deserves.
 *
 * Deliberately narrow: only the codes whose cause is unambiguously the request. Anything
 * else stays a 500, because guessing that a server fault is the caller's would hide real
 * bugs — the opposite mistake, and the worse one.
 */
function mapPrismaError(err: unknown): { status: number; message: string } | null {
  const name = (err as { name?: string })?.name;
  if (name === 'PrismaClientValidationError') {
    return { status: HttpStatus.BAD_REQUEST, message: 'The request is missing required information.' };
  }
  if (name !== 'PrismaClientKnownRequestError') return null;

  const code = (err as { code?: string })?.code;
  switch (code) {
    case 'P2025': return { status: HttpStatus.NOT_FOUND,  message: 'That record does not exist.' };
    case 'P2002': return { status: HttpStatus.CONFLICT,   message: 'That already exists.' };
    case 'P2003': return { status: HttpStatus.BAD_REQUEST, message: 'That refers to something that does not exist.' };
    case 'P2000': return { status: HttpStatus.BAD_REQUEST, message: 'One of the values is too long.' };
    case 'P2011': return { status: HttpStatus.BAD_REQUEST, message: 'A required value was left empty.' };
    default:      return null;
  }
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    // A serverless Postgres drops quiet connections, so a page can fail for a second and
    // work on a reload. Reported as a 500 "something went wrong on our side" it reads as
    // a bug and sends people looking for data they think they have lost — which is worse
    // than the outage. It is honest about being temporary, and names nothing internal.
    if (!(exception instanceof HttpException) && isTransientDbError(exception)) {
      this.logger.warn(`Database briefly unreachable: ${(exception as Error)?.message?.split('\n')[0]}`);
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        success: false,
        error:   'The database is briefly unreachable. Nothing is lost — try again in a moment.',
        message: 'The database is briefly unreachable. Nothing is lost — try again in a moment.',
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        retryable: true,
      });
      return;
    }

    // A request the caller got wrong is not a server fault. Most controllers here accept
    // a plain object rather than a decorated DTO, so the global ValidationPipe has nothing
    // to check and a missing field travels all the way down to Prisma, which throws. Left
    // alone that surfaces as 500 "something went wrong on our side" — telling an integrator
    // the server is broken when their payload is simply incomplete.
    const mapped = mapPrismaError(exception);
    if (mapped) {
      res.status(mapped.status).json({
        success: false,
        error:   mapped.message,
        message: mapped.message,
        statusCode: mapped.status,
      });
      return;
    }

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
