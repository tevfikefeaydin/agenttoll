import { createPaymentClient, getNetworkConfig, HOSTED_RECIPIENT, HOSTED_URL } from '../src/payment-policy.js';
import { pay } from './demo.js';
import { escapeHtml, inspectionEndpoint, renderTokenReport, displayUsdc } from './token-report.js';

const CLIENT = 'agenttoll-inspect/1.0.0';
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = element<HTMLFormElement>('inspect-form');
const input = element<HTMLInputElement>('token-address');
const quoteButton = element<HTMLButtonElement>('quote-button');
const payButton = element<HTMLButtonElement>('pay-button');
const retryButton = element<HTMLButtonElement>('retry-button');
const exampleButton = element<HTMLButtonElement>('example-button');
const priceBox = element('price-box');
const status = element('inspection-status');
const report = element('report');
const reportLabel = element('report-label');
const exampleNote = element('example-note');
const download = element<HTMLAnchorElement>('report-download');
const exampleHtml = report.innerHTML;
let downloadUrl: string | undefined;
let quoteRequest: AbortController | undefined;
let sequence = 0;
let paying = false;
let authorizationPossible = false;
let displayed: { path: string; token: string; quote: unknown; recipient: string; at: number } | undefined;

function show(html: string, tone: 'quote' | 'ok' | 'err' | 'wait' = 'quote') {
  status.innerHTML = html;
  status.dataset.tone = tone;
  status.hidden = !html;
}

function invalidateQuote() {
  sequence++;
  quoteRequest?.abort();
  quoteRequest = undefined;
  displayed = undefined;
  priceBox.hidden = true;
  quoteButton.disabled = paying || authorizationPossible;
  quoteButton.textContent = 'Check price →';
}

async function checkPrice() {
  if (paying || authorizationPossible) return;
  invalidateQuote();
  input.removeAttribute('aria-invalid');
  let path: string;
  try { path = inspectionEndpoint(input.value); }
  catch (error) {
    input.setAttribute('aria-invalid', 'true');
    show(escapeHtml((error as Error).message), 'err');
    input.focus();
    return;
  }
  const current = sequence;
  const controller = new AbortController();
  quoteRequest = controller;
  const timer = setTimeout(() => controller.abort(), 12_000);
  quoteButton.disabled = true;
  quoteButton.textContent = 'Checking price…';
  show('Checking the price. Your wallet will not be prompted.', 'wait');
  try {
    const identityResponse = await fetch('/.well-known/agent-card.json', { signal: controller.signal, redirect: 'error', cache: 'no-store' });
    if (!identityResponse.ok) throw new Error('The payment configuration could not be loaded. Try checking the price again.');
    const identity = await identityResponse.json();
    const recipient = identity?.identity?.payTo;
    const chain = identity?.interfaces?.http?.payment?.network;
    const network = chain === 'eip155:8453' ? 'base' : chain === 'eip155:84532' ? 'base-sepolia' : undefined;
    if (!network || typeof recipient !== 'string') throw new Error('The payment configuration is incomplete. No payment was requested.');
    if (location.origin === HOSTED_URL && recipient.toLowerCase() !== HOSTED_RECIPIENT.toLowerCase()) {
      throw new Error('The payment recipient differs from the AgentToll configuration. No payment was requested.');
    }
    const client = createPaymentClient(network, undefined, { baseUrl: location.origin, recipient, totalBudgetUsdc: '0', timeoutMs: 10_000 });
    const result = await client.getPaymentQuote(path, { signal: controller.signal, headers: { 'X-AgentToll-Client': CLIENT }, cache: 'no-store' });
    if (current !== sequence) return;
    displayed = { path, token: path.split('/').at(-1)!, quote: result.quote, recipient, at: Date.now() };
    const amount = displayUsdc(result.amountUsdc);
    element('quote-amount').textContent = amount;
    element('quote-network').textContent = `Pay with USDC on ${getNetworkConfig(network).name}.`;
    element('quote-recipient').textContent = recipient;
    payButton.textContent = `Pay ${amount} USDC and inspect`;
    payButton.disabled = false;
    priceBox.hidden = false;
    show('Price ready. Continue when you are ready to approve in your wallet.', 'quote');
  } catch (error) {
    if (current !== sequence) return;
    show(controller.signal.aborted ? 'The price check timed out. No payment was requested. Try again.' : escapeHtml((error as Error).message), 'err');
  } finally {
    clearTimeout(timer);
    if (current === sequence) {
      quoteRequest = undefined;
      quoteButton.disabled = false;
      quoteButton.textContent = 'Check price again →';
    }
  }
}

form.addEventListener('submit', event => { event.preventDefault(); void checkPrice(); });
input.addEventListener('input', () => {
  if (paying) return;
  invalidateQuote();
  input.removeAttribute('aria-invalid');
  if (!authorizationPossible) show('');
});

function setDownload(data: unknown, token: string) {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
  download.href = downloadUrl;
  download.download = `agenttoll-${token}.json`;
  download.textContent = 'Download report data';
}

payButton.addEventListener('click', async () => {
  if (paying || authorizationPossible || !displayed) return;
  if (Date.now() - displayed.at > 60_000) {
    await checkPrice();
    if (displayed) show('The price has been refreshed. Review it and press Pay to continue.', 'quote');
    return;
  }
  const terms = displayed;
  paying = true;
  input.disabled = quoteButton.disabled = payButton.disabled = exampleButton.disabled = true;
  try {
    const outcome = await pay(terms.path, show, { quote: terms.quote, recipient: terms.recipient, client: CLIENT, showRaw: false });
    if (outcome.status === 'delivered') {
      // Preserve the delivered bytes even if an unexpected payload cannot be presented.
      setDownload(outcome.data, terms.token);
      exampleButton.hidden = false;
      exampleNote.hidden = true;
      try {
        const html = renderTokenReport(outcome.data, terms.token);
        report.innerHTML = html;
        reportLabel.textContent = 'Your report';
        report.focus({ preventScroll: true });
        report.scrollIntoView({ behavior: 'instant', block: 'start' });
      } catch (error) {
        report.innerHTML = `<div class="price-box"><h2>Response received</h2><p>${escapeHtml((error as Error).message)}</p><p>You can download the received data below.</p></div>`;
        reportLabel.textContent = 'Response needs review';
        // Keep the receipt in the status; do not offer an immediate second payment.
        authorizationPossible = outcome.signed;
      }
      displayed = undefined;
      priceBox.hidden = true;
    } else {
      authorizationPossible = outcome.authorizationPossible;
      if (authorizationPossible) { displayed = undefined; priceBox.hidden = true; }
    }
  } finally {
    paying = false;
    input.disabled = exampleButton.disabled = false;
    quoteButton.disabled = authorizationPossible;
    payButton.disabled = false;
    retryButton.hidden = !authorizationPossible;
  }
});

retryButton.addEventListener('click', () => {
  if (paying) return;
  authorizationPossible = false;
  retryButton.hidden = true;
  void checkPrice();
});

exampleButton.addEventListener('click', () => {
  if (paying) return;
  report.innerHTML = exampleHtml;
  reportLabel.textContent = 'Recorded example';
  exampleNote.hidden = false;
  exampleButton.hidden = true;
  if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = undefined; }
  download.href = '/token-example.json';
  download.download = 'agenttoll-recorded-example.json';
  download.textContent = 'Download example data';
});

quoteButton.disabled = false;
