import { escapeHtml as esc, renderTokenReport, reportTime, displayUsdc, evidenceLabel } from './token-report.js';
import { normalizeToken, summarizeReport, diffReports, CHECK_DEFINITIONS } from './research-model.js';
import { readResearchStore, writeResearchStore, reconcileResearchStore, addWatch, removeWatch, saveReport, removeReport, emptyResearchStore, RESEARCH_STORAGE_KEY, type ResearchStore, type SavedReport } from './research-store.js';
import { ResearchPayments, type ResearchQuote, type QuotedRequest, type DeliveredOutcome } from './research-payment.js';
import { parsePortfolio } from './portfolio-model.js';
import { createReportLink, downloadReportCard } from './report-share.js';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const payments = new ResearchPayments();
let loaded = readResearchStore();
let library = loaded.store;
let storageBaseline = loaded.store;
let deferredStorage = false;
let unsavedWarnings: string[] = [];
let activeToken: string | undefined;
let selectedReportId: string | undefined;
let compareTokens: string[] = [];
let walletTokens = new Set<string>();
let portfolio: ReturnType<typeof parsePortfolio> | undefined;
type Purpose = 'compare' | 'portfolio' | 'wallet-scan';
let pending: { quote: ResearchQuote; purpose: Purpose } | undefined;
let remaining: { purpose: Purpose; paths: string[] } | undefined;
let previewAbort: AbortController | undefined;
let previewSequence = 0;
let previewBusy = false;
const receiptUrls: string[] = [];
const statusNames: Record<string, string> = { pass: 'Checked', warn: 'Review', fail: 'Risk flag', unknown: 'Not available' };
const originNames = { inspection: 'Saved inspection', example: 'Recorded example', shared: 'Shared snapshot · unverified' };
const short = (address: string) => address.slice(0, 8) + '…' + address.slice(-6);

function message(text: string, error = false) {
  const box = el('research-status'); box.textContent = text; box.dataset.tone = error ? 'err' : 'ok'; box.hidden = !text;
}
function storageMessage(warnings: string[]) {
  const box = el('storage-status'); box.textContent = warnings.join(' '); box.hidden = !warnings.length;
}
function persist(next: ResearchStore) {
  const latest = readResearchStore();
  const reconciled = latest.writable ? reconcileResearchStore(storageBaseline, next, latest.store) : next;
  const result = writeResearchStore(reconciled);
  library = result.store;
  if (result.saved) storageBaseline = result.store;
  else if (latest.writable) storageBaseline = latest.store;
  unsavedWarnings = result.saved ? [] : result.warnings;
  storageMessage(result.warnings);
  return result.saved;
}
function refreshStorage() {
  if (payments.busy) { deferredStorage = true; return; }
  deferredStorage = false;
  loaded = readResearchStore();
  if (loaded.writable) {
    library = reconcileResearchStore(storageBaseline, library, loaded.store);
    storageBaseline = loaded.store;
  }
  storageMessage([...new Set([...loaded.warnings, ...unsavedWarnings])]);
  renderLibrary(); renderComparison(); if (portfolio) renderPortfolio(); syncControls();
}
function orderedReports(token: string): SavedReport[] {
  return library.reports.filter(r => r.token === token).sort((a, b) => {
    const time = (r: SavedReport) => Date.parse(String(r.data.at)) || Date.parse(r.savedAt) || 0;
    return time(b) - time(a);
  });
}
function bestReport(token: string) {
  const reports = orderedReports(token);
  return reports.find(r => r.origin === 'inspection') ?? reports[0];
}
function currentReport() { return library.reports.find(r => r.id === selectedReportId && r.token === activeToken); }
function saveDelivered(data: unknown, token: string) {
  let next = saveReport(library, data, 'inspection');
  try { next = addWatch(next, token); } catch { /* A full watchlist does not discard a delivered report. */ }
  persist(next);
  activeToken = token;
  selectedReportId = bestReport(token)?.id;
}

function renderLibrary() {
  el('watch-count').textContent = String(library.watchlist.length);
  const watched = new Set(library.watchlist.map(w => w.token));
  const recent = [...new Set(library.reports.map(r => r.token))].filter(t => !watched.has(t));
  if (activeToken && !watched.has(activeToken) && !recent.includes(activeToken)) activeToken = undefined;
  if (!activeToken) activeToken = library.watchlist[0]?.token ?? recent[0];
  const row = (token: string, followed: boolean) => {
    const saved = bestReport(token);
    const data = saved ? summarizeReport(saved.data) : undefined;
    return `<article class="watch-item" data-active="${token === activeToken}"><button type="button" class="watch-open" data-open="${token}"><span class="watch-name">${esc(data?.symbol || data?.name || short(token))}</span><span class="watch-address">${token.slice(0, 10)}…${token.slice(-8)}</span><span class="watch-meta">${saved ? esc(reportTime(data?.at)) : 'No saved report yet'}</span></button><div class="watch-actions"><button type="button" class="text-button" data-compare="${token}">Compare</button>${followed ? `<button type="button" class="text-button" data-unfollow="${token}">Unfollow</button>` : `<button type="button" class="text-button" data-follow="${token}">Follow</button>`}</div></article>`;
  };
  el('watch-items').innerHTML = library.watchlist.map(w => row(w.token, true)).join('') + (recent.length ? '<p class="input-help">Other saved reports</p>' + recent.map(t => row(t, false)).join('') : '') || '<p class="empty-inline">Your saved tokens will appear here.</p>';
  renderSaved();
}

function renderSaved() {
  el('saved-empty').hidden = !!activeToken;
  el('saved-content').hidden = !activeToken;
  if (!activeToken) return;
  const reports = orderedReports(activeToken);
  if (!reports.some(r => r.id === selectedReportId)) selectedReportId = bestReport(activeToken)?.id;
  const saved = currentReport();
  const summary = saved ? summarizeReport(saved.data) : undefined;
  el('saved-heading').textContent = summary?.name || summary?.symbol || 'Saved token';
  el('saved-address').textContent = activeToken;
  el<HTMLAnchorElement>('reinspect-link').href = '/inspect.html?token=' + activeToken;
  el('history-controls').hidden = !reports.length;
  el<HTMLSelectElement>('history-choice').innerHTML = reports.map(r => `<option value="${esc(r.id)}"${r.id === selectedReportId ? ' selected' : ''}>${esc(reportTime(r.data.at))} · ${originNames[r.origin]}</option>`).join('');
  el('saved-origin').textContent = saved ? originNames[saved.origin] + (saved.origin === 'shared' ? '. Supplied by a sender; its contents have not been authenticated.' : '. This is a dated observation, not a live monitor.') : 'No report has been saved for this token.';
  for (const id of ['saved-copy-link', 'saved-image']) el<HTMLButtonElement>(id).disabled = !saved || payments.busy;
  el('saved-report').innerHTML = saved ? renderTokenReport(saved.data, activeToken) : '<div class="empty-state"><h2>Ready for a first look.</h2><p>Open the inspector to review the price and request this token’s first report.</p></div>';
  const changes = el('report-changes');
  changes.hidden = !saved;
  if (!saved) return;
  const sameOrigin = reports.filter(r => r.origin === saved.origin);
  const previous = sameOrigin[sameOrigin.findIndex(r => r.id === saved.id) + 1];
  if (!previous) { changes.innerHTML = '<h3>What changed?</h3><p>Save another inspection of this token to compare observations from the same source type.</p>'; return; }
  const diff = diffReports(previous.data, saved.data);
  changes.innerHTML = `<h3>What changed?</h3><p>${esc(reportTime(diff.before.at))} to ${esc(reportTime(diff.after.at))}</p>${diff.warnings.map(w => `<p class="provenance">${esc(w)}</p>`).join('')}${!diff.changes.length ? `<p>${!diff.comparable && !diff.sameObservation ? 'These observations cannot be compared reliably. Review the dates and evidence below.' : diff.sameObservation ? 'These reports describe the same observation. A cached result is not a new check.' : 'No changes were found in the recorded checks. This does not establish that the token is safe.'}</p>` : diff.changes.map(c => `<div class="change-row"><h4>${esc(c.title)}</h4>${c.evidenceLost ? '<p class="evidence-lost">Evidence became unavailable. This is not an improvement.</p>' : ''}<div class="change-values"><div><span>Previous · ${statusNames[c.before.status]}</span><p>${esc(c.before.detail)}</p>${c.before.missing.length ? `<p>Missing: ${esc(c.before.missing.map(evidenceLabel).join(', '))}</p>` : ''}</div><div><span>Selected · ${statusNames[c.after.status]}</span><p>${esc(c.after.detail)}</p>${c.after.missing.length ? `<p>Missing: ${esc(c.after.missing.map(evidenceLabel).join(', '))}</p>` : ''}</div></div></div>`).join('')}`;
}

function tokensFromInput() {
  const values = el<HTMLTextAreaElement>('compare-addresses').value.trim().split(/[\s,;]+/).filter(Boolean);
  if (values.length < 2 || values.length > 5) throw new Error('Enter between two and five Base token addresses.');
  const tokens = values.map(normalizeToken);
  if (new Set(tokens).size !== tokens.length) throw new Error('Use each token address only once.');
  return tokens;
}
function comparisonHtml(tokens: string[]) {
  const saved = tokens.map(bestReport);
  const summaries = saved.map(r => r ? summarizeReport(r.data) : undefined);
  return `<table class="comparison-table"><caption>Saved observations may have different dates. An unavailable check is not a pass.</caption><thead><tr><th scope="col">Evidence</th>${tokens.map((token, i) => `<th scope="col"><span class="token-name">${esc(summaries[i]?.symbol || summaries[i]?.name || short(token))}</span><a class="token-link" href="/inspect.html?token=${token}">${short(token)}</a><small>${summaries[i] ? esc(reportTime(summaries[i]!.at)) : 'Not inspected'}</small><small>${saved[i] ? originNames[saved[i]!.origin] : 'No saved report'}</small></th>`).join('')}</tr></thead><tbody><tr><th scope="row">Evidence coverage</th>${summaries.map(s => `<td>${s ? `${s.completed} of 8 checks complete` : 'Not inspected'}</td>`).join('')}</tr><tr><th scope="row">Flags / warnings</th>${summaries.map(s => `<td>${s ? `${s.flags} / ${s.warnings}` : 'Not assessed'}</td>`).join('')}</tr>${CHECK_DEFINITIONS.map(check => `<tr><th scope="row">${esc(check.title)}</th>${summaries.map(s => { const c = s?.checks.find(c => c.id === check.id); return `<td>${c ? `<span class="check-label" data-status="${c.status}">${statusNames[c.status]}</span><details><summary>Evidence</summary><p>${esc(c.detail)}</p>${c.missing.length ? `<p>Missing: ${esc(c.missing.map(evidenceLabel).join(', '))}</p>` : ''}${c.conflicts.length ? `<p>Sources disagree: ${esc(c.conflicts.map(evidenceLabel).join(', '))}</p>` : ''}</details>` : '<span class="check-label" data-status="unknown">Not inspected</span>'}</td>`; }).join('')}</tr>`).join('')}</tbody></table>`;
}
function renderComparison() {
  el('comparison').innerHTML = compareTokens.length >= 2 ? comparisonHtml(compareTokens) : '<p class="empty-inline">Add at least two token addresses to build a comparison.</p>';
}
function addComparison(token: string) {
  const raw = el<HTMLTextAreaElement>('compare-addresses').value.trim();
  const existing = raw ? raw.split(/[\s,;]+/).filter(Boolean).map(normalizeToken) : [];
  if (!existing.includes(token)) existing.push(token);
  if (existing.length > 5) throw new Error('A comparison can contain up to five tokens. Remove one to add another.');
  compareTokens = [...new Set(existing)];
  el<HTMLTextAreaElement>('compare-addresses').value = compareTokens.join('\n');
  invalidatePurchase(); remaining = undefined;
  renderComparison(); selectTab('compare');
}

function selectTab(tab: string) {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    el('panel-' + button.dataset.tab).hidden = !selected;
  }
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
  button.addEventListener('click', () => selectTab(button.dataset.tab!));
  button.addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')];
    let index = tabs.indexOf(button);
    if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault(); selectTab(tabs[index].dataset.tab!); tabs[index].focus();
  });
}
el('watch-form').addEventListener('submit', event => {
  event.preventDefault();
  try { const token = normalizeToken(el<HTMLInputElement>('watch-address').value); const saved = persist(addWatch(library, token)); activeToken = token; selectedReportId = undefined; el<HTMLInputElement>('watch-address').value = ''; renderLibrary(); message(saved ? 'Token saved to your watchlist.' : 'Token added for this visit. Browser storage could not be updated.'); } catch (error) { message((error as Error).message, true); }
});
el('watch-items').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return;
  try {
    if (button.dataset.open) { activeToken = button.dataset.open; selectedReportId = undefined; renderLibrary(); }
    else if (button.dataset.compare) addComparison(button.dataset.compare);
    else if (button.dataset.unfollow) { persist(removeWatch(library, button.dataset.unfollow)); renderLibrary(); message('Token unfollowed. Its saved reports remain in history.'); }
    else if (button.dataset.follow) { persist(addWatch(library, button.dataset.follow)); renderLibrary(); }
  } catch (error) { message((error as Error).message, true); }
});
el('history-choice').addEventListener('change', () => { selectedReportId = el<HTMLSelectElement>('history-choice').value; renderSaved(); });
el('delete-report').addEventListener('click', () => {
  if (!selectedReportId) return;
  persist(removeReport(library, selectedReportId)); selectedReportId = undefined; renderLibrary(); renderComparison(); message('Report removed from this browser’s history.');
});
el('clear-library').addEventListener('click', () => { el('clear-confirm').hidden = false; });
el('cancel-clear').addEventListener('click', () => { el('clear-confirm').hidden = true; });
el('confirm-clear').addEventListener('click', () => {
  try { localStorage.removeItem(RESEARCH_STORAGE_KEY); library = storageBaseline = emptyResearchStore(); unsavedWarnings = []; activeToken = selectedReportId = undefined; storageMessage([]); el('clear-confirm').hidden = true; renderLibrary(); renderComparison(); message('Saved research cleared from this browser.'); }
  catch { message('This browser could not clear its storage. Use your browser’s site-data settings.', true); }
});
el('load-example').addEventListener('click', async () => {
  const button = el<HTMLButtonElement>('load-example'); button.disabled = true;
  try {
    const response = await fetch('/token-example.json', { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error('The recorded example could not be loaded. Try again.');
    const example = await response.json();
    if (example.kind !== 'recorded-example') throw new Error('The recorded example format was not recognized.');
    const summary = summarizeReport(example.data);
    const saved = persist(addWatch(saveReport(library, example.data, 'example'), summary.token));
    activeToken = summary.token; selectedReportId = library.reports.find(r => r.token === summary.token && r.origin === 'example')?.id; renderLibrary();
    message(saved ? 'Recorded example saved. Its capture time stays visible.' : 'Example opened for this visit. Browser storage could not be updated.');
  } catch (error) { message((error as Error).message, true); } finally { button.disabled = false; }
});
el('saved-add-compare').addEventListener('click', () => { try { if (activeToken) addComparison(activeToken); } catch (error) { message((error as Error).message, true); } });
async function copyLink(data: unknown) {
  const link = createReportLink(data, location.origin);
  try { await navigator.clipboard.writeText(link); message('Snapshot link copied. Shared reports are labelled as unverified.'); }
  catch { message('Clipboard access is unavailable. Copy the link from the field below.'); const box = document.createElement('textarea'); box.readOnly = true; box.value = link; box.setAttribute('aria-label', 'Snapshot link to copy'); el('research-status').append(box); box.focus(); box.select(); }
}
el('saved-copy-link').addEventListener('click', () => { const r = currentReport(); if (r) void copyLink(r.data).catch(e => message(e.message, true)); });
el('saved-image').addEventListener('click', () => { const r = currentReport(); if (r) void downloadReportCard(r.data, r.origin).catch(e => message(e.message, true)); });

el('compare-form').addEventListener('submit', event => { event.preventDefault(); try { compareTokens = tokensFromInput(); renderComparison(); message('Comparison uses your saved observations. Dates and missing evidence are shown for each token.'); } catch (error) { message((error as Error).message, true); } });
el('compare-addresses').addEventListener('input', () => { invalidatePurchase(); remaining = undefined; syncControls(); });
el('compare-prices').addEventListener('click', () => {
  try { compareTokens = tokensFromInput(); renderComparison(); const paths = remaining?.purpose === 'compare' ? remaining.paths : compareTokens.map(t => '/api/base/safety/' + t); void preview(paths, 'compare'); } catch (error) { message((error as Error).message, true); }
});

const number = (value: number | null, currency = false) => value === null ? 'Not available' : currency ? value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }) : value.toLocaleString('en-US', { maximumFractionDigits: 6 });
function renderPortfolio() {
  if (!portfolio) return;
  const p = portfolio;
  el('wallet-results').hidden = false;
  el('wallet-summary').innerHTML = `<div class="wallet-coverage"><h3>${p.tokens.length} discovered token${p.tokens.length === 1 ? '' : 's'}</h3><p class="address-text">${p.address}</p><p>Observed ${esc(reportTime(p.at))} · Source: ${esc(p.source || 'Not available')}</p><p>Reported portfolio value: ${number(p.totalUsd, true)}. Includes native ETH where reported; native ETH is not part of token safety scans.</p><p>${number(p.shown)} shown · ${number(p.tokenCount)} above the value filter · ${number(p.unpriced)} unpriced · ${number(p.hiddenBelowFloor)} below the filter.</p>${p.partial || p.note ? `<p class="provenance">${esc(p.note || 'The provider returned incomplete holdings.')}</p>` : ''}<p>Holdings depend on provider coverage and may omit tokens. A missing holding or security report is not an all-clear result.</p></div>`;
  el('wallet-holdings').innerHTML = p.tokens.length ? `<table class="comparison-table holdings-table"><caption>Select up to five tokens for a separate, priced inspection.</caption><thead><tr><th scope="col">Token</th><th scope="col">Balance</th><th scope="col">Reported value</th><th scope="col">Saved evidence</th></tr></thead><tbody>${p.tokens.map(t => { const r = bestReport(t.address); const s = r ? summarizeReport(r.data) : undefined; return `<tr><td><label class="holding-select"><input type="checkbox" value="${t.address}"${walletTokens.has(t.address) ? ' checked' : ''}><span>${esc(t.symbol || t.name || short(t.address))}<small class="token-link">${short(t.address)}</small></span></label></td><td>${number(t.balance)}</td><td>${number(t.valueUsd, true)}</td><td>${s ? `${s.flags} flags / ${s.warnings} warnings<small>${s.completed} of 8 checks · ${esc(reportTime(s.at))}</small><small>${originNames[r!.origin]}</small>` : 'Not inspected'}</td></tr>`; }).join('')}</tbody></table>` : '<p class="empty-inline">No token holdings were returned. This does not establish that the wallet has no tokens.</p>';
  renderWalletSelection();
}
function renderWalletSelection() {
  el('wallet-selected-count').textContent = `${walletTokens.size} of 5 tokens selected.`;
  el('wallet-risk-results').innerHTML = walletTokens.size ? comparisonHtml([...walletTokens]) : '';
}
el('wallet-form').addEventListener('submit', event => { event.preventDefault(); try { const wallet = normalizeToken(el<HTMLInputElement>('wallet-address').value); remaining = undefined; void preview(['/api/base/portfolio/' + wallet + '?minValue=0&limit=50'], 'portfolio'); } catch (error) { message((error as Error).message, true); } });
el('wallet-address').addEventListener('input', () => { invalidatePurchase(); remaining = undefined; portfolio = undefined; walletTokens.clear(); el('wallet-results').hidden = true; syncControls(); });
el('wallet-holdings').addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  if (input.type !== 'checkbox' || !portfolio?.tokens.some(t => t.address === input.value)) return;
  if (input.checked && walletTokens.size >= 5) { input.checked = false; message('Select up to five tokens per inspection batch.', true); return; }
  if (input.checked) walletTokens.add(input.value); else walletTokens.delete(input.value);
  invalidatePurchase(); remaining = undefined; renderWalletSelection(); syncControls();
});
el('wallet-inspect-prices').addEventListener('click', () => {
  if (!walletTokens.size) { message('Select at least one discovered token to inspect.', true); return; }
  const paths = remaining?.purpose === 'wallet-scan' ? remaining.paths : [...walletTokens].map(t => '/api/base/safety/' + t);
  void preview(paths, 'wallet-scan');
});

function invalidatePurchase() {
  previewSequence++; previewAbort?.abort(); previewAbort = undefined; previewBusy = false; pending = undefined; el('research-payment').hidden = true;
}
function syncControls() {
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('main input, main textarea, main button')) control.disabled = payments.busy;
  for (const id of ['compare-prices', 'wallet-inspect-prices', 'purchase-button']) el<HTMLButtonElement>(id).disabled = payments.busy || payments.blocked || previewBusy;
  el<HTMLButtonElement>('wallet-inspect-prices').disabled ||= !walletTokens.size;
  el<HTMLButtonElement>('purchase-button').disabled ||= !pending;
  el<HTMLButtonElement>('acknowledge-payment').hidden = !payments.blocked;
  const walletSubmit = document.querySelector<HTMLButtonElement>('#wallet-form button')!;
  walletSubmit.disabled = payments.busy || payments.blocked || previewBusy;
  el('compare-prices').textContent = remaining?.purpose === 'compare' ? `Check prices for ${remaining.paths.length} remaining` : 'Check inspection prices';
  el('wallet-inspect-prices').textContent = remaining?.purpose === 'wallet-scan' ? `Check prices for ${remaining.paths.length} remaining` : 'Check selected inspection prices';
  if (!currentReport()) for (const id of ['saved-copy-link', 'saved-image']) el<HTMLButtonElement>(id).disabled = true;
}
async function preview(paths: string[], purpose: Purpose) {
  if (payments.busy || payments.blocked) { message('Check your wallet and receipts before starting another payment.', true); return; }
  invalidatePurchase(); const sequence = previewSequence; const controller = new AbortController(); previewAbort = controller; previewBusy = true; syncControls();
  message('Checking prices. Your wallet will not be prompted.');
  try {
    const quote = await payments.quote(paths, controller.signal);
    if (sequence !== previewSequence) return;
    pending = { quote, purpose };
    el('purchase-total').textContent = displayUsdc(quote.totalUsdc);
    const count = quote.items.length;
    el('purchase-description').textContent = purpose === 'portfolio' ? 'One holdings lookup. Token inspections are a separate purchase you can choose afterwards.' : `${count} token inspection${count === 1 ? '' : 's'}. Your wallet will ask for ${count} separate authorization${count === 1 ? '' : 's'}. Processing stops if a payment fails. Completed reports are saved in this browser.`;
    el('purchase-network').textContent = quote.network === 'base' ? 'Pay with USDC on Base mainnet.' : 'Pay with test USDC on Base Sepolia.';
    el('purchase-recipient').textContent = quote.recipient;
    el('purchase-items').innerHTML = quote.items.map(i => `<li>${purpose === 'portfolio' ? 'Holdings lookup' : short(i.path.split('/').at(-1)!)}: ${esc(displayUsdc(i.amountUsdc))} USDC</li>`).join('');
    el('purchase-button').textContent = `Pay ${displayUsdc(quote.totalUsdc)} USDC${count > 1 ? ` in ${count} steps` : ''}`;
    el('research-payment').hidden = false;
    el('research-payment').scrollIntoView({ behavior: 'instant', block: 'nearest' });
    message('Prices ready. Review the total before continuing.');
  } catch (error) { if (sequence === previewSequence) message(controller.signal.aborted ? 'Price lookup cancelled. No payment was requested.' : (error as Error).message, true); }
  finally { if (sequence === previewSequence) { previewBusy = false; previewAbort = undefined; syncControls(); } if (deferredStorage) refreshStorage(); }
}
function retainReceipt(request: QuotedRequest, outcome: DeliveredOutcome) {
  const item = document.createElement('li');
  const token = request.path.split('/').at(-1)!.split('?')[0];
  item.textContent = `${short(token)}: response received. `;
  const raw = URL.createObjectURL(new Blob([JSON.stringify(outcome.data, null, 2) + '\n'], { type: 'application/json' })); receiptUrls.push(raw);
  const download = document.createElement('a'); download.href = raw; download.download = `agenttoll-${token}.json`; download.textContent = 'Download received data'; item.append(download);
  if (outcome.transaction && /^0x[0-9a-fA-F]{64}$/.test(outcome.transaction)) {
    const link = document.createElement('a'); link.href = (outcome.network === 'base' ? 'https://basescan.org' : 'https://sepolia.basescan.org') + '/tx/' + outcome.transaction; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'View receipt'; item.append(' · ', link);
  } else item.append(' · Settlement receipt unavailable.');
  el('payment-receipts').append(item);
}
el('purchase-button').addEventListener('click', async () => {
  if (!pending || payments.busy || payments.blocked) return;
  const purchase = pending; pending = undefined; el('research-payment').hidden = true; el('payment-progress').hidden = false;
  const promise = payments.run(purchase.quote, (html, tone) => { const box = el('payment-status'); box.innerHTML = html; box.dataset.tone = tone ?? 'quote'; }, (request, outcome) => {
    retainReceipt(request, outcome);
    if (purchase.purpose === 'portfolio') {
      const address = request.path.split('/').at(-1)!.split('?')[0];
      portfolio = parsePortfolio(outcome.data, address); walletTokens.clear(); renderPortfolio();
    } else { const token = request.path.split('/').at(-1)!; summarizeReport(outcome.data, token); saveDelivered(outcome.data, token); renderLibrary(); renderComparison(); if (portfolio) renderPortfolio(); }
    syncControls();
  });
  syncControls();
  try {
    const result = await promise;
    const completed = new Set(result.results.map(r => r.request.path));
    const unpaid = purchase.quote.items.filter(i => !completed.has(i.path)).map(i => i.path);
    remaining = unpaid.length && purchase.purpose !== 'portfolio' ? { purpose: purchase.purpose, paths: unpaid } : undefined;
    if (result.stopReason === 'complete') message(purchase.purpose === 'portfolio' ? 'Holdings received. Select tokens if you want separate inspections.' : `${result.completed} report${result.completed === 1 ? '' : 's'} received. Saved evidence is shown below.`);
    else message(`${result.completed} response${result.completed === 1 ? '' : 's'} received before processing stopped. ${result.error || 'Review your wallet and receipts before continuing.'} Completed requests will not be included in the remaining batch.`, true);
  } catch (error) { message((error as Error).message, true); }
  finally { syncControls(); if (deferredStorage) refreshStorage(); }
});
el('cancel-purchase').addEventListener('click', () => { invalidatePurchase(); syncControls(); message('Price preview closed. No payment was requested.'); });
el('acknowledge-payment').addEventListener('click', () => { payments.acknowledgeUncertain(); invalidatePurchase(); syncControls(); message('Check the remaining prices when you are ready. A previous authorization may still be valid.'); });
window.addEventListener('storage', event => {
  if (event.key !== RESEARCH_STORAGE_KEY && event.key !== null) return;
  refreshStorage();
});
window.addEventListener('beforeunload', event => { if (payments.busy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => receiptUrls.forEach(url => URL.revokeObjectURL(url)));
storageMessage(loaded.warnings); renderLibrary(); renderComparison(); syncControls();
