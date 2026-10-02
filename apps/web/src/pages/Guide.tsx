import { Link } from "react-router-dom";
import { Banner } from "../components/ui";

/** Android / iPhone helymeghatározás-segítség: a GPS-hibaüzenetekből és az útmutatóból is elérhető. */
export function GpsHelp({ kind }: { kind?: "denied" | "unavailable" | "timeout" | "unsupported" | "inaccurate" | "too_far" }) {
  return (
    <div className="stack">
      {kind === "denied" && <Banner kind="error" title="A helymeghatározás nincs engedélyezve">A „Megérkeztünk” gombhoz engedélyezned kell a helyadatok használatát ennél az oldalnál.</Banner>}
      {kind === "inaccurate" && <Banner kind="warn" title="Pontatlan a GPS">Menj nyílt, szabad ég alatti helyre, várj néhány másodpercet, majd próbáld újra.</Banner>}
      {kind === "too_far" && <Banner kind="warn" title="Túl messze vagytok az állomástól">Menjetek közelebb az állomáshoz, majd próbáljátok újra.</Banner>}
      <details open={kind === "denied" || kind === "unavailable"}>
        <summary><b>Android (Chrome)</b></summary>
        <ol>
          <li>Kapcsold be a telefon helymeghatározását (gyorsbeállítások → Hely).</li>
          <li>Chrome → ⋮ menü → Beállítások → Webhelybeállítások → Hely → engedélyezd.</li>
          <li>Vagy: koppints a címsor melletti zár/csúszka ikonra → Engedélyek → Hely → Engedélyezés.</li>
          <li>Ha telepítetted az alkalmazást: Beállítások → Alkalmazások → Kincsvadászat → Engedélyek → Hely → „Csak az alkalmazás használata közben”. Kapcsold be a „Pontos hely” opciót.</li>
        </ol>
      </details>
      <details open={kind === "denied" || kind === "unavailable"}>
        <summary><b>iPhone (Safari)</b></summary>
        <ol>
          <li>Beállítások → Adatvédelem és biztonság → Helymeghatározás → kapcsold be.</li>
          <li>Ugyanitt: Safari webhelyek → „Alkalmazás használata közben” (vagy „Rákérdezés”).</li>
          <li>Safariban: címsor „aA” gomb → Webhelybeállítások → Hely → Engedélyezés.</li>
          <li>Kapcsold be a „Pontos hely” beállítást is.</li>
        </ol>
      </details>
      <details open={kind === "inaccurate"}>
        <summary><b>Ha pontatlan a GPS</b></summary>
        <ul>
          <li>Menj ki szabad ég alá, ne épületen belül próbáld.</li>
          <li>Várj 10–20 másodpercet a pontos helyzet rögzüléséhez.</li>
          <li>Kapcsold ki a repülő üzemmódot és a takarékos módot.</li>
          <li>Indítsd újra a böngészőt, ha továbbra sem javul.</li>
        </ul>
      </details>
    </div>
  );
}

export function GuidePage() {
  return (
    <div className="page">
      <h1>Útmutató</h1>
      <h2>Csapatoknak</h2>
      <ol>
        <li><b>Jelentkezés</b> – az esemény oldalán add meg a csapatod adatait (legalább egy gyermek kötelező).</li>
        <li><b>Jóváhagyás</b> – a szervezők elbírálják; jóváhagyás után e-mailben érkezik a belépési link és a PIN.</li>
        <li><b>Belépés</b> – nyisd meg a linket, add meg a PIN-t. Ugyanazzal több telefonról is beléphetsz; a kilépés csak az adott telefont érinti.</li>
        <li><b>Helyszínek</b> – az esemény előtt 24 órával jelennek meg az állomások (Állomás #N).</li>
        <li><b>Navigáció</b> – az állomás lapján a „Navigáció” gomb a telefonod térképalkalmazását nyitja meg.</li>
        <li><b>GPS engedély</b> – a „Megérkeztünk” gombhoz engedélyezd a helyadatokat (lásd lent).</li>
        <li><b>Megérkeztünk</b> – az állomás közelében koppints rá; a rendszer ellenőrzi, hogy a közelben vagytok-e.</li>
        <li><b>Fotó</b> – becsekkolás után állomásonként legfeljebb 5 fotót tölthettek fel.</li>
        <li><b>Elfogyott ajándék</b> – becsekkolás után jelezhetitek, ha nincs több ajándék. Ez nem vonja ki az állomást a feladatból.</li>
        <li><b>Offline működés</b> – ha nincs net, a teljesítés és a fotó a telefonon marad „Szinkronizálásra vár” jelöléssel.</li>
        <li><b>Szinkronizálás</b> – kapcsolat esetén automatikus; a „Szinkronizálás most” gombbal kézzel is indítható. iPhone-on előfordulhat, hogy meg kell nyitnod az alkalmazást a szinkronhoz. Ne töröld az alkalmazás/webhely adatait, amíg van szinkronra váró elem.</li>
        <li><b>GPS hibakeresés</b> – lásd lent.</li>
      </ol>
      <h2>Házigazdáknak (host)</h2>
      <ol>
        <li><b>Ajándék előkészítése</b> – a csapatlétszám (gyermek/felnőtt) a módosítási határidő után végleges; erről e-mailt kaptok.</li>
        <li><b>Felvételi mód</b> – „az ajándék kint van” vagy „csengess / menj be”. Az esemény közben ez már nem módosítható.</li>
        <li><b>Mit látsz az esemény alatt</b> – a hozzád érkezett csapatok nevét, létszámát és az érkezés idejét; tagneveket nem.</li>
        <li><b>Elfogyás jelzése</b> – az „Elfogyott” gombbal jelezheted (megjegyzéssel); ha 3 csapat jelzi, figyelmeztetést látsz.</li>
        <li><b>Újratöltés</b> – az „Újra feltöltöttem” gombbal visszaállítod az állomást aktívra.</li>
      </ol>
      <h2>Helymeghatározás</h2>
      <GpsHelp />
      <h2>Offline és hálózat</h2>
      <ul>
        <li>Offline állapotban a „Megérkeztünk” a telefon helyi ellenőrzésével működik, a szerver később újraellenőrzi.</li>
        <li>Ha egy elem hibás, a „Szinkronizálási sor” részleteiben újrapróbálhatod vagy elvetheted.</li>
        <li>Ha egy állomást közben töröltek, az adminisztrátor elbírálja a teljesítést és a fotót.</li>
      </ul>
      <p><Link to="/">Vissza a főoldalra</Link></p>
    </div>
  );
}
