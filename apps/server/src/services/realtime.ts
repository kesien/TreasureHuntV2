import type { ServerResponse } from "node:http";

/**
 * Egyszerű SSE-hub. Csatornák: "admin", "event:<id>". Az üzenet csak jelzés ("változott valami"),
 * a kliens újratölti az adatot; így a jogosultságot mindig a normál API ellenőrzi.
 */
export class RealtimeHub {
  private clients = new Map<string, Set<ServerResponse>>();

  subscribe(channel: string, res: ServerResponse) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const set = this.clients.get(channel) ?? new Set();
    set.add(res);
    this.clients.set(channel, set);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    res.on("close", () => {
      clearInterval(ping);
      set.delete(res);
    });
  }

  publish(channel: string, type: string) {
    for (const res of this.clients.get(channel) ?? []) res.write(`event: ${type}\ndata: {}\n\n`);
  }
}
