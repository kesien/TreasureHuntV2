import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";
import { Loading } from "./ui";
import type { Marker as M } from "./MapViewImpl";

export type Marker = M;
// A térképkönyvtár nagy: csak akkor töltjük be, amikor térkép látszik (gyorsabb első betöltés mobilon).
const Impl = lazy(() => import("./MapViewImpl").then((m) => ({ default: m.MapView })));
export function MapView(props: ComponentProps<typeof Impl>) {
  return <Suspense fallback={<Loading text="Térkép betöltése…" />}><Impl {...props} /></Suspense>;
}
