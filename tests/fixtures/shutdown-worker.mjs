import { createServer } from 'node:http';
import { installShutdownHandlers } from '../../src/server-lifecycle.ts';

let activeResponse;
const server = createServer((_req, res) => {
  activeResponse = res;
  process.send({ type: 'request-started' });
});
installShutdownHandlers(server, Number(process.env.SHUTDOWN_TEST_DEADLINE_MS));
process.on('SIGTERM', () => process.send({ type: 'draining' }));
server.listen(0, '127.0.0.1', () => {
  process.send({ type: 'listening', port: server.address().port });
});
process.on('message', message => {
  if (message.type === 'shutdown') {
    // Windows cannot deliver POSIX signals; exercise the same event listener.
    process.emit('SIGTERM');
  } else if (message.type === 'release') {
    activeResponse.end('request completed');
  }
});
