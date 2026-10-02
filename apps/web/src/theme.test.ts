// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Egy szelektor n-edik blokkjának CSS-változói (media query-n belül is). */
function vars(selector: string, nth = 0): Record<string, string> {
  const re = new RegExp(escapeRe(selector) + "\\s*\\{([^}]*)\\}", "g");
  const m = [...css.matchAll(re)][nth];
  if (!m) throw new Error("nincs ilyen blokk: " + selector);
  return Object.fromEntries([...m[1]!.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((x) => [x[1]!, x[2]!.trim()]));
}
function lum(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

const base = vars(":root");
const themes: Array<{ name: string; v: Record<string, string> }> = [
  { name: "alap (világos)", v: base },
  { name: "alap (sötét eszköz)", v: { ...base, ...vars(":root:not([data-theme])") } },
  { name: "halloween", v: { ...base, ...vars(':root[data-theme="halloween"]') } },
  { name: "húsvét (világos)", v: { ...base, ...vars(':root[data-theme="easter"]', 0) } },
  { name: "húsvét (sötét eszköz)", v: { ...base, ...vars(':root[data-theme="easter"]', 1) } },
];

describe.each(themes)("kontraszt: $name", ({ v }) => {
  const hex = (k: string) => {
    const x = v[k];
    if (!x || !/^#[0-9a-f]{6}$/i.test(x)) throw new Error(`--${k} nem hex: ${x}`);
    return x;
  };
  it("szöveg a háttéren és a felületen (AA, 4.5:1)", () => {
    for (const bg of ["bg", "surface"]) {
      expect(ratio(hex("text"), hex(bg)), `text/${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(hex("muted"), hex(bg)), `muted/${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("gombfelirat az elsődleges, veszély- és ok-színen (4.5:1)", () => {
    expect(ratio(hex("primary-text"), hex("primary")), "primary").toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex("on-danger"), hex("danger")), "danger").toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex("on-ok"), hex("ok")), "ok").toBeGreaterThanOrEqual(4.5);
  });
  it("hivatkozás, kiemelés és állapotszínek szövegként a felületen (4.5:1)", () => {
    for (const k of ["primary", "accent", "ok", "warn", "danger"]) expect(ratio(hex(k), hex("surface")), k).toBeGreaterThanOrEqual(4.5);
  });
  it("a fókuszkeret jól látszik (3:1)", () => {
    expect(ratio(hex("focus"), hex("bg"))).toBeGreaterThanOrEqual(3);
    expect(ratio(hex("focus"), hex("surface"))).toBeGreaterThanOrEqual(3);
  });
});
