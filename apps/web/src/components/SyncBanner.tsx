import { useState } from "react";
import { fmtTime } from "../format";
import { useOnline } from "../hooks";
import { discardItem, retryItem, summarize, syncNow, useQueue } from "../offline/queue";
import { Banner, Button, Sheet } from "./ui";

/** Offline / szinkron állapot: mennyi vár, hibák, utolsó szinkron, kézi szinkron gomb. */
export function SyncBanner() {
  const q = useQueue();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const s = summarize(q.items);
  const pending = q.items.length;
  return (
    <>
      {!online && <Banner kind="warn" title="Nincs internetkapcsolat">Az alkalmazás offline is használható: a teljesítések és a fotók helyben mentődnek, és kapcsolat után szinkronizálódnak.</Banner>}
      {pending > 0 && (
        <Banner kind={s.errors ? "error" : "warn"} title="Szinkronizálásra vár">
          <p style={{ margin: "4px 0" }}>
            {s.checkins} teljesítés és {s.photos} fotó vár szinkronizálásra. Ne töröld az alkalmazás/webhely adatait, amíg ez az üzenet látszik.
            {s.errors > 0 && ` ${s.errors} elem hibás.`}
          </p>
          {q.lastError && <p className="error-text">{q.lastError}</p>}
          <div className="row">
            <Button small onClick={() => void syncNow({ manual: true })} disabled={q.syncing || !online}>{q.syncing ? "Szinkronizálás…" : "Szinkronizálás most"}</Button>
            <Button small variant="secondary" onClick={() => setOpen(true)}>Részletek</Button>
          </div>
          {q.lastSyncAt && <p className="muted" style={{ margin: "6px 0 0" }}>Utolsó sikeres szinkron: {fmtTime(q.lastSyncAt)}</p>}
        </Banner>
      )}
      {open && (
        <Sheet title="Szinkronizálási sor" onClose={() => setOpen(false)}>
          <ul className="list">
            {q.items.map((i) => (
              <li key={i.id}>
                <div style={{ padding: 12 }}>
                  <b>{i.type === "checkin" ? "Teljesítés" : "Fotó"}</b> · {fmtTime(i.capturedAt)} ·{" "}
                  {i.status === "error" ? <span className="badge danger">Hiba</span> : <span className="badge warn">Vár</span>}
                  {i.error && <p className="error-text">{i.error}</p>}
                  <div className="row">
                    {i.status === "error" && <Button small onClick={() => void retryItem(i.id)}>Újra</Button>}
                    <Button small variant="danger" onClick={() => { if (confirm("Biztosan elveted ezt az elemet? A művelet nem vonható vissza.")) void discardItem(i.id); }}>Elvetés</Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
    </>
  );
}
