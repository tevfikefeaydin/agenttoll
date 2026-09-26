// Private streaming adapter. The host collector owns locking and atomic persistence.
import { updateUsageArchive } from '../src/usage-archive.js';
try {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 45 * 1024 * 1024) throw new Error('Input limit');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value.input !== 'string' || typeof value.now !== 'string' || !Object.hasOwn(value, 'state')) throw new Error('Invalid input');
  process.stdout.write(JSON.stringify(updateUsageArchive(value.state, value.input, value.now)));
} catch {
  console.error('Usage archive failed; input/state rejected. Last good archive must be retained.');
  process.exitCode = 1;
}
