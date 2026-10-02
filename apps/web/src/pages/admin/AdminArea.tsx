import { Route, Routes, useSearchParams } from "react-router-dom";
import { RequireAdmin } from "../../session";
import { AdminActivate, AdminLogin, AdminResetComplete, AdminResetRequest } from "./AdminAuth";
import { Admins, Audit, DataRequests, Notifications, Photos, Reviews, Settings, System } from "./AdminMisc";
import { AdminLayout } from "./AdminLayout";
import { Dashboard } from "./Dashboard";
import { Events } from "./Events";
import { People } from "./People";
import { Stations } from "./Stations";

function AdminReset() {
  const [sp] = useSearchParams();
  return sp.get("token") ? <AdminResetComplete /> : <AdminResetRequest />;
}

/** Az admin felület összes útvonala egy lusta betöltésű csomagban (a /admin/* alatt). */
export default function AdminArea() {
  return (
    <Routes>
      <Route path="belepes" element={<AdminLogin />} />
      <Route path="activate" element={<AdminActivate />} />
      <Route path="jelszo-visszaallitas" element={<AdminReset />} />
      <Route element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
        <Route index element={<Dashboard />} />
        <Route path="esemenyek" element={<Events />} />
        <Route path="jelentkezok" element={<People />} />
        <Route path="allomasok" element={<Stations />} />
        <Route path="fotok" element={<Photos />} />
        <Route path="ellenorzes" element={<Reviews />} />
        <Route path="ertesitesek" element={<Notifications />} />
        <Route path="naplo" element={<Audit />} />
        <Route path="rendszer" element={<System />} />
        <Route path="adatkezeles" element={<DataRequests />} />
        <Route path="adminok" element={<Admins />} />
        <Route path="beallitasok" element={<Settings />} />
      </Route>
    </Routes>
  );
}
