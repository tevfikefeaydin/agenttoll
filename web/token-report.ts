/** Present the existing safety response without promoting absent evidence to a pass. */
export const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, fallback = '') => typeof value === 'string' && value.trim() ? value.slice(0, 2000) : fallback;
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 30) : [];
const checkTitles: Record<string, string> = {
  'honeypot': 'Buying and selling', 'taxes': 'Trading taxes', 'verified': 'Contract source',
  'owner-powers': 'Owner permissions', 'concentration': 'Holder concentration', 'liquidity': 'Liquidity ownership',
  'creator-stake': 'Creator holdings', 'deployer': 'Who deployed it',
};
const statusNames: Record<string, string> = { pass: 'Checked', warn: 'Review', fail: 'Risk flag', unknown: 'Not available' };

/** Format an already validated decimal string without floating-point rounding. */
export function displayUsdc(value: string) { return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value; }

const evidenceLabels: Record<string, string> = {
  is_mintable: 'minting permissions', transfer_pausable: 'ability to pause transfers',
  is_blacklisted: 'address blocking permissions', slippage_modifiable: 'ability to change trading taxes',
  personal_slippage_modifiable: 'ability to set per-wallet taxes', can_take_back_ownership: 'ability to reclaim ownership',
  hidden_owner: 'hidden owner permissions', selfdestruct: 'contract deletion permissions',
  trading_cooldown: 'trading cooldown rules', anti_whale_modifiable: 'ability to change holding limits',
  owner_change_balance: 'ability to change holder balances', 'top-liquidity-provider-list': 'largest liquidity providers',
  'liquidity-share-total': 'total liquidity ownership coverage', 'liquidity-provider-count': 'liquidity provider count',
  'top-holder-list': 'largest token holders', 'holder-share-total': 'total holder coverage',
  'creator-percent': 'creator’s share of supply', 'scam-flag': 'explorer scam assessment',
  'open-source': 'published contract source', 'buy-tax': 'buy tax', 'sell-tax': 'sell tax',
};
export function evidenceLabel(value: string) {
  if (Object.hasOwn(evidenceLabels, value)) return evidenceLabels[value];
  const holder = /^(lp_holders|holders)\[(\d{1,4})\]\.(percent|is_locked|is_contract)$/.exec(value);
  if (holder) return `${holder[1] === 'holders' ? 'holder' : 'liquidity provider'} ${Number(holder[2]) + 1}: ${{ percent: 'ownership share', is_locked: 'lock status', is_contract: 'contract status' }[holder[3]]}`;
  return value.replace(/[_-]/g, ' ');
}

export function inspectionEndpoint(value: string): string {
  const address = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) {
    throw new Error('Enter a Base token contract address: 0x followed by 40 letters and numbers.');
  }
  return '/api/base/safety/' + address.toLowerCase();
}

export function reportTime(value: unknown): string {
  const date = typeof value === 'string' ? new Date(value) : new Date(NaN);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' UTC' : 'Time unavailable';
}

export function renderTokenReport(value: unknown, expectedToken?: string): string {
  const data = record(value);
  if (data.chain !== 'base' || typeof data.token !== 'string') throw new Error('The response is not a Base token report. Keep your receipt before retrying.');
  const token = inspectionEndpoint(data.token).split('/').at(-1)!;
  if (expectedToken && inspectionEndpoint(expectedToken) !== inspectionEndpoint(token)) throw new Error('The report is for a different token. Keep your receipt before retrying.');
  const supplied = Array.isArray(data.checks) ? data.checks.map(record) : [];
  const checks = Object.entries(checkTitles).map(([id, title]) => {
    const matches = supplied.filter(c => c.id === id);
    const check = matches.length === 1 ? matches[0] : {};
    let status = Object.hasOwn(statusNames, String(check.status)) ? String(check.status) : 'unknown';
    const missing = strings(check.missing);
    const conflicts = strings(check.conflicts);
    const complete = check.complete === true && status !== 'unknown' && !missing.length && !conflicts.length;
    if (status === 'pass' && !complete) status = conflicts.length ? 'warn' : 'unknown';
    return { id, title, status, complete, missing, conflicts, detail: text(check.detail, 'This check is not available.'), sources: strings(check.sources) };
  });
  const completed = checks.filter(c => c.complete).length;
  const flags = checks.filter(c => c.status === 'fail').length;
  const warnings = checks.filter(c => c.status === 'warn').length;
  const verdict = flags ? 'high-risk' : warnings ? 'caution' : completed < checks.length ? 'insufficient-data' : 'clear';
  const heading = { 'high-risk': 'Risk flags found', 'caution': 'Review the warnings', 'insufficient-data': 'Evidence is incomplete', 'clear': 'No flags in completed checks' }[verdict];
  const summary = flags ? 'Read the flagged checks before relying on this token.' : warnings ? 'Some findings need a closer look. Review the details below.' : completed < checks.length ? 'Some evidence is missing. An unavailable check is not a pass.' : 'All listed checks completed. This is a snapshot of automated checks, not a guarantee of safety.';
  const name = text(data.name, text(data.symbol, 'Token report'));
  const symbol = text(data.symbol);
  const holders = typeof data.holderCount === 'number' && Number.isSafeInteger(data.holderCount) && data.holderCount >= 0 ? data.holderCount.toLocaleString('en-US') : 'Not available';
  const sourceStatus = record(data.sourceStatus);
  const sources = strings(data.sources);
  return `<article class="token-report" data-verdict="${verdict}">
    <header class="report-header"><div><p class="report-network">Base token</p><h2>${escapeHtml(name)}${symbol && symbol !== name ? ` <span>${escapeHtml(symbol)}</span>` : ''}</h2>
    <a class="token-address" href="https://basescan.org/token/${token}" target="_blank" rel="noopener noreferrer">${token}</a></div>
    <div class="report-time"><span>Checked</span><time>${escapeHtml(reportTime(data.at))}</time></div></header>
    <div class="report-verdict"><span class="verdict-mark" aria-hidden="true">${flags ? '!' : completed < checks.length || warnings ? '?' : '✓'}</span><div><h3>${heading}</h3><p>${summary}</p></div></div>
    <dl class="report-numbers"><div><dt>Evidence coverage</dt><dd>${completed} of ${checks.length} checks complete</dd></div><div><dt>Risk flags / warnings</dt><dd>${flags} / ${warnings}</dd></div><div><dt>Reported holders</dt><dd>${holders}</dd></div></dl>
    <div class="report-checks">${checks.map(c => `<details class="report-check" data-status="${c.status}"${c.status !== 'pass' ? ' open' : ''}>
      <summary><span>${c.title}</span><span class="check-status">${statusNames[c.status]}</span></summary>
      <div class="check-detail"><p>${escapeHtml(c.detail)}</p>${c.missing.length ? `<p class="missing-evidence">Missing: ${escapeHtml(c.missing.map(evidenceLabel).join(', '))}</p>` : ''}${c.conflicts.length ? `<p class="missing-evidence">Sources disagree: ${escapeHtml(c.conflicts.map(evidenceLabel).join(', '))}</p>` : ''}
      <p class="check-source">${c.sources.length ? 'Sources: ' + escapeHtml(c.sources.join(', ')) : 'No source evidence available'}</p></div></details>`).join('')}</div>
    <footer class="report-footer"><p>Automated checks can miss risks. Passing a check does not make a token safe.</p>
      <details><summary>Sources and observation times</summary><ul>${Object.entries(sourceStatus).map(([source, raw]) => { const s = record(raw); return `<li>${escapeHtml(source)}: ${escapeHtml(text(s.status, 'unavailable'))} — fetched ${escapeHtml(reportTime(s.fetchedAt))}</li>`; }).join('') || `<li>${escapeHtml(sources.join(', ') || 'Not available')}; individual source times unavailable.</li>`}</ul><p>Fetch times describe when data was retrieved. They do not prove when the provider last observed it. Cached reports retain their original check time.</p></details></footer>
  </article>`;
}
