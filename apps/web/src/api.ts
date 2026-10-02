// Vékony fetch-réteg: CSRF fejléc, érthető magyar hibák, hálózati hiba megkülönböztetése.
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export class NetworkError extends Error {
  constructor() {
    super("Nincs internetkapcsolat.");
  }
}

let csrf: string | null = null;
export const setCsrf = (t: string | null) => {
  csrf = t;
  try {
    if (t) localStorage.setItem("th_csrf", t); else localStorage.removeItem("th_csrf");
  } catch { /* privát mód */ }
};
export const getCsrf = () => {
  if (csrf) return csrf;
  try { return localStorage.getItem("th_csrf"); } catch { return null; }
};

export interface ReqOptions { method?: string; body?: unknown; form?: FormData; headers?: Record<string, string>; signal?: AbortSignal }

export async function api<T = unknown>(path: string, opts: ReqOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body || opts.form ? "POST" : "GET");
  const headers: Record<string, string> = { ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.body); }
  if (method !== "GET") { const c = getCsrf(); if (c) headers["X-CSRF-Token"] = c; }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body, credentials: "same-origin", signal: opts.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new NetworkError();
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* nem JSON */ }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(res.status, d.error ?? "error", d.message ?? "Váratlan hiba történt. Kérjük, próbáld újra később.", d.details);
  }
  return data as T;
}

export const isNetworkError = (e: unknown): e is NetworkError => e instanceof NetworkError;
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Váratlan hiba történt.");
export const newKey = () => crypto.randomUUID();
