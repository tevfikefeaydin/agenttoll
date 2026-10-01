// The Python collector holds the directory lock; this adapter owns the durable commit.
import { updateUsageArchiveStore, UsageArchiveStoreError } from '../src/usage-archive-store.js';

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--directory' || !args[1]) throw new Error('Arguments');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 45 * 1024 * 1024) throw new Error('Input bound');
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  process.stdout.write(JSON.stringify(updateUsageArchiveStore(args[1], request)));
} catch (error) {
  const stage = error instanceof UsageArchiveStoreError ? error.stage : 'request';
  console.error(`Usage archive failed during ${stage}; inspect the last committed manifest. No successful collection claimed.`);
  process.exitCode = 1;
}
