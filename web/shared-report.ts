import { createReportLink, downloadReportCard, parseSharedReport } from './report-share.js';
import { renderTokenReport } from './token-report.js';
import type { CanonicalReport } from './research-model.js';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const content = element('shared-content');
const report = element('shared-report');
const error = element('shared-error');
const status = element('shared-status');
const reinspect = element<HTMLAnchorElement>('shared-reinspect');
const copy = element<HTMLButtonElement>('shared-copy');
const png = element<HTMLButtonElement>('shared-png');
const fallback = element('share-fallback');
const linkField = element<HTMLInputElement>('shared-link');
let current: CanonicalReport | undefined;

function announce(message: string, failed = false): void {
  status.textContent = message;
  status.dataset.tone = failed ? 'err' : '';
  status.hidden = false;
}

function showSnapshot(focus = false): void {
  current = undefined;
  content.hidden = true;
  report.replaceChildren();
  error.hidden = true;
  status.hidden = true;
  fallback.hidden = true;
  linkField.value = '';
  try {
    const data = parseSharedReport(location.hash);
    report.innerHTML = renderTokenReport(data);
    reinspect.href = '/inspect.html?token=' + encodeURIComponent(data.token);
    current = data;
    content.hidden = false;
    if (focus) report.focus();
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : 'This shared report link could not be opened.';
    error.hidden = false;
    if (focus) error.focus();
  }
}

copy.addEventListener('click', async () => {
  if (!current) return;
  let link: string;
  try { link = createReportLink(current, location.origin); } catch (cause) {
    announce(cause instanceof Error ? cause.message : 'The report link could not be created.', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    fallback.hidden = true;
    announce('Report link copied. It opens as an unverified shared snapshot.');
  } catch {
    fallback.hidden = false;
    linkField.value = link;
    linkField.focus();
    linkField.select();
    announce('Copy the selected link. This browser could not copy it automatically.');
  }
});

png.addEventListener('click', async () => {
  if (!current || png.disabled) return;
  png.disabled = true;
  try {
    await downloadReportCard(current, 'shared');
    announce('PNG card created with the shared snapshot warning and original check time.');
  } catch (cause) {
    announce(cause instanceof Error ? cause.message : 'The PNG card could not be downloaded.', true);
  } finally { png.disabled = false; }
});

window.addEventListener('hashchange', () => showSnapshot(true));
showSnapshot();
