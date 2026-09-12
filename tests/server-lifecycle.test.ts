import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

function message(child: ChildProcess, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onMessage = (value: any) => {
      if (value.type === type) { cleanup(); resolve(value); }
    };
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`Worker exited (${code}) before ${type}`)); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

for (const finishRequest of [true, false]) {
  test(`server shutdown ${finishRequest ? 'drains accepted requests before exiting' : 'forces exit after the deadline'}`, { timeout: 15_000 }, async t => {
    const child = fork(fileURLToPath(new URL('./fixtures/shutdown-worker.mjs', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, SHUTDOWN_TEST_DEADLINE_MS: finishRequest ? '5000' : '100' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let diagnostics = '';
    child.stdout?.on('data', chunk => { diagnostics += String(chunk); });
    child.stderr?.on('data', chunk => { diagnostics += String(chunk); });
    const exited = once(child, 'exit');
    const { port } = await message(child, 'listening');
    const started = message(child, 'request-started');
    const response = fetch(`http://127.0.0.1:${port}/work`, { signal: AbortSignal.timeout(10_000) })
      .then(async value => ({ body: await value.text(), error: null }))
      .catch(error => ({ body: null, error }));
    await started;
    const draining = message(child, 'draining');
    if (process.platform === 'win32') child.send({ type: 'shutdown' });
    else child.kill('SIGTERM');
    await draining;
    if (finishRequest) {
      await assert.rejects(fetch(`http://127.0.0.1:${port}/new`, { signal: AbortSignal.timeout(1000) }));
      child.send({ type: 'release' });
      assert.deepEqual(await response, { body: 'request completed', error: null });
      assert.equal((await exited)[0], 0, diagnostics);
    } else {
      assert.equal((await exited)[0], 1, diagnostics);
      assert.ok((await response).error);
      assert.match(diagnostics, /shutdown_timeout/);
    }
  });
}
