import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Wraps all JSON responses in the same envelope Next.js API routes use:
 *   { success: true, data: <payload> }                 — simple responses
 *   { success: true, data: [...], pagination: {...} }   — paginated list responses
 *
 * Detection: a response is treated as a paginated list when it is a plain
 * object with exactly one array-valued key plus `total`, `page`, `limit`.
 * Responses that already carry a `success` property pass through unchanged.
 */
@Injectable()
export class TransformInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => this.transform(data)));
  }

  private transform(data: unknown): unknown {
    if (data === null || data === undefined) return { success: true, data: null };

    // Already formatted — pass through
    if (typeof data === 'object' && !Array.isArray(data) && 'success' in (data as object)) {
      return data;
    }

    // Detect paginated shape: plain object with ONE array key + total/page/limit
    if (typeof data === 'object' && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      const arrayKeys = Object.keys(obj).filter((k) => Array.isArray(obj[k]));
      if (
        arrayKeys.length === 1 &&
        typeof obj.total === 'number' &&
        typeof obj.page  === 'number' &&
        typeof obj.limit === 'number'
      ) {
        const reserved = new Set([arrayKeys[0], 'total', 'page', 'limit']);
        const extras = Object.fromEntries(Object.entries(obj).filter(([k]) => !reserved.has(k)));
        return {
          success: true,
          data: obj[arrayKeys[0]],
          pagination: {
            page:       obj.page,
            limit:      obj.limit,
            total:      obj.total,
            totalPages: Math.ceil(obj.total / obj.limit),
          },
          ...extras,
        };
      }
    }

    return { success: true, data };
  }
}
