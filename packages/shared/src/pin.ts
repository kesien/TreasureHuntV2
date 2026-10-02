const TRIVIAL = new Set(["123456", "654321", "012345", "123123", "121212", "112233", "123321", "987654", "098765"]);

export type PinCheck = { ok: true } | { ok: false; reason: "format" | "trivial" };

/** Pontosan 6 számjegy, nem triviális (azonos számjegyek, lépcső, ismert minták). */
export function validatePin(pin: string): PinCheck {
  if (!/^\d{6}$/.test(pin)) return { ok: false, reason: "format" };
  if (TRIVIAL.has(pin)) return { ok: false, reason: "trivial" };
  if (/^(\d)\1{5}$/.test(pin)) return { ok: false, reason: "trivial" };
  const d = [...pin].map(Number);
  const step = (d[1] as number) - (d[0] as number);
  if ((step === 1 || step === -1) && d.every((v, i) => i === 0 || v - (d[i - 1] as number) === step)) {
    return { ok: false, reason: "trivial" };
  }
  if (pin.slice(0, 3) === pin.slice(3)) return { ok: false, reason: "trivial" };
  return { ok: true };
}
