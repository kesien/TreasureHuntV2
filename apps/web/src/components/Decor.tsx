import type { ReactNode } from "react";

export type ThemeType = "halloween" | "easter";

/* Beágyazott, díszítő SVG-k (külső fájl nélkül, offline is működnek). Mind aria-hidden: nem hordoznak információt. */
interface P { size?: number; className?: string }
const svg = (size: number, vb: string, className?: string) => ({ width: size, height: size, viewBox: vb, className, "aria-hidden": true as const, focusable: false as const });

export function Pumpkin({ size = 48, className }: P) {
  return (
    <svg {...svg(size, "0 0 64 64", className)}>
      <path d="M32 14c-3-5-8-6-11-4 2 2 6 3 11 4Z" fill="#3f8f3a" />
      <rect x="29.5" y="6" width="5" height="12" rx="2" fill="#4a7c2f" />
      <ellipse cx="19" cy="38" rx="14" ry="19" fill="#e9690c" />
      <ellipse cx="45" cy="38" rx="14" ry="19" fill="#e9690c" />
      <ellipse cx="32" cy="38" rx="13" ry="21" fill="#ff8a1f" />
      <path d="M22 28l6 8-9 0Z M42 28l6 8-9 0Z" fill="#2a0f00" />
      <path d="M20 46c4 6 20 6 24 0-3 2-5 1-7-1-2 2-5 2-7 0-2 2-5 3-8 0l-2 1Z" fill="#2a0f00" />
      <path d="M26 34l2-4 2 4Z M36 34l2-4 2 4Z" fill="#ffd166" opacity=".9" />
    </svg>
  );
}

export function Bat({ size = 44, className }: P) {
  return (
    <svg {...svg(size, "0 0 64 40", className)}>
      <path fill="#a78bfa" d="M32 8c-1.6 0-2.4 2.4-3.4 3.6C26 10.2 21 7 13 9 8.6 10 3.6 14 1 22c4-3 7-3.6 10-2 1.6 2 3.4 5.2 6.6 5.6 1.6-3 3.6-3.8 6-2.4 1.6 1.4 2.6 4.4 8.4 14.8 5.8-10.4 6.8-13.4 8.4-14.8 2.4-1.4 4.4-.6 6 2.4 3.2-.4 5-3.6 6.6-5.6 3-1.6 6-1 10 2-2.6-8-7.6-12-12-13-8-2-13 1.2-15.6 2.6C34.4 10.4 33.6 8 32 8Z" />
      <circle cx="29" cy="14" r="1.3" fill="#ff8a1f" />
      <circle cx="35" cy="14" r="1.3" fill="#ff8a1f" />
    </svg>
  );
}

export function Ghost({ size = 48, className }: P) {
  return (
    <svg {...svg(size, "0 0 64 64", className)}>
      <path fill="#f5efe6" d="M32 6C20 6 12 15 12 27v28c0 2 2 3 4 1l4-4 4 5c1 1 3 1 4 0l4-5 4 5c1 1 3 1 4 0l4-5 4 4c2 2 4 1 4-1V27C52 15 44 6 32 6Z" />
      <ellipse cx="25" cy="27" rx="4" ry="5.5" fill="#1d1630" />
      <ellipse cx="39" cy="27" rx="4" ry="5.5" fill="#1d1630" />
      <ellipse cx="32" cy="38" rx="3.5" ry="4.5" fill="#1d1630" />
    </svg>
  );
}

export function Moon({ size = 56, className }: P) {
  return (
    <svg {...svg(size, "0 0 64 64", className)}>
      <circle cx="32" cy="32" r="22" fill="#ffd166" opacity=".16" />
      <path fill="#ffe29a" d="M40 8a24 24 0 1 0 16 38A20 20 0 0 1 40 8Z" />
    </svg>
  );
}

/** Sarokpók-háló: a jobb felső sarokba illik, a szülő `position: relative`. */
export function WebCorner({ size = 96, className }: P) {
  return (
    <svg {...svg(size, "0 0 96 96", className)} fill="none" stroke="#b8a9d9" strokeWidth="1.3" strokeLinecap="round" opacity=".55">
      <path d="M96 0 0 0M96 0 96 96M96 0 28 68M96 0 58 88M96 0 4 40" />
      <path d="M84 0c0 8-4 12-12 12M96 12c-8 0-12 4-12 12" />
      <path d="M68 0c0 16-8 24-24 24M96 28c-16 0-24 8-24 24" />
      <path d="M52 0c0 24-12 36-36 36M96 44c-24 0-36 12-36 36" />
      <circle cx="30" cy="66" r="3.2" fill="#b8a9d9" stroke="none" />
      <path d="M30 66 36 58M30 66 24 58M30 66 38 66M30 66 22 66" />
    </svg>
  );
}

export function Egg({ size = 44, className, hue = "#f472b6" }: P & { hue?: string }) {
  return (
    <svg {...svg(size, "0 0 64 64", className)}>
      <path d="M32 6C20 6 10 26 10 40a22 22 0 0 0 44 0C54 26 44 6 32 6Z" fill={hue} />
      <path d="M11 36c6 4 10-4 16 0s10-4 16 0 8-4 10 0v4c-2-4-6 4-10 0s-10 4-16 0-10 4-16 0Z" fill="#fff7d6" />
      <circle cx="24" cy="23" r="3" fill="#fff7d6" /><circle cx="40" cy="23" r="3" fill="#fff7d6" />
      <path d="M14 48c6 4 10-2 16 0s10-2 20 0" stroke="#fff7d6" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function Bunny({ size = 52, className }: P) {
  return (
    <svg {...svg(size, "0 0 64 64", className)}>
      <ellipse cx="23" cy="16" rx="6" ry="14" fill="#fdf2f8" stroke="#f9a8d4" strokeWidth="2" />
      <ellipse cx="41" cy="16" rx="6" ry="14" fill="#fdf2f8" stroke="#f9a8d4" strokeWidth="2" />
      <ellipse cx="23" cy="17" rx="2.6" ry="9" fill="#f9a8d4" /><ellipse cx="41" cy="17" rx="2.6" ry="9" fill="#f9a8d4" />
      <ellipse cx="32" cy="43" rx="19" ry="17" fill="#fdf2f8" stroke="#f9a8d4" strokeWidth="2" />
      <circle cx="25" cy="40" r="2.4" fill="#3b2f2f" /><circle cx="39" cy="40" r="2.4" fill="#3b2f2f" />
      <path d="M29.5 46h5l-2.5 3Z" fill="#f472b6" />
      <path d="M32 49v3M28 53c2 2 6 2 8 0" stroke="#3b2f2f" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function Flower({ size = 40, className }: P) {
  return (
    <svg {...svg(size, "0 0 64 64", className)}>
      {[0, 72, 144, 216, 288].map((a) => <ellipse key={a} cx="32" cy="17" rx="9" ry="13" fill="#f9a8d4" transform={`rotate(${a} 32 32)`} />)}
      <circle cx="32" cy="32" r="8" fill="#fde047" />
    </svg>
  );
}

/** Az alsó tabsáv ikonjai a téma szerint (emoji: nincs külső fájl, offline is működik). */
export const TAB_ICONS = {
  halloween: { main: "🎃", people: "👻", guide: "📖" },
  easter: { main: "🥚", people: "🐰", guide: "📖" },
} as const;

/** Kis márkajelzés a felső sávba (tök / tojás). */
export function BrandMark({ type, size = 26 }: { type?: ThemeType; size?: number }) {
  return type === "easter" ? <Egg size={size} /> : <Pumpkin size={size} />;
}

/**
 * Főoldali / eseményoldali fejléc a téma díszeivel. A díszek csak vizuálisak (aria-hidden), a szöveg a h1.
 */
export function ThemeHero({ type = "halloween", title, subtitle, children }: { type?: ThemeType; title: string; subtitle?: string; children?: ReactNode }) {
  const easter = type === "easter";
  return (
    <header className={`hero ${easter ? "hero-easter" : "hero-halloween"}`}>
      {easter ? (
        <>
          <Flower className="decor d1" size={34} /><Egg className="decor d2 float" size={46} /><Bunny className="decor d3" size={58} />
        </>
      ) : (
        <>
          <WebCorner className="decor web" /><Moon className="decor d1" size={52} /><Bat className="decor d2 float" size={40} /><Pumpkin className="decor d3" size={62} /><Ghost className="decor d4 float" size={38} />
        </>
      )}
      <div className="hero-text">
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
      </div>
    </header>
  );
}

/** Üres állapotok kedves illusztrációja (pl. nincs fotó / jelentkező / esemény). */
export function EmptyArt({ type = "halloween" }: { type?: ThemeType }) {
  return <div className="empty-art" aria-hidden>{type === "easter" ? <Egg size={56} /> : <Ghost size={56} className="float" />}</div>;
}
