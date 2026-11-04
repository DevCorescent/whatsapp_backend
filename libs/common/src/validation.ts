import { BadRequestException } from '@nestjs/common';

/**
 * Guards a handler whose body is a plain shape rather than a decorated DTO.
 *
 * The global ValidationPipe can only check classes carrying class-validator decorators.
 * Most controllers here declare the body inline, so the pipe has nothing to validate and
 * a missing field travels down to the service, where it fails as a 500 — blaming the
 * server for a request the caller simply left incomplete. This refuses it at the edge
 * and names the field, which is what an integrator needs to fix their call.
 *
 * Empty string and empty array count as absent: a required value that is blank is not
 * supplied, and letting one through only moves the failure somewhere less legible.
 */
export function requireFields<T extends object>(
  body: T | null | undefined,
  fields: (keyof T)[],
): T {
  const absent = (v: unknown) =>
    v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

  const missing = body
    ? fields.filter((f) => absent((body as Record<string, unknown>)[f as string]))
    : fields;

  if (missing.length) {
    const names = missing.map(String).join(', ');
    throw new BadRequestException(
      `${names} ${missing.length > 1 ? 'are' : 'is'} required.`,
    );
  }
  return body as T;
}
