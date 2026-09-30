import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function verifyConsumer(sandbox, version) {
  // Resolve the consumer SDK and wallet implementation from the fresh installation too.
  const require = createRequire(path.join(sandbox, 'package.json'));
  const resolve = specifier => {
    const resolved = realpathSync(require.resolve(specifier));
    assert.ok(resolved.startsWith(realpathSync(path.join(sandbox, 'node_modules')) + path.sep), `Dependency escaped consumer installation: ${specifier}`);
    return pathToFileURL(resolved).href;
  };
  const { Client } = await import(resolve('@modelcontextprotocol/sdk/client/index.js'));
  const { StdioClientTransport } = await import(resolve('@modelcontextprotocol/sdk/client/stdio.js'));
  const { generatePrivateKey } = await import(resolve('viem/accounts'));
  const installedRoot = path.join(sandbox, 'node_modules', 'agenttoll-mcp');
  const pkg = JSON.parse(readFileSync(path.join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.version, version);
  const bin = realpathSync(path.join(installedRoot, pkg.bin['agenttoll-mcp']));
  assert.ok(bin.startsWith(realpathSync(installedRoot) + path.sep));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME'].includes(key.toUpperCase())));
  const results = [];
  for (const mode of ['keyless', 'zero-budget', 'recipient', 'overcharge', 'timeout', 'cancellation', 'normal']) {
    const eventsPath = path.join(sandbox, `${mode}.ndjson`);
    writeFileSync(eventsPath, '');
    const events = () => readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', new URL('./mcp-package-fixture.mjs', import.meta.url).href, bin], cwd: sandbox,
      env: { ...env, AGENTTOLL_URL: 'https://audit.invalid', AGENTTOLL_NETWORK: 'base-sepolia',
        AGENTTOLL_RECIPIENT: '0x1111111111111111111111111111111111111111',
        AGENTTOLL_BUDGET_USDC: mode === 'zero-budget' ? '0' : '1',
        AGENTTOLL_TIMEOUT_MS: mode === 'timeout' ? '100' : '30000',
        MCP_TEST_MODE: mode, MCP_TEST_EVENTS: eventsPath,
        ...(mode === 'keyless' ? {} : { AGENT_PRIVATE_KEY: generatePrivateKey() }),
      }, stderr: 'pipe' });
    const client = new Client({ name: 'offline-package-verification', version: '1.0.0' });
    // Drain diagnostics without retaining potentially sensitive subprocess text.
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport, { timeout: 10_000 });
      assert.equal(client.getServerVersion()?.version, version);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 23);
      const budget = async () => JSON.parse((await client.callTool({ name: 'get_payment_budget', arguments: {} })).content[0].text);
      const initial = await budget();
      assert.equal(initial.canSign, mode !== 'keyless');
      if (mode === 'keyless') {
        const quoteResult = await client.callTool({ name: 'get_payment_quote', arguments: { path: '/api/price/eth' } });
        assert.notEqual(quoteResult.isError, true);
        const quote = JSON.parse(quoteResult.content[0].text);
        assert.equal(quote.amountUsdc, '0.001000');
        assert.equal(quote.ceilingUsdc, '0.001000');
        assert.equal(quote.quote.accepts[0].network, 'eip155:84532');
        for (const name of ['get_base_token_price', 'get_base_address_info', 'get_base_portfolio', 'check_token_safety', 'watch_base_address']) {
          assert.equal(tools.find(tool => tool.name === name).inputSchema.properties.address.pattern, '^0x[0-9a-fA-F]{40}$');
          const invalid = await client.callTool({ name, arguments: { address: 'invalid' } });
          assert.equal(invalid.isError, true);
        }
        for (const args of [{ symbol: 'eth', ref: 0 }, { symbol: 'eth', ref: 1, pct: -1 }]) {
          assert.equal((await client.callTool({ name: 'watch_price_alert', arguments: args })).isError, true);
        }
        assert.equal(events().filter(e => e.type === 'unsigned-request').length, 1, 'Invalid input reached HTTP');
      }
      const abort = new AbortController();
      const started = Date.now();
      const pending = client.callTool({ name: 'get_price', arguments: { symbol: 'eth' } }, undefined,
        { signal: abort.signal, timeout: 5000 }).then(result => ({ result }), error => ({ error }));
      if (mode === 'cancellation') {
        const until = Date.now() + 2000;
        while (!events().some(e => e.type === 'unsigned-request') && Date.now() < until) await delay(10);
        assert.ok(events().some(e => e.type === 'unsigned-request'), 'Cancellation must occur during HTTP');
        abort.abort(new Error('Package verification cancelled'));
      }
      const { result, error } = await pending;
      const elapsedMs = Date.now() - started;
      if (mode === 'normal') {
        assert.ifError(error);
        assert.notEqual(result.isError, true);
        assert.equal(JSON.parse(result.content[0].text).offlineFixture, true);
      } else if (mode === 'cancellation') {
        assert.match(error?.message ?? '', /cancelled/i);
      } else {
        assert.ifError(error);
        assert.equal(result.isError, true);
        const pattern = { keyless: /wallet/i, 'zero-budget': /budget/i, recipient: /recipient/i, overcharge: /ceiling/i, timeout: /timed out/i }[mode];
        assert.match(result.content[0].text, pattern);
      }
      if (mode === 'timeout' || mode === 'cancellation') {
        assert.ok(elapsedMs < 1000, `Deadline/cancellation took ${elapsedMs}ms`);
        const until = Date.now() + 2000;
        while (!events().some(e => e.type === 'late-quote') && Date.now() < until) await delay(10);
        assert.ok(events().some(e => e.type === 'late-quote' && e.aborted), 'Late quote was not aborted');
        await delay(50); // Give a broken client time to sign the delivered late quote.
      }
      const final = await budget();
      const observed = events();
      const signedRetries = observed.filter(e => e.type === 'signed-retry').length;
      assert.equal(signedRetries, mode === 'normal' ? 1 : 0, `${mode}: unexpected signed retry`);
      assert.equal(final.spentUsdc, mode === 'normal' ? '0.001000' : '0.000000');
      assert.equal(final.reservedUsdc, '0.000000');
      assert.equal(final.remainingUsdc, mode === 'normal' ? '0.999000' : initial.remainingUsdc);
      assert.ok(!observed.some(e => e.type.startsWith('blocked-')), 'Attempted network escape');
      for (const event of observed.filter(e => ['unsigned-request', 'signed-retry'].includes(e.type))) {
        assert.equal(event.client, `agenttoll-mcp/${version}`, 'Missing package identification header');
      }
      results.push({ mode, tools: tools.length, version, elapsedMs, signedRetries, budget: final, events: observed });
      console.log(`  ${mode}: ${tools.length} tools, ${signedRetries} signed retries, remaining ${final.remainingUsdc} USDC`);
    } finally { await client.close(); }
  }
  const lock = JSON.parse(readFileSync(path.join(sandbox, 'package-lock.json'), 'utf8'));
  const dependencies = Object.fromEntries(Object.entries(lock.packages).filter(([name]) => /node_modules\/(?:@x402\/(?:core|evm|fetch)|viem|@modelcontextprotocol\/sdk)$/.test(name)).map(([name, data]) => [name, data.version]));
  return { version, dependencies, cases: results };
}
