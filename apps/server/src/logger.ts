import { pino } from "pino";

// Érzékeny mezők sosem kerülhetnek logba (spec §90).
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.pin",
  "*.newPin",
  "*.password",
  "*.newPassword",
  "*.token",
  "*.totp",
  "*.recoveryCode",
  "*.latitude",
  "*.longitude",
];

export function createLogger(level = process.env.LOG_LEVEL ?? "info") {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } });
}

/**
 * Naplózható URL: a hozzáférési/helyreállítási tokenek (útvonalban vagy ?token= paraméterben) sosem kerülhetnek logba.
 */
export function redactUrl(url: string): string {
  const [path, query] = url.split("?", 2) as [string, string | undefined];
  const p = path.replace(/^(\/(?:belepes|pin-visszaallitas|email-megerosites)\/)[^/]+/, "$1[REDACTED]");
  if (!query) return p;
  const q = query.replace(/(^|&)(token|code|pin)=[^&]*/gi, "$1$2=[REDACTED]");
  return `${p}?${q}`;
}
