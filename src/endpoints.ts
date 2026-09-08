import { DISCOVERY } from './discovery.js';

/** Canonical endpoint identities, descriptions and prices. */
const definitions = [
  {
    "route": "GET /api/price/:symbol",
    "price": "$0.001",
    "description": "Token price lookup: spot price in USD and 24h change for a crypto asset, by ticker or CoinGecko id",
    "tool": "get_price"
  },
  {
    "route": "GET /api/gas",
    "price": "$0.001",
    "description": "Base gas price check: the current gas price and latest block number; add ?gasLimit=150000 to also get what a transaction that size costs in ETH and USD",
    "tool": "get_base_gas"
  },
  {
    "route": "GET /api/trending",
    "price": "$0.002",
    "description": "Trending token scan: the tokens moving across the crypto market right now; ?limit=N trims the list",
    "tool": "get_trending"
  },
  {
    "route": "GET /api/base/token/:address",
    "price": "$0.001",
    "description": "Base token price lookup by contract address: the onchain USD price for any token on Base",
    "tool": "get_base_token_price"
  },
  {
    "route": "GET /api/base/address/:address",
    "price": "$0.001",
    "description": "Base wallet lookup: an address's primary basename, ETH balance, transaction count, and whether it is a contract",
    "tool": "get_base_address_info"
  },
  {
    "route": "GET /api/feargreed",
    "price": "$0.001",
    "description": "Crypto market sentiment check: the Fear and Greed index with yesterday's value; ?days=7 adds a daily history so you can see whether sentiment is turning",
    "tool": "get_fear_greed"
  },
  {
    "route": "GET /api/base/trending",
    "price": "$0.002",
    "description": "Trending Base pool scan: the DEX pools moving on Base right now, with price, 24h volume and liquidity; ?limit=N sets how many",
    "tool": "get_base_trending_pools"
  },
  {
    "route": "GET /api/brief",
    "price": "$0.005",
    "description": "Market brief in one call: prices (BTC, ETH and SOL by default, or ?symbols=eth,degen), Base gas, and market sentiment",
    "tool": "get_market_brief"
  },
  {
    "route": "GET /api/base/radar",
    "price": "$0.003",
    "description": "New token radar on Base with a liquidity floor: pools created in the last 24 hours that already hold real liquidity; ?minLiquidity sets the spam floor in USD, default 10000. Each pool carries its token address, so anything interesting can go straight to /api/base/safety",
    "tool": "get_new_token_radar"
  },
  {
    "route": "GET /api/try/premium",
    "price": "$0.002",
    "description": "Turkish lira crypto premium check: implied USD/TRY from a crypto cross-rate versus the official rate; ?asset=usdt is the reading desks quote",
    "tool": "get_try_premium"
  },
  {
    "route": "GET /api/try/spread",
    "price": "$0.002",
    "description": "Turkish exchange spread check: BTCTurk and Paribu's TRY quotes converted back to USD via the official rate and compared against the global price; ?asset=usdt is the pair with the deepest local volume",
    "tool": "get_try_spread"
  },
  {
    "route": "GET /api/base/portfolio/:address",
    "price": "$0.003",
    "description": "Wallet portfolio on Base: everything an address holds valued in USD, ETH plus its ERC-20 tokens, largest first, with a spam floor you set",
    "tool": "get_base_portfolio"
  },
  {
    "route": "GET /api/base/safety/:address",
    "price": "$0.003",
    "description": "Token safety check for a Base token before you buy - is it a honeypot, is it a rug: a simulated buy and sell, buy and sell tax, contract verification, owner privileges, holder concentration, whether anyone can still pull the liquidity, and who deployed the contract - a token shipped from a wallet with a handful of transactions is the shape most rugs share",
    "tool": "check_token_safety"
  },
  {
    "route": "GET /api/base/scout",
    "price": "$0.008",
    "description": "New token scan with a safety verdict attached: today's new Base pools above your liquidity floor, each already checked for honeypot, taxes and owner powers. One call instead of N+1",
    "tool": "scout_new_tokens"
  },
  {
    "route": "GET /api/base/fresh",
    "price": "$0.004",
    "description": "New pair scan seconds after launch: Uniswap v4 pools read straight off Base before any indexer has them - the launched token address, whether anyone has funded it yet, and whether its hook is a launchpad's or bespoke code shipped with this token",
    "tool": "get_fresh_pools"
  },
  {
    "route": "GET /api/base/radar/history",
    "price": "$0.002",
    "description": "Published radar snapshot pinned to an immutable git revision. The payment receipt proves payment, not snapshot content or capture time. ?date=YYYY-MM-DD, default latest",
    "tool": "get_radar_history"
  },
  {
    "route": "GET /api/base/scorecard",
    "price": "$0.005",
    "description": "Radar sample scorecard: first sightings across the latest N published snapshots, grouped by original verdict and compared to current quotes. Missing outcomes stay null; observed liquidity below $100 is reported separately; holding periods vary",
    "tool": "get_radar_scorecard"
  },
  {
    "route": "GET /api/base/name/:nameOrAddress",
    "price": "$0.001",
    "description": "Basename lookup both ways: a name returns its address and text records, an address returns its primary basename",
    "tool": "resolve_basename"
  },
  {
    "route": "GET /api/watch/address/:address",
    "price": "$0.002",
    "description": "Wallet activity watch: new activity for a Base address since your cursor, so a scheduled agent only fetches what changed",
    "tool": "watch_base_address"
  },
  {
    "route": "GET /api/watch/radar",
    "price": "$0.003",
    "description": "New pool watch within a limited ranked radar listing. Returns an ISO cursor and explicit partial coverage; the listing can omit pools",
    "tool": "watch_new_tokens"
  },
  {
    "route": "GET /api/watch/price/:symbol",
    "price": "$0.001",
    "description": "Price alert check: whether an asset moved past your threshold from a reference price",
    "tool": "watch_price_alert"
  }
] as const;

export const ENDPOINTS = definitions.map((endpoint) => {
  const [whole, fraction = ''] = endpoint.price.slice(1).split('.');
  const amount = (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString();
  const path = endpoint.route.replace(/^GET /, '').replace(/:([A-Za-z]+)/g, '{$1}');
  const discovery = DISCOVERY[endpoint.route];
  if (!discovery) throw new Error('Missing discovery for ' + endpoint.route);
  return { ...endpoint, path, amount, discovery };
});
