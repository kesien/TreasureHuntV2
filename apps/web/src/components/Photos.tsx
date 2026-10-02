import { useRef, useState } from "react";
import { api, errMsg, isNetworkError } from "../api";
import { useFetch, useToast } from "../hooks";
import { StorageFullError } from "../offline/db";
import { enqueuePhoto, useQueue } from "../offline/queue";
import { Button, ErrorText, Field, Loading, Select, Sheet, Textarea, useAction, useConfirm } from "./ui";

export interface GalleryPhoto { id: string; thumbUrl: string; url: string; mine: boolean; width: number | null; height: number | null }
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PHOTOS = 5;

/** Kliensoldali előkészítés: nagy képek kicsinyítése (kevesebb adat/tárhely); ha a böngésző nem tudja (pl. HEIC), az eredeti megy. */
export async function prepareImage(file: File): Promise<{ blob: Blob; name: string }> {
  if (file.size > MAX_BYTES) throw new Error("A fájl mérete legfeljebb 20 MB lehet.");
  if (file.size < 1_500_000 || !/^image\/(jpeg|png|webp)$/.test(file.type)) return { blob: file, name: file.name };
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    if (blob && blob.size < file.size) return { blob, name: file.name.replace(/\.\w+$/, "") + ".jpg" };
  } catch { /* az eredeti is megfelel */ }
  return { blob: file, name: file.name };
}

const REASONS: Array<[string, string]> = [
  ["child_privacy", "Gyermek / adatvédelmi probléma"], ["offensive", "Sértő vagy nem megfelelő tartalom"], ["accidental", "Véletlen feltöltés"], ["other", "Egyéb"],
];

export function PhotoGallery({ stationId, role, canUpload, checkedInPending, refreshKey }: {
  stationId: string; role: "team" | "host"; canUpload: boolean; checkedInPending?: boolean; refreshKey?: unknown;
}) {
  const list = useFetch<GalleryPhoto[]>(`/api/access/stations/${stationId}/photos?k=${String(refreshKey ?? "")}`, { cacheKey: `photos-${stationId}` });
  const q = useQueue();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const up = useAction();
  const [view, setView] = useState<GalleryPhoto | null>(null);
  const [reporting, setReporting] = useState<GalleryPhoto | null>(null);
  const { confirm, dialog } = useConfirm();
  const queued = q.items.filter((i) => i.type === "photo" && i.stationId === stationId);
  const mineCount = (list.data?.filter((p) => p.mine).length ?? 0) + queued.length;

  async function onFile(file: File | undefined) {
    if (!file) return;
    await up.run(async () => {
      if (mineCount >= MAX_PHOTOS) throw new Error(`Állomásonként legfeljebb ${MAX_PHOTOS} fotót tölthettek fel.`);
      const { blob, name } = await prepareImage(file);
      const queueOnly = !!checkedInPending; // a becsekkolás még szinkronra vár → a fotó is a sorba megy
      if (!queueOnly) {
        try {
          const form = new FormData();
          form.append("file", blob, name);
          await api(`/api/access/stations/${stationId}/photos`, { form });
          toast("A fotó feltöltve.");
          list.reload();
          return;
        } catch (e) {
          if (!isNetworkError(e)) throw e;
        }
      }
      try {
        await enqueuePhoto(stationId, blob, name);
        toast("A fotó offline mentve, a kapcsolat visszatértekor feltöltjük.");
      } catch (e) {
        if (e instanceof StorageFullError) throw e;
        throw new Error("A fotót nem sikerült elmenteni a telefonon.");
      }
    });
    if (input.current) input.current.value = "";
  }

  async function remove(p: GalleryPhoto) {
    const c = await confirm("Fotó törlése", "Biztosan törlöd ezt a fotót? A művelet nem vonható vissza.", { danger: true, confirmLabel: "Törlés" });
    if (!c.ok) return;
    try { await api(`/api/access/photos/${p.id}`, { method: "DELETE" }); setView(null); list.reload(); } catch (e) { toast(errMsg(e)); }
  }

  return (
    <section aria-label="Fotók">
      <h3>Fotók</h3>
      {list.loading && <Loading />}
      {list.offline && <p className="muted">Offline vagy, a legutóbb betöltött fotók látszanak.</p>}
      <div className="gallery">
        {list.data?.map((p) => (
          <button key={p.id} type="button" className="thumb" onClick={() => setView(p)} aria-label="Fotó megnyitása">
            <img src={p.thumbUrl} alt="Fotó az állomásról" loading="lazy" />
          </button>
        ))}
      </div>
      {queued.length > 0 && <p className="muted">{queued.length} saját fotó vár feltöltésre.</p>}
      {list.data?.length === 0 && queued.length === 0 && <p className="muted">Még nincs fotó ennél az állomásnál.</p>}
      {canUpload && (
        <div className="stack" style={{ marginTop: 8 }}>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
          <Button block onClick={() => input.current?.click()} disabled={up.busy || mineCount >= MAX_PHOTOS}>
            {up.busy ? "Feltöltés…" : `📷 Fotó hozzáadása (${mineCount}/${MAX_PHOTOS})`}
          </Button>
          <p className="muted">Csak olyan fotót tölts fel, amelynek megosztására jogosult vagy. Gyermekekről csak megfelelő hozzájárulással tölts fel képet.</p>
          <ErrorText error={up.error} />
        </div>
      )}
      {view && (
        <Sheet title="Fotó" onClose={() => setView(null)}>
          <img src={view.url} alt="Fotó az állomásról" style={{ width: "100%", borderRadius: 12 }} />
          <div className="row" style={{ marginTop: 12 }}>
            {view.mine && <Button variant="danger" onClick={() => void remove(view)}>Törlés</Button>}
            <Button variant="secondary" onClick={() => { setReporting(view); setView(null); }}>Fotó jelentése</Button>
          </div>
        </Sheet>
      )}
      {reporting && <ReportSheet photo={reporting} onClose={(done) => { setReporting(null); if (done) { toast("Köszönjük, a fotót elrejtettük, és jeleztük az adminisztrátornak."); list.reload(); } }} />}
      {dialog}
    </section>
  );
}

function ReportSheet({ photo, onClose }: { photo: GalleryPhoto; onClose: (done: boolean) => void }) {
  const [reason, setReason] = useState("child_privacy");
  const [text, setText] = useState("");
  const a = useAction();
  return (
    <Sheet title="Fotó jelentése" onClose={() => onClose(false)}>
      <p className="muted">A jelentett fotó azonnal eltűnik a résztvevők elől, az adminisztrátor pedig elbírálja.</p>
      <Field label="Ok"><Select value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
      <Field label="Megjegyzés (nem kötelező)"><Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={500} /></Field>
      <ErrorText error={a.error} />
      <div className="row">
        <Button disabled={a.busy} onClick={() => void a.run(async () => { await api(`/api/access/photos/${photo.id}/report`, { body: { reason, text: text || undefined } }); onClose(true); })}>Jelentés küldése</Button>
        <Button variant="secondary" onClick={() => onClose(false)}>Mégsem</Button>
      </div>
    </Sheet>
  );
}

