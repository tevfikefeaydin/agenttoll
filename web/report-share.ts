import { sanitizeReport, summarizeReport, type CanonicalReport, type ReportSummary } from './research-model.js';

const SHARE_VERSION = 1;
const MAX_PAYLOAD_BYTES = 15_000;
const MAX_ENCODED_LENGTH = 20_000;
const PREFIX = '#report=';
const TOO_LARGE = 'This report is too large to share in a link. Download its data or PNG card instead.';
const INVALID_LINK = 'This shared report link is invalid or incomplete. Ask the sender for a new link.';

export type ReportProvenance = 'inspection' | 'example' | 'shared';
type CardTone = 'blue' | 'amber' | 'red';
export interface ReportCard {
  token: string;
  name: string;
  symbol: string;
  observedAt: string | null;
  dateLabel: string;
  provenance: ReportProvenance;
  provenanceLabel: string;
  provenanceNote: string;
  completed: number;
  flags: number;
  warnings: number;
  coverage: string;
  heading: string;
  headingTone: CardTone;
  checks: { id: string; title: string; status: string; complete: boolean; label: string; tone: CardTone }[];
}

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Share only the bounded report whitelist. The fragment is never a server-side report ID. */
export function createReportLink(data: unknown, origin: string): string {
  let base: URL;
  try { base = new URL(origin); } catch { throw new Error('A valid HTTP or HTTPS site origin is required to share a report.'); }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('A valid HTTP or HTTPS site origin is required to share a report.');
  }
  const payload = JSON.stringify({ version: SHARE_VERSION, report: sanitizeReport(data) });
  const bytes = new TextEncoder().encode(payload);
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) throw new Error(TOO_LARGE);
  const encoded = encode(bytes);
  if (encoded.length > MAX_ENCODED_LENGTH) throw new Error(TOO_LARGE);
  return `${base.origin}/shared-report.html${PREFIX}${encoded}`;
}

/** Decode a user-supplied snapshot; this never authenticates, fetches, pays or saves it. */
export function parseSharedReport(hash: string): CanonicalReport {
  if (typeof hash !== 'string') throw new Error(INVALID_LINK);
  if (hash.length > PREFIX.length + MAX_ENCODED_LENGTH) throw new Error(TOO_LARGE);
  if (!hash.startsWith(PREFIX)) throw new Error(INVALID_LINK);
  const encoded = hash.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) throw new Error(INVALID_LINK);
  let value: unknown;
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4));
    if (binary.length > MAX_PAYLOAD_BYTES) throw new Error(TOO_LARGE);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (encode(bytes) !== encoded) throw new Error(INVALID_LINK);
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof Error && error.message === TOO_LARGE) throw error;
    throw new Error(INVALID_LINK);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID_LINK);
  const envelope = value as Record<string, unknown>;
  if (envelope.version !== SHARE_VERSION) throw new Error('This shared snapshot uses an unsupported version. Ask the sender for a current report link.');
  try { return sanitizeReport(envelope.report); } catch { throw new Error(INVALID_LINK); }
}

const provenanceText: Record<ReportProvenance, { label: string; note: string }> = {
  inspection: { label: 'Inspection snapshot', note: 'Original check time is retained. Cached reports are not a fresh inspection.' },
  example: { label: 'Recorded example', note: 'A dated example of provider data. This is not a new inspection.' },
  shared: { label: 'Shared snapshot · unverified', note: 'The sender supplied this snapshot. AgentToll has not authenticated its contents.' },
};
const headings: Record<ReportSummary['verdict'], string> = {
  'high-risk': 'Risk flags found',
  caution: 'Review the warnings',
  'insufficient-data': 'Evidence is incomplete',
  clear: 'No flags in completed checks',
};

/** Content used directly by the PNG renderer, derived from the same conservative report summary. */
export function buildReportCard(data: unknown, provenance: ReportProvenance): ReportCard {
  if (!Object.hasOwn(provenanceText, provenance)) throw new Error('Choose an inspection, example or shared report provenance.');
  const summary = summarizeReport(data);
  const source = provenanceText[provenance];
  return {
    token: summary.token, name: summary.name, symbol: summary.symbol, observedAt: summary.at,
    dateLabel: summary.at ? new Date(summary.at).toISOString().replace('T', ' ').replace('Z', ' UTC') : 'Time unavailable',
    provenance, provenanceLabel: source.label, provenanceNote: source.note,
    completed: summary.completed, flags: summary.flags, warnings: summary.warnings,
    coverage: `${summary.completed} of 8 checks complete`, heading: headings[summary.verdict],
    headingTone: summary.flags ? 'red' : summary.warnings || summary.completed < 8 ? 'amber' : 'blue',
    checks: summary.checks.map(check => ({
      id: check.id, title: check.title, status: check.status, complete: check.complete,
      label: ({ pass: 'Checked', warn: 'Review', fail: 'Risk flag', unknown: 'Not available' })[check.status]
        + (!check.complete && (check.status === 'warn' || check.status === 'fail') ? ' · incomplete' : ''),
      tone: check.status === 'pass' ? 'blue' : check.status === 'fail' ? 'red' : 'amber',
    })),
  };
}

const palette = { background: '#070B14', surface: '#0E1524', line: '#263248', text: '#EAF0FA', muted: '#9BA8BF', blue: '#91B5FF', amber: '#F1C574', red: '#FFA0A0' };
const sans = '"Segoe UI", system-ui, sans-serif';
const mono = 'Consolas, "Cascadia Code", monospace';

function fittedText(context: CanvasRenderingContext2D, value: string, x: number, y: number, maxWidth: number, size: number, minimum = size): void {
  let fontSize = size;
  const font = () => { context.font = `600 ${fontSize}px ${sans}`; };
  font();
  while (fontSize > minimum && context.measureText(value).width > maxWidth) { fontSize--; font(); }
  let points = Array.from(value);
  if (context.measureText(value).width > maxWidth) {
    while (points.length && context.measureText(points.join('') + '…').width > maxWidth) points.pop();
    value = points.join('') + '…';
  }
  context.fillText(value, x, y);
}

function drawCard(context: CanvasRenderingContext2D, card: ReportCard): void {
  const width = 1200;
  context.fillStyle = palette.background;
  context.fillRect(0, 0, width, 1200);
  context.textBaseline = 'alphabetic';
  context.fillStyle = '#0052FF';
  context.fillRect(60, 56, 32, 32);
  context.fillStyle = palette.text;
  context.font = `650 30px ${sans}`;
  context.fillText('AgentToll', 106, 83);
  context.fillStyle = palette.blue;
  context.font = `22px ${sans}`;
  context.textAlign = 'right';
  context.fillText('BASE / TOKEN REPORT', 1140, 81);
  context.textAlign = 'left';

  context.fillStyle = palette.surface;
  context.fillRect(60, 116, 1080, 94);
  context.fillStyle = palette.amber;
  context.font = `600 23px ${sans}`;
  context.fillText(card.provenanceLabel, 82, 151);
  context.fillStyle = palette.muted;
  context.font = `20px ${sans}`;
  context.fillText(card.provenanceNote, 82, 186);

  context.fillStyle = palette.text;
  fittedText(context, card.name + (card.symbol && card.symbol !== card.name ? ` (${card.symbol})` : ''), 60, 275, 1080, 44, 28);
  context.fillStyle = palette.blue;
  context.font = `23px ${mono}`;
  context.fillText(card.token, 60, 321);
  context.fillStyle = card.observedAt ? palette.muted : palette.amber;
  context.font = `22px ${sans}`;
  context.fillText(`Checked: ${card.dateLabel}`, 60, 363);

  context.fillStyle = palette[card.headingTone];
  context.font = `600 32px ${sans}`;
  context.fillText(card.heading, 60, 423);
  context.fillStyle = palette.surface;
  context.fillRect(60, 449, 1080, 111);
  for (const metric of [
    { x: 84, label: 'EVIDENCE COVERAGE', value: card.coverage, tone: card.completed < 8 ? palette.amber : palette.text },
    { x: 670, label: 'RISK FLAGS', value: String(card.flags), tone: card.flags ? palette.red : palette.text },
    { x: 945, label: 'WARNINGS', value: String(card.warnings), tone: card.warnings ? palette.amber : palette.text },
  ]) {
    context.fillStyle = palette.muted;
    context.font = `17px ${sans}`;
    context.fillText(metric.label, metric.x, 485);
    context.fillStyle = metric.tone;
    context.font = `600 28px ${sans}`;
    context.fillText(metric.value, metric.x, 527);
  }

  card.checks.forEach((check, index) => {
    const y = 607 + index * 54;
    context.strokeStyle = palette.line;
    context.lineWidth = 1;
    context.beginPath(); context.moveTo(60, y + 19); context.lineTo(1140, y + 19); context.stroke();
    context.fillStyle = palette.text;
    context.font = `23px ${sans}`;
    context.fillText(check.title, 76, y);
    context.fillStyle = palette[check.tone];
    context.font = `21px ${sans}`;
    context.textAlign = 'right';
    context.fillText(check.label, 1124, y);
    context.textAlign = 'left';
  });

  context.fillStyle = palette.muted;
  context.font = `20px ${sans}`;
  context.fillText('Automated checks can miss risks. Passing a check does not make a token safe.', 60, 1062);
  context.fillText('This card retains the original observation. Source freshness can vary.', 60, 1094);
  context.fillStyle = palette.blue;
  context.font = `19px ${sans}`;
  context.fillText('agenttoll.app', 60, 1150);
  context.fillStyle = palette.muted;
  context.textAlign = 'right';
  context.fillText('Eight checks · No safety guarantee', 1140, 1150);
  context.textAlign = 'left';
}

/** User-triggered local Canvas export. It loads no remote fonts, images or provider data. */
export async function downloadReportCard(data: unknown, provenance: ReportProvenance): Promise<void> {
  const card = buildReportCard(data, provenance);
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 1200;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Your browser cannot create a PNG card. Download the report data instead.');
  drawCard(context, card);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => {
    if (result) resolve(result);
    else reject(new Error('The PNG card could not be created. Please try again.'));
  }, 'image/png'));
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `agenttoll-${provenance}-${card.token}-${card.observedAt?.slice(0, 10) ?? 'undated'}.png`;
  document.body.append(anchor);
  try { anchor.click(); } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
