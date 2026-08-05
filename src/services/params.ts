import { badRequest } from "./errors.js";

/**
 * Query-string parsing for the optional knobs on the listing endpoints.
 * Everything here is optional by design — callers get a sensible default when
 * they say nothing, and a 400 (never a silent clamp) when they say something
 * impossible. Silently clamping would bill the caller for an answer to a
 * question they did not ask.
 */

const missing = (raw: string | undefined) => raw === undefined || raw.trim() === "";

export function optionalNumber(
  name: string,
  raw: string | undefined,
  { min, max }: { min: number; max: number },
): number | undefined {
  if (missing(raw)) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    badRequest(`Invalid '${name}' — expected a number between ${min} and ${max}`);
  }
  return n;
}

export function optionalInt(
  name: string,
  raw: string | undefined,
  range: { min: number; max: number },
): number | undefined {
  const n = optionalNumber(name, raw, range);
  if (n !== undefined && !Number.isInteger(n)) {
    badRequest(`Invalid '${name}' — expected a whole number`);
  }
  return n;
}

export function optionalEnum<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (missing(raw)) return undefined;
  const value = raw!.trim().toLowerCase() as T;
  if (!allowed.includes(value)) {
    badRequest(`Invalid '${name}' — expected one of: ${allowed.join(", ")}`);
  }
  return value;
}

/** Comma-separated ticker list, e.g. ?symbols=btc,eth,degen */
export function optionalSymbolList(
  name: string,
  raw: string | undefined,
  max: number,
): string[] | undefined {
  if (missing(raw)) return undefined;
  const list = raw!
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) badRequest(`Invalid '${name}' — expected a comma-separated list of tickers`);
  if (list.length > max) badRequest(`Too many values in '${name}' — at most ${max} per call`);
  for (const symbol of list) {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(symbol)) {
      badRequest(`Invalid ticker '${symbol}' in '${name}'`);
    }
  }
  return Array.from(new Set(list));
}
