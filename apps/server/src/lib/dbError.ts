/**
 * A drizzle-orm 0.45-től a pg hibákat DrizzleQueryError-ba csomagolja (az eredeti a `cause`-ban van).
 * Visszaadja az eredeti PostgreSQL hibát (code, constraint), vagy a kapott hibát.
 */
export function pgError(e: unknown): { code?: string; constraint?: string } {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const c = cur as { code?: string; constraint?: string; cause?: unknown };
    if (typeof c.code === "string" && /^[0-9A-Z]{5}$/.test(c.code)) return c;
    cur = c.cause;
  }
  return {};
}
