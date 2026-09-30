import type { Server } from 'node:http';

/** Drain accepted requests, including payment settlement, before stopping. */
export function installShutdownHandlers(server: Server, timeoutMs: number): void {
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ event: 'shutdown_started', signal, timeoutMs }));
    const deadline = setTimeout(() => {
      console.error(JSON.stringify({ event: 'shutdown_timeout', timeoutMs }));
      server.closeAllConnections();
      process.exit(1);
    }, timeoutMs);
    deadline.unref();
    // Node 24 closes idle keep-alive connections and waits for active responses.
    server.close(error => {
      clearTimeout(deadline);
      console.log(JSON.stringify({ event: 'shutdown_complete', ok: !error }));
      process.exit(error ? 1 : 0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
