import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setCsrf } from "../api";
import { Button, ErrorText, Field, Input, useAction } from "../components/ui";
import { useAccessMe } from "../session";

/** PIN módosítása belépve; sikeres csere után minden eszköz sessionje (ez is) érvénytelen lesz. */
export function PinChange() {
  const [pin, setPin] = useState(""); const [again, setAgain] = useState("");
  const a = useAction();
  const nav = useNavigate();
  const { refresh } = useAccessMe();
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>PIN módosítása</h2>
      <p className="muted">A módosítás után minden eszközön újra be kell lépni az új PIN-nel.</p>
      <Field label="Új PIN (6 számjegy)"><Input inputMode="numeric" pattern="\d{6}" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} autoComplete="new-password" type="password" /></Field>
      <Field label="Új PIN még egyszer"><Input inputMode="numeric" pattern="\d{6}" maxLength={6} value={again} onChange={(e) => setAgain(e.target.value.replace(/\D/g, ""))} autoComplete="new-password" type="password" /></Field>
      <ErrorText error={a.error} />
      <Button variant="secondary" disabled={a.busy || pin.length !== 6 || pin !== again} onClick={() => void a.run(async () => {
        await api("/api/access/change-pin", { body: { newPin: pin, newPinAgain: again } });
        setCsrf(null); await refresh(); nav("/belepes");
      })}>PIN módosítása</Button>
      {pin.length === 6 && again.length === 6 && pin !== again && <p className="error-text">A két PIN nem egyezik.</p>}
    </div>
  );
}
