import { describe, expect, it } from "vitest";
import {
  validatePin, normalizeHuPhone, distanceMeters, canTransition, revealAt,
  validateEventDates, locationsRevealed,
} from "./index.js";

describe("PIN", () => {
  it.each(["123456", "111111", "000000", "654321", "121212", "123123"])("elutasítja: %s", (p) => {
    expect(validatePin(p).ok).toBe(false);
  });
  it("elfogad egy jó PIN-t", () => expect(validatePin("481952").ok).toBe(true));
  it("formátumhiba", () => {
    expect(validatePin("12345")).toEqual({ ok: false, reason: "format" });
    expect(validatePin("12345a")).toEqual({ ok: false, reason: "format" });
  });
});

describe("telefon", () => {
  it.each([
    ["+36 30 123 4567", "+36301234567"],
    ["0630 123 4567", "+36301234567"],
    ["06-1-234-5678", "+3612345678"],
    ["0036301234567", "+36301234567"],
  ])("%s", (i, o) => expect(normalizeHuPhone(i)).toBe(o));
  it("érvénytelen", () => {
    expect(normalizeHuPhone("12345")).toBeNull();
    expect(normalizeHuPhone("+49 30 123456")).toBeNull();
  });
});

describe("geo", () => {
  it("~111 m / 0.001° szélesség", () => {
    const d = distanceMeters(47.5, 19.0, 47.501, 19.0);
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });
});

describe("event lifecycle", () => {
  it("átmenetek", () => {
    expect(canTransition("draft", "registration_open")).toBe(true);
    expect(canTransition("closed", "active")).toBe(false);
    expect(canTransition("cancelled", "draft")).toBe(false);
  });
  const ps = new Date("2026-10-31T16:00:00Z");
  it("T−24 a tervezett kezdésből", () => {
    expect(revealAt(ps, null).toISOString()).toBe("2026-10-30T16:00:00.000Z");
  });
  it("korábbi indítás azonnal felfed", () => {
    const early = new Date("2026-10-29T10:00:00Z");
    expect(locationsRevealed(new Date("2026-10-29T10:01:00Z"), ps, early, "active")).toBe(true);
  });
  it("T−24 előtt rejtett", () => {
    expect(locationsRevealed(new Date("2026-10-30T15:00:00Z"), ps, null, "preparation")).toBe(false);
    expect(locationsRevealed(new Date("2026-10-30T16:00:00Z"), ps, null, "preparation")).toBe(true);
  });
  it("dátumsorrend", () => {
    const d = (s: string) => new Date(s);
    expect(
      validateEventDates({
        registrationStart: d("2026-10-01"), registrationClose: d("2026-10-20"),
        modificationDeadline: d("2026-10-25"), plannedStart: ps, plannedEnd: d("2026-10-31T20:00:00Z"),
      }),
    ).toEqual([]);
    expect(
      validateEventDates({
        registrationStart: d("2026-10-21"), registrationClose: d("2026-10-20"),
        modificationDeadline: d("2026-11-25"), plannedStart: ps, plannedEnd: d("2026-10-30"),
      }).length,
    ).toBe(3);
  });
});
