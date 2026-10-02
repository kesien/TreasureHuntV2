// Magyar nyelvű, mobilbarát HTML + plain text sablonok. Egy közös szerkezetből renderelünk mindkettőt.

export interface EmailContent {
  subject: string;
  paragraphs: string[];
  details?: Array<[string, string]>; // címke, érték
  button?: { label: string; url: string };
  linkText?: string; // szöveges link (a gomb mellett)
  footer?: string;
}

export type EmailType =
  | "application_received" | "approval" | "rejection" | "t24" | "event_started" | "station_warning"
  | "station_removal" | "withdrawal" | "event_cancellation" | "host_final_counts" | "password_reset"
  | "admin_invitation" | "pin_recovery" | "email_change_confirm" | "admin_notice";

/** Ezek a típusok linket/PIN-t tartalmaznak: sikeres küldés után a törzs törlődik. */
export const SENSITIVE_TYPES: ReadonlySet<EmailType> = new Set(["approval", "password_reset", "admin_invitation", "pin_recovery", "email_change_confirm"]);

export interface TemplateData {
  eventName?: string;
  role?: "team" | "host";
  recipientName?: string;
  organizerContact?: string;
  plannedStart?: string; // már formázott, magyar
  modificationDeadline?: string;
  registrationClose?: string;
  link?: string;
  pin?: string;
  reason?: string;
  stationNumber?: number;
  children?: number;
  adults?: number;
  message?: string;
  subjectName?: string;
}

const who = (d: TemplateData) => (d.role === "host" ? "állomás-jelentkezésed" : "csapat-jelentkezésed");

export function buildContent(type: EmailType, d: TemplateData): EmailContent {
  const ev = d.eventName ?? "az esemény";
  const contact = d.organizerContact ? `Kérdés esetén a szervezők elérhetősége: ${d.organizerContact}` : undefined;
  switch (type) {
    case "application_received":
      return {
        subject: `Jelentkezés megérkezett – ${ev}`,
        paragraphs: [
          `Köszönjük, megkaptuk a ${who(d)}. Jelenleg Függőben állapotú; a szervezők hamarosan elbírálják.`,
          `A belépéshez szükséges link és PIN csak a jóváhagyás után érkezik.`,
          `A módosítási határidőig (${d.modificationDeadline ?? "lásd az esemény oldalát"}) a belépés után módosíthatod az adataidat, illetve visszaléphetsz.`,
        ],
        details: [["Esemény", ev], ["Esemény kezdete", d.plannedStart ?? "–"]],
        footer: contact,
      };
    case "approval":
      return {
        subject: `Jóváhagyva – ${ev}`,
        paragraphs: [
          `Örömmel jelezzük, hogy a ${who(d)} jóváhagyásra került.`,
          `Belépés: nyisd meg a linket, majd add meg a PIN kódot. Ugyanezzel a hozzáféréssel több telefonról is beléphetsz.`,
          `A PIN kódot ne oszd meg külső személlyel. A helyszínek az esemény előtt 24 órával jelennek meg.`,
        ],
        details: [["PIN", d.pin ?? "–"], ["Módosítási határidő", d.modificationDeadline ?? "–"], ["Esemény kezdete", d.plannedStart ?? "–"]],
        button: d.link ? { label: "Belépés a felületre", url: d.link } : undefined,
        linkText: d.link,
        footer: contact,
      };
    case "rejection":
      return {
        subject: `Jelentkezés elutasítva – ${ev}`,
        paragraphs: [`Sajnáljuk, de a ${who(d)} nem került elfogadásra.`, `Indoklás: ${d.reason ?? "–"}`],
        footer: contact,
      };
    case "t24":
      return {
        subject: `Holnap indul: ${ev}`,
        paragraphs: [`Az esemény holnap lesz. A helyszínek mostantól elérhetők a felületen.`],
        details: [["Esemény kezdete", d.plannedStart ?? "–"]],
        footer: contact,
      };
    case "event_started":
      return { subject: `Elindult: ${ev}`, paragraphs: [`Az esemény elindult. Jó szórakozást!`], footer: contact };
    case "station_warning":
      return {
        subject: `Figyelmeztetés – Állomás #${d.stationNumber ?? "?"}`,
        paragraphs: [d.message ?? `Az állomáson valószínűleg elfogyott az ajándék.`],
        footer: contact,
      };
    case "station_removal":
      return {
        subject: `Állomás eltávolítva – ${ev}`,
        paragraphs: [`Az Állomás #${d.stationNumber ?? "?"} kikerült az eseményből, ezért már nem kell felkeresni.`, ...(d.reason ? [`Ok: ${d.reason}`] : [])],
        footer: contact,
      };
    case "withdrawal":
      return {
        subject: `Visszalépés rögzítve – ${ev}`,
        paragraphs: [d.message ?? `A visszalépést rögzítettük, a hozzáférés megszűnt.`],
        details: d.subjectName ? [["Érintett", d.subjectName]] : undefined,
        footer: contact,
      };
    case "event_cancellation":
      return {
        subject: `Az esemény elmarad – ${ev}`,
        paragraphs: [`Sajnálattal értesítünk, hogy az esemény elmarad.`, `Ok: ${d.reason ?? "–"}`, `A hozzáférési linkek érvénytelenek.`],
        footer: contact,
      };
    case "host_final_counts":
      return {
        subject: `Végleges létszámok – ${ev}`,
        paragraphs: [`A módosítási határidő lejárt. Az eseményen a következő létszámra számíthattok:`],
        details: [["Gyermek", String(d.children ?? 0)], ["Felnőtt", String(d.adults ?? 0)], ["Összesen", String((d.children ?? 0) + (d.adults ?? 0))]],
        footer: contact,
      };
    case "password_reset":
      return {
        subject: "Jelszó-visszaállítás",
        paragraphs: [`Jelszó-visszaállítást kértek a fiókodhoz. A link 30 percig érvényes és egyszer használható.`, `Ha nem te kérted, hagyd figyelmen kívül.`],
        button: d.link ? { label: "Új jelszó megadása", url: d.link } : undefined,
        linkText: d.link,
      };
    case "admin_invitation":
      return {
        subject: "Meghívó az adminisztrációs felületre",
        paragraphs: [`Meghívtak az adminisztrátorok közé. A link 72 óráig érvényes és egyszer használható; ott állíthatod be a jelszavad és a kétlépcsős azonosítást.`],
        button: d.link ? { label: "Fiók aktiválása", url: d.link } : undefined,
        linkText: d.link,
      };
    case "pin_recovery":
      return {
        subject: `PIN visszaállítása – ${ev}`,
        paragraphs: [`PIN-visszaállítást kértek${d.subjectName ? ` ehhez: ${d.subjectName}` : ""}. A link rövid ideig érvényes és egyszer használható. Az új PIN megadása után minden eszközön újra be kell lépni.`, `Ha nem te kérted, hagyd figyelmen kívül.`],
        button: d.link ? { label: "Új PIN megadása", url: d.link } : undefined,
        linkText: d.link,
      };
    case "email_change_confirm":
      return {
        subject: "E-mail cím megerősítése",
        paragraphs: [`Erősítsd meg, hogy ez az új e-mail címed ehhez a jelentkezéshez. A megerősítésig a régi cím marad érvényes.`],
        button: d.link ? { label: "E-mail cím megerősítése", url: d.link } : undefined,
        linkText: d.link,
      };
    case "admin_notice":
      return { subject: d.subjectName ?? "Rendszerértesítés", paragraphs: [d.message ?? ""] };
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function render(c: EmailContent): { html: string; text: string } {
  const details = c.details?.length
    ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0">${c.details
        .map(([k, v]) => `<tr><td style="padding:6px 0;color:#555">${esc(k)}</td><td style="padding:6px 0;font-weight:600;text-align:right">${esc(v)}</td></tr>`)
        .join("")}</table>`
    : "";
  const button = c.button
    ? `<p style="margin:24px 0"><a href="${esc(c.button.url)}" style="background:#c2410c;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${esc(c.button.label)}</a></p>`
    : "";
  const linkText = c.linkText ? `<p style="font-size:13px;color:#555;word-break:break-all">Ha a gomb nem működik, másold be ezt a linket: ${esc(c.linkText)}</p>` : "";
  const html = `<!doctype html><html lang="hu"><body style="margin:0;background:#f5f5f4;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:16px"><div style="background:#fff;border-radius:12px;padding:24px;color:#1c1917;line-height:1.5">
<h1 style="font-size:20px;margin:0 0 16px">${esc(c.subject)}</h1>
${c.paragraphs.map((p) => `<p style="margin:0 0 12px">${esc(p)}</p>`).join("")}${details}${button}${linkText}
${c.footer ? `<p style="font-size:13px;color:#555;margin-top:20px">${esc(c.footer)}</p>` : ""}
</div></div></body></html>`;
  const text = [
    c.subject, "", ...c.paragraphs, "",
    ...(c.details?.map(([k, v]) => `${k}: ${v}`) ?? []),
    ...(c.button ? ["", `${c.button.label}: ${c.button.url}`] : []),
    ...(c.footer ? ["", c.footer] : []),
  ].join("\n");
  return { html, text };
}
