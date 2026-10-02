import { Suspense, lazy, useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Loading } from "./components/ui";
import { ToastProvider } from "./hooks";
import { initSync } from "./offline/queue";
import { AccessProvider, AdminProvider, RequireAccess } from "./session";
import { GuidePage } from "./pages/Guide";
import { HostApp } from "./pages/host/HostApp";
import { EmailConfirm, EventPage, Home, HostApply, Login, PinRecoveryComplete, PinRecoveryRequest, TeamApply } from "./pages/public/Public";
import { TeamApp } from "./pages/team/TeamApp";

// Az admin felület külön csomagba kerül, a résztvevői (mobil) betöltést nem terheli
const AdminArea = lazy(() => import("./pages/admin/AdminArea"));

export function App() {
  useEffect(() => initSync(), []); // offline sor automatikus szinkronja
  return (
    <ToastProvider>
      <AccessProvider>
        <AdminProvider>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/esemeny/:id" element={<EventPage />} />
            <Route path="/esemeny/:id/csapat" element={<TeamApply />} />
            <Route path="/esemeny/:id/host" element={<HostApply />} />
            <Route path="/belepes" element={<Login />} />
            <Route path="/belepes/:token" element={<Login />} />
            <Route path="/pin-visszaallitas" element={<PinRecoveryRequest />} />
            <Route path="/pin-visszaallitas/:token" element={<PinRecoveryComplete />} />
            <Route path="/email-megerosites/:token" element={<EmailConfirm />} />
            <Route path="/utmutato" element={<GuidePage />} />
            <Route path="/csapat/*" element={<RequireAccess role="team"><TeamApp /></RequireAccess>} />
            <Route path="/host/*" element={<RequireAccess role="host"><HostApp /></RequireAccess>} />
            <Route path="/admin/*" element={<Suspense fallback={<div className="page"><Loading /></div>}><AdminArea /></Suspense>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AdminProvider>
      </AccessProvider>
    </ToastProvider>
  );
}
