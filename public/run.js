(function () {
  "use strict";

  // The captured run, verbatim. Each entry is [text, className, pauseAfterMs].
  var RAW = [
    ["──────────────────────────────────────────────────────────────────", "l-rule", 0],
    ["  1. There is no API key. There is a price.", "l-beat", 0],
    ["──────────────────────────────────────────────────────────────────", "l-rule", 240],
    ["  GET https://agenttoll.app/api/base/fresh", "", 520],
    ["", "", 0],
    ["  HTTP 402  Payment required", "l-key", 0],
    ["  price     $0.004 USDC", "l-key", 0],
    ["  network   eip155:8453   (Base mainnet)", "", 0],
    ["  payTo     0xe55359021a6a22d8385b827405991c56075f56f8", "", 260],
    ["", "", 0],
    ["  The quote rides in the response header, and it carries this", "l-note", 0],
    ["  endpoint's request and response schema with it - so an agent that", "l-note", 0],
    ["  has only ever seen a 402 already knows how to call us.", "l-note", 1500],
    ["", "", 0],
    ["──────────────────────────────────────────────────────────────────", "l-rule", 0],
    ["  2. The agent pays it, inline, and gets the data.", "l-beat", 0],
    ["──────────────────────────────────────────────────────────────────", "l-rule", 240],
    ["  wallet    0x29d7837A1c19890d2ab123999e9cf8BFE40985B0", "", 0],
    ["  paying...", "", 1100],
    ["", "", 0],
    ["  HTTP 200  in 1861ms", "l-key", 0],
    ["  settled   0x497b3a3cf839872d046a8fd9822ab9557d3dcd64cb78166a2f631d1ebd9668cf", "l-key", 0],
    ["            https://basescan.org/tx/0x497b3a3cf839872d046a8fd9822ab9557d3dcd64cb78166a2f631d1ebd9668cf", "link", 320],
    ["", "", 0],
    ["  That is the whole business model. No account was created, no key", "l-note", 0],
    ["  was issued, and nothing is charged when a request fails.", "l-note", 1500],
    ["", "", 0],
    ["──────────────────────────────────────────────────────────────────", "l-rule", 0],
    ["  3. What we sell: seeing a pool before the indexers do.", "l-beat", 0],
    ["──────────────────────────────────────────────────────────────────", "l-rule", 240],
    ["  Uniswap v4 pools created in the last 15 minutes: 23", "", 0],
    ["  read from Base block 49785673", "", 0],
    ["  youngest one is 8 seconds old", "l-key", 400],
    ["", "", 0],
    ["  launched token    0x56070acae557ab77ef9b00c6c0f7d5c3a270cace", "l-key", 0],
    ["  age               8 seconds", "l-key", 0],
    ["  funded already    not yet", "", 0],
    ["  hook              shared by 16 pools (a launchpad's)", "", 320],
    ["", "", 0],
    ["  Read straight off the PoolManager's own Initialize log, so a pool", "l-note", 0],
    ["  surfaces about a block after it exists. No indexer sits in the path,", "l-note", 0],
    ["  which is the entire reason this is worth paying for.", "l-note", 1500],
    ["", "", 0],
    ["──────────────────────────────────────────────────────────────────", "l-rule", 0],
    ["  4. Then the question that actually matters: is it a trap?", "l-beat", 0],
    ["──────────────────────────────────────────────────────────────────", "l-rule", 240],
    ["  GET https://agenttoll.app/api/base/safety/0x56070acae557ab77ef9b00c6c0f7d5c3a270cace", "", 0],
    ["  paying $0.003...", "", 1100],
    ["", "", 0],
    ["  token     VITALIK  VITALIK", "", 0],
    ["  VERDICT   HIGH-RISK", "l-fail", 0],
    ["  settled   0x1cb0c2edde23a2f51127a3b2e2907e98f07bead85806814596dcd2aa58f9e235", "", 420],
    ["", "", 0],
    ["    warn    honeypot         Static analysis found no trap, but a live buy/sell could n", "l-warn", 0],
    ["    pass    taxes            Buy tax 0%, sell tax 0%", "l-pass", 0],
    ["    unknown deployer         No creator is on record for this contract — it is either t", "l-unknown", 0],
    ["    pass    owner-powers     No dangerous owner privileges found", "l-pass", 0],
    ["    fail    verified         Contract source is not published — its behaviour cannot be", "l-fail", 0],
    ["    unknown concentration    Holder distribution unavailable", "l-unknown", 500],
    ["", "", 0],
    ["  Note what it did NOT do: on a token this young the public sources", "l-note", 0],
    ["  have no holder or liquidity data yet, and it says so rather than", "l-note", 0],
    ["  filling the gap. A token we cannot verify is never called clear -", "l-note", 0],
    ["  that restraint is the product.", "l-note", 1600],
    ["", "", 0],
    ["──────────────────────────────────────────────────────────────────", "l-rule", 0],
    ["  5. And then: were we right?", "l-beat", 0],
    ["──────────────────────────────────────────────────────────────────", "l-rule", 240],
    ["  Every day, a CI job buys one scout call and commits the result to", "", 0],
    ["  public git, with the Base transaction that paid for it inside.", "", 320],
    ["", "", 0],
    ["  https://github.com/tevfikefeaydin/agenttoll/tree/main/data/scout", "link", 320],
    ["", "", 0],
    ["  So a verdict cannot be quietly rewritten after the fact. Anyone can", "l-note", 0],
    ["  check what we flagged, on the date we flagged it, and what happened", "l-note", 0],
    ["  to it since. Nobody else in this ecosystem publishes that.", "l-note", 1500],
    ["", "", 0],
    ["──────────────────────────────────────────────────────────────────", "l-rule", 0],
    ["  20 paid endpoints. $0.001 to $0.008 a call. USDC on Base, via x402.", "l-key", 0],
    ["  Open source, MIT. MCP server on npm as agenttoll-mcp.", "", 0],
    ["  https://agenttoll.app", "link", 0],
    ["──────────────────────────────────────────────────────────────────", "l-rule", 0]
  ];

  var screen = document.getElementById("screen");
  var toggle = document.getElementById("toggle");
  var restart = document.getElementById("restart");
  var skip = document.getElementById("skip");
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var index = 0;
  var timer = null;
  var running = false;
  var cursor = null;

  function render(text, cls) {
    var el = document.createElement("span");
    if (cls === "link") {
      var a = document.createElement("a");
      var trimmed = text.trim();
      a.href = trimmed;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = trimmed;
      el.appendChild(document.createTextNode(text.slice(0, text.indexOf(trimmed))));
      el.appendChild(a);
    } else {
      if (cls) el.className = cls;
      el.textContent = text;
    }
    screen.appendChild(el);
    screen.appendChild(document.createTextNode("\n"));
  }

  function placeCursor() {
    if (cursor) cursor.remove();
    cursor = document.createElement("span");
    cursor.className = "cursor";
    screen.appendChild(cursor);
  }

  function step() {
    if (index >= RAW.length) {
      running = false;
      toggle.textContent = "Replay";
      if (cursor) cursor.remove();
      return;
    }
    var entry = RAW[index++];
    render(entry[0], entry[1]);
    placeCursor();
    var wait = 58 + (entry[2] || 0);
    timer = setTimeout(step, wait);
  }

  function start() {
    running = true;
    toggle.textContent = "Pause";
    step();
  }

  function stop() {
    running = false;
    clearTimeout(timer);
    toggle.textContent = "Play";
  }

  function showAll() {
    stop();
    screen.textContent = "";
    for (var i = 0; i < RAW.length; i++) render(RAW[i][0], RAW[i][1]);
    index = RAW.length;
    toggle.textContent = "Replay";
    if (cursor) { cursor.remove(); cursor = null; }
  }

  function reset() {
    stop();
    screen.textContent = "";
    index = 0;
    start();
  }

  toggle.addEventListener("click", function () {
    if (running) { stop(); return; }
    if (index >= RAW.length) { reset(); return; }
    start();
  });
  restart.addEventListener("click", reset);
  skip.addEventListener("click", showAll);

  if (reduced) {
    showAll();
  } else {
    start();
  }
})();
