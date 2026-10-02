import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { errMsg } from "../api";

export function Banner({ kind = "info", title, children }: { kind?: "info" | "warn" | "error" | "ok"; title?: string; children?: ReactNode }) {
  return (
    <div className={`banner ${kind}`} role={kind === "error" ? "alert" : "status"}>
      {title && <b>{title}</b>}
      {children && <div>{children}</div>}
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  return error ? <p className="error-text" role="alert">{errMsg(error)}</p> : null;
}

export function Loading({ text = "Betöltés…" }: { text?: string }) {
  return <p className="muted" role="status">{text}</p>;
}

export function Badge({ kind = "info", children }: { kind?: "ok" | "warn" | "danger" | "info"; children: ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

export function Button({ variant, block, small, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "secondary" | "danger" | "ghost"; block?: boolean; small?: boolean }) {
  return <button type="button" {...p} className={`btn ${variant ?? ""} ${block ? "block" : ""} ${small ? "small" : ""} ${p.className ?? ""}`} />;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {hint && <span className="hint">{hint}</span>}
      {children}
      {error && <span className="error-text" role="alert">{error}</span>}
    </label>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} />;

/** Egyszerű alsó panel / párbeszédablak: Esc zár, a fókusz belép és visszatér. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Az onClose gyakran inline függvény (minden rendernél új): ref-ben tartjuk, hogy az effekt csak nyitáskor
  // fusson, különben minden begépelt betű után a fókusz visszaugrana a modalra.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); prev?.focus?.(); };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="row between"><h2 style={{ margin: 0 }}>{title}</h2><Button variant="ghost" small onClick={onClose} aria-label="Bezárás">✕</Button></div>
        {children}
      </div>
    </div>
  );
}

interface ConfirmState { title: string; text: string; confirmLabel: string; danger: boolean; reason: boolean; resolve: (v: { ok: boolean; reason?: string }) => void }

export function useConfirm() {
  const [state, setState] = useState<ConfirmState | null>(null);
  const confirm = (title: string, text: string, opts: { confirmLabel?: string; danger?: boolean; reason?: boolean } = {}) =>
    new Promise<{ ok: boolean; reason?: string }>((resolve) =>
      setState({ title, text, confirmLabel: opts.confirmLabel ?? "Megerősítem", danger: opts.danger ?? false, reason: opts.reason ?? false, resolve }));
  const dialog = state ? <ConfirmSheet s={state} onDone={(v) => { state.resolve(v); setState(null); }} /> : null;
  return { confirm, dialog };
}

function ConfirmSheet({ s, onDone }: { s: ConfirmState; onDone: (v: { ok: boolean; reason?: string }) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Sheet title={s.title} onClose={() => onDone({ ok: false })}>
      <p>{s.text}</p>
      {s.reason && <Field label="Indoklás (kötelező)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      <div className="row">
        <Button variant={s.danger ? "danger" : undefined} disabled={s.reason && !reason.trim()} onClick={() => onDone({ ok: true, reason })}>{s.confirmLabel}</Button>
        <Button variant="secondary" onClick={() => onDone({ ok: false })}>Mégsem</Button>
      </div>
    </Sheet>
  );
}

/** Egyszeri küldés védelem: a gomb azonnal letilt a művelet végéig. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const busyRef = useRef(false);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (busyRef.current) return undefined;
    busyRef.current = true; setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError(e); return undefined; } finally { busyRef.current = false; setBusy(false); }
  };
  return { busy, error, run, setError };
}
