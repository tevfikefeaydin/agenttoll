export interface PortfolioToken {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly balance: number | null;
  readonly priceUsd: number | null;
  readonly valueUsd: number | null;
}
export interface PortfolioSummary {
  readonly address: string;
  readonly at: string;
  readonly tokens: readonly PortfolioToken[];
  readonly tokenCount: number | null;
  readonly shown: number | null;
  readonly unpriced: number | null;
  readonly hiddenBelowFloor: number | null;
  readonly minValueUsd: number | null;
  readonly totalUsd: number | null;
  readonly partial: boolean;
  readonly note: string | null;
  readonly source: string | null;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function address(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value)) throw new Error('Invalid portfolio address.');
  return value.toLowerCase();
}
function label(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('Invalid portfolio text.');
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || null;
}
function number(value: unknown, key: string, count = false): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (count && !Number.isSafeInteger(value))) {
    throw new Error(`Invalid portfolio ${key}.`);
  }
  return value;
}

/** Source-reported totals include native ETH; visible ERC20 rows never imply full coverage. */
export function parsePortfolio(value: unknown, expectedWallet: string): PortfolioSummary {
  const wallet = address(expectedWallet);
  if (!record(value) || value.chain !== 'base' || address(value.address) !== wallet) throw new Error('The portfolio does not match this wallet on Base.');
  if (typeof value.at !== 'string' || value.at.length > 40 || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value.at) || !Number.isFinite(Date.parse(value.at)) ||
      new Date(value.at.slice(0, 10) + 'T00:00:00.000Z').toISOString().slice(0, 10) !== value.at.slice(0, 10)) {
    throw new Error('The portfolio has an invalid observation timestamp.');
  }
  if (!Array.isArray(value.tokens) || value.tokens.length > 500) throw new Error('Invalid or oversized portfolio token list.');
  if (value.partial !== undefined && typeof value.partial !== 'boolean') throw new Error('Invalid portfolio partial indicator.');
  const tokenCount = number(value.tokenCount, 'tokenCount', true);
  const shown = number(value.shown, 'shown', true);
  const unpriced = number(value.unpriced, 'unpriced', true);
  const hiddenBelowFloor = number(value.hiddenBelowFloor, 'hiddenBelowFloor', true);
  const minValueUsd = number(value.minValueUsd, 'minValueUsd');
  const totalUsd = number(value.totalUsd, 'totalUsd');
  if ((shown !== null && shown < value.tokens.length) || (tokenCount !== null && tokenCount < (shown ?? value.tokens.length))) {
    throw new Error('The portfolio counts contradict its listed holdings.');
  }
  const notes: string[] = [];
  const sourceNote = label(value.note, 1600);
  if (sourceNote) notes.push(sourceNote);
  const source = label(value.source, 120);
  let partial = value.partial === true;
  if ([tokenCount, shown, unpriced, hiddenBelowFloor, minValueUsd, totalUsd, source].some(field => field === null)) {
    partial = true;
    notes.push('Some totals, counts or source details are unavailable; missing values are unknown.');
  }
  if (!record(value.native)) {
    partial = true;
    notes.push('Native ETH detail is unavailable.');
  } else if (['balance', 'priceUsd', 'valueUsd'].map(key => number((value.native as Record<string, unknown>)[key], `native ${key}`)).some(field => field === null)) {
    partial = true;
    notes.push('Some native ETH values are unknown.');
  }
  let duplicates = 0;
  let unknownTokenValues = false;
  const seen = new Set<string>();
  const tokens: PortfolioToken[] = [];
  for (const row of value.tokens) {
    if (!record(row)) throw new Error('Invalid portfolio token row.');
    const tokenAddress = address(row.address);
    const token: PortfolioToken = Object.freeze({ address: tokenAddress, symbol: label(row.symbol, 64) ?? '?', name: label(row.name, 160) ?? '?',
      balance: number(row.balance, 'token balance'), priceUsd: number(row.priceUsd, 'token price'), valueUsd: number(row.valueUsd, 'token value') });
    if ([token.balance, token.priceUsd, token.valueUsd].some(field => field === null)) unknownTokenValues = true;
    if (seen.has(tokenAddress)) { duplicates++; continue; }
    seen.add(tokenAddress);
    if (tokens.length < 50) tokens.push(token);
  }
  if (unknownTokenValues) { partial = true; notes.push('Some listed token balances or values are unknown.'); }
  if (duplicates) { partial = true; notes.push(`${duplicates} duplicate token rows were omitted; totals and counts remain source-reported.`); }
  if (seen.size > 50) { partial = true; notes.push('Only the first 50 unique token rows are displayed.'); }
  if ((tokenCount !== null && tokenCount > (shown ?? value.tokens.length)) || (shown !== null && shown > value.tokens.length)) {
    partial = true;
    notes.push('The listed holdings are truncated; the reported token count includes rows not shown here.');
  }
  if ((unpriced ?? 0) > 0 || (hiddenBelowFloor ?? 0) > 0) {
    partial = true;
    notes.push('Unpriced tokens and holdings below the value floor are not included in the listed token values.');
  }
  if (value.partial === true && !sourceNote) notes.push('The source marked this lookup as partial without further detail.');
  return Object.freeze({ address: wallet, at: new Date(value.at).toISOString(), tokens: Object.freeze(tokens), tokenCount, shown, unpriced,
    hiddenBelowFloor, minValueUsd, totalUsd, partial, note: notes.length ? notes.join(' ').slice(0, 2500) : null, source });
}
