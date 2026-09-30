import { readFileSync, writeFileSync } from 'node:fs';
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
writeFileSync(new URL('./version.ts', import.meta.url), '// Generated from mcp/package.json; do not edit.\nexport const MCP_VERSION = ' + JSON.stringify(version) + ';\n');
