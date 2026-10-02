import { rm } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";

/** Fotófájl abszolút útvonala a PHOTO_DIR-en belül (path traversal ellen védve). */
export function photoPath(cfg: Config, key: string): string {
  const p = path.resolve(cfg.PHOTO_DIR, key);
  if (!p.startsWith(path.resolve(cfg.PHOTO_DIR) + path.sep)) throw new Error("path traversal");
  return p;
}

export async function removeFilesFor(cfg: Config, rows: Array<{ fileKey: string | null; thumbKey: string | null }>) {
  for (const r of rows) for (const k of [r.fileKey, r.thumbKey]) if (k) await rm(photoPath(cfg, k), { force: true });
}
