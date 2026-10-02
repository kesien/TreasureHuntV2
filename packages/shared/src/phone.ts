/** Magyar telefonszám normalizálása +36XXXXXXXXX formára; érvénytelenre null. */
export function normalizeHuPhone(input: string): string | null {
  let s = input.replace(/[\s\-().\/]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("0036")) s = s.slice(4);
  else if (s.startsWith("36")) s = s.slice(2);
  else if (s.startsWith("06")) s = s.slice(2);
  else return null;
  if (!/^\d{8,9}$/.test(s)) return null;
  // Budapest (1-es körzet): 8 számjegy; egyébként 9 számjegy
  if (s.startsWith("1")) return s.length === 8 ? `+36${s}` : null;
  return s.length === 9 ? `+36${s}` : null;
}
