import { normalizeToken, sanitizeReport } from './research-model.js';
import { addWatch, readResearchStore, saveReport, writeResearchStore, type ReportOrigin } from './research-store.js';
import { createReportLink, downloadReportCard } from './report-share.js';

/** Browser research controls share the inspector's currently displayed report. */
export function mountInspectionResearch() {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const save = element<HTMLButtonElement>('save-report');
  const copy = element<HTMLButtonElement>('copy-report-link');
  const image = element<HTMLButtonElement>('download-report-image');
  const keep = element<HTMLInputElement>('keep-report');
  const status = element('report-actions-status');
  let current: ReturnType<typeof sanitizeReport> | undefined;
  let origin: ReportOrigin = 'example';
  let revision = 0;
  let busy = false;
  const announce = (message: string) => { status.textContent = message; status.hidden = !message; };
  async function displayedReport() {
    if (current) return current;
    const sequence = revision;
    const response = await fetch('/token-example.json', { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error('The example could not be loaded. Try again.');
    const example = await response.json();
    if (sequence !== revision || busy) throw new Error('The displayed report changed. Use the action again for the current report.');
    if (example.kind !== 'recorded-example') throw new Error('The example report format was not recognized.');
    current = sanitizeReport(example.data);
    return current;
  }
  function storeReport(data: unknown, token: string, reportOrigin: ReportOrigin) {
    const existing = readResearchStore();
    let next = saveReport(existing.store, data, reportOrigin);
    try { next = addWatch(next, token); } catch { /* Preserve the report even when the watchlist is full. */ }
    const result = writeResearchStore(next);
    announce(result.saved ? (reportOrigin === 'example' ? 'Example saved with its original date. Open My research to see it.' : 'Report saved in this browser. Open My research to see its history.') : result.warnings.join(' ') || 'The report could not be saved in this browser. You can still download it.');
  }
  async function action(button: HTMLButtonElement, run: () => Promise<void>) {
    if (busy || button.disabled) return;
    button.disabled = true;
    try { await run(); } catch (error) { announce((error as Error).message); }
    finally { button.disabled = busy; }
  }
  save.addEventListener('click', () => void action(save, async () => { const data = await displayedReport(); storeReport(data, data.token, origin); }));
  copy.addEventListener('click', () => void action(copy, async () => {
    const data = await displayedReport();
    const link = createReportLink(data, location.origin);
    try { await navigator.clipboard.writeText(link); announce('Snapshot link copied. The shared page labels its contents as unverified.'); }
    catch {
      announce('Copy the snapshot link below. Your browser could not copy it automatically.');
      const field = document.createElement('textarea'); field.readOnly = true; field.value = link; field.setAttribute('aria-label', 'Snapshot link to copy'); status.append(field); field.focus(); field.select();
    }
  }));
  image.addEventListener('click', () => void action(image, async () => { await downloadReportCard(await displayedReport(), origin); announce('Report image prepared with the observation date and evidence coverage.'); }));
  for (const button of [save, copy, image]) button.disabled = false;
  return {
    setBusy(value: boolean) { busy = value; for (const control of [save, copy, image, keep]) control.disabled = value; },
    delivered(data: unknown, expectedToken: string) {
      revision++; current = sanitizeReport(data, normalizeToken(expectedToken)); origin = 'inspection'; save.textContent = 'Save to watchlist'; announce('');
      if (keep.checked) storeReport(current, current.token, origin);
    },
    example() { revision++; current = undefined; origin = 'example'; save.textContent = 'Save example'; announce(''); },
  };
}
