import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderTokenReport, reportTime, escapeHtml } from '../web/token-report.ts';
import { ENDPOINT_MANIFEST } from '../src/endpoint-manifest.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
// The deployed CSP permits inline styles. Keep source CSS shared while shipping
// it inside each generated page, matching the existing site's security policy.
function inlineStyles(html) {
  return html.replace(/<link rel="stylesheet" href="\/(inspect|research|home|site)\.css">/g, (_tag, name) =>
    '<style>\n' + readFileSync(new URL('../web/' + name + '.css', import.meta.url), 'utf8') + '</style>');
}
function siteHeader(page) {
  const links = [['home', '/#tools', 'Explore'], ['inspect', '/inspect.html', 'Inspect'], ['research', '/research.html', 'My research'], ['api', '/#try', 'API']];
  return `<header class="site-header"><nav class="site-navigation" aria-label="Main"><a class="site-brand" href="/" aria-label="AgentToll home"><svg viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#0052FF"/><path d="M149 378V167h214v211" fill="none" stroke="white" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/><circle cx="256" cy="330" r="42" fill="none" stroke="white" stroke-width="18"/><circle cx="256" cy="330" r="14" fill="white"/></svg>AgentToll</a><div class="site-links">${links.map(([key, href, label]) => `<a href="${href}"${key === 'home' ? ' class="site-explore"' : ''}${page === key && key !== 'home' ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</div></nav></header>`;
}
function output(name, content) {
  const path = new URL('../public/' + name, import.meta.url);
  if (check) {
    let existing;
    try { existing = readFileSync(path, 'utf8').replace(/\r\n/g, '\n'); } catch { /* Missing generated output is stale. */ }
    if (existing !== content.replace(/\r\n/g, '\n')) throw new Error(`public/${name} is stale; run npm run build:web`);
  } else writeFileSync(path, content);
}
for (const entry of ['demo', 'inspect', 'research', 'shared-report']) {
  const result = await build({ absWorkingDir: root, entryPoints: [`web/${entry}.ts`], bundle: true, format: 'iife', target: 'es2020', minify: true, write: false });
  output(entry + '.js', result.outputFiles[0].text);
}
const example = JSON.parse(readFileSync(new URL('../public/token-example.json', import.meta.url), 'utf8'));
if (example.kind !== 'recorded-example' || !Number.isFinite(Date.parse(example.capturedAt))) throw new Error('The recorded token example needs a valid capture date.');
const endpoint = ENDPOINT_MANIFEST.find(endpoint => endpoint.path === '/api/base/safety/{address}');
if (!endpoint) throw new Error('The token inspection endpoint is missing.');
const html = readFileSync(new URL('../web/inspect.html', import.meta.url), 'utf8')
  .replace('@@SITE_HEADER@@', () => siteHeader('inspect'))
  .replace('@@EXAMPLE_REPORT@@', () => renderTokenReport(example.data))
  .replace('@@EXAMPLE_TIME@@', () => escapeHtml(reportTime(example.capturedAt)))
  .replace('@@SAMPLE_TOKEN@@', () => escapeHtml(example.data.token))
  .replace('@@PRICE@@', () => escapeHtml(endpoint.price.replace(/^\$/, '')));
if (/@@[A-Z_]+@@/.test(html)) throw new Error('Unresolved inspection page template field.');
output('inspect.html', inlineStyles(html));
const homeFields = {
  SITE_HEADER: siteHeader('home'),
  EXAMPLE_PREVIEW: renderTokenReport(example.data, undefined, { summaryOnly: true }),
  EXAMPLE_TIME: escapeHtml(reportTime(example.capturedAt)),
};
for (const [name, path] of Object.entries({ INSPECTION_PRICE: '/api/base/safety/{address}', DISCOVERY_PRICE: '/api/base/radar', FRESH_PRICE: '/api/base/fresh' })) {
  const entry = ENDPOINT_MANIFEST.find(endpoint => endpoint.path === path);
  if (!entry) throw new Error(`Homepage endpoint is missing: ${path}`);
  homeFields[name] = escapeHtml(entry.price.replace(/^\$/, ''));
}
const home = readFileSync(new URL('../web/home.html', import.meta.url), 'utf8')
  .replace(/@@([A-Z_]+)@@/g, (_match, name) => {
    if (!Object.hasOwn(homeFields, name)) throw new Error(`Unresolved homepage field: ${name}`);
    return homeFields[name];
  });
output('index.html', inlineStyles(home));
for (const name of ['research.html', 'shared-report.html']) {
  output(name, inlineStyles(readFileSync(new URL('../web/' + name, import.meta.url), 'utf8').replace('@@SITE_HEADER@@', () => siteHeader(name === 'research.html' ? 'research' : 'shared'))));
}
console.log(check ? 'Browser bundles and recorded example agree with their sources.' : 'Built browser bundles and token inspection page.');
