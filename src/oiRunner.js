// Live OI tracker — no paper trading, no history, no persistence.
// Polls the NIFTY option chain every 30 seconds and surfaces a rolling
// in-memory list of today's ticks via getOiState().

import { loadInstruments, fetchQuotes } from "./brokers/angelMarketData.js";
import { appendSnapshot } from "./signal/oiSnapshotWriter.js";
import { onOiTick as autoPaperTick, openTradeLegs, refreshOpenMarks } from "./paper/autoPaperTrader.js";
import { marketStatus as getMarketStatus } from "./marketClock.js";
import { impliedVolatilityFwd, forwardFromParity, yearsToExpiry } from "./signal/iv.js";

const POLL_SEC = 30;
const LOOKBACK_MIN = 15;
// Strike chain uses a longer window so build-up vs short-covering is readable.
// 15 min is too noisy for per-strike classification.
const STRIKE_LOOKBACK_MIN = 60;
const STRIKE_STEP = 50;
// Strike window is PINNED for the whole trading day at open-ATM +/- DAY_BAND.
// It used to re-center on live ATM, which swapped a deep strike in/out of the
// window and moved Total Call/Put OI (and therefore PCR) by up to 10% in a
// single tick with no trade behind it. 15 strikes = +/-750 pts, wider than
// NIFTY's daily range, so the band still covers the market without moving.
const DAY_BAND = 15;
// PCR is still read over ATM +/- 5, and that band DOES follow live ATM - which
// is correct, and safe now that the pinned window always has those strikes.
const PCR_BAND = 5;

const istNow = () =>
  new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
const fmtIST = (d = istNow()) => d.toTimeString().slice(0, 8);
const istDateKey = () => {
  const d = istNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function parseExpiry(s) {
  const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const m = s.match(/^(\d{2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const [, dd, mon, yy] = m;
  const month = months[mon];
  if (month == null) return null;
  return new Date(2000 + parseInt(yy, 10), month, parseInt(dd, 10), 15, 30);
}

function findNearestWeeklyExpiry(instruments) {
  const today = istNow();
  let best = null;
  for (const [, inst] of instruments) {
    if (inst.exchange !== "NFO") continue;
    if (!inst.symbol || !inst.symbol.startsWith("NIFTY")) continue;
    if (inst.instrumentType !== "OPTIDX") continue;
    if (inst.name !== "NIFTY") continue;
    const m = inst.symbol.match(/^NIFTY(\d{2}[A-Z]{3}\d{2})(\d+)(CE|PE)$/);
    if (!m) continue;
    const expDate = parseExpiry(m[1]);
    if (!expDate || expDate < today) continue;
    if (!best || expDate < best.date) best = { date: expDate, str: m[1] };
  }
  return best;
}

function pickStrikes(instruments, expiryStr, atm, band = DAY_BAND) {
  const offsets = [];
  for (let k = -band; k <= band; k++) offsets.push(k);
  const wanted = offsets.map((k) => atm + k * STRIKE_STEP);
  const out = [];
  for (const strike of wanted) {
    for (const side of ["CE", "PE"]) {
      const sym = `NIFTY${expiryStr}${strike}${side}`;
      const inst = instruments.get(`NFO:${sym}`);
      if (inst) out.push({ ...inst, strike, side });
    }
  }
  return out;
}

function findNiftyIndex(instruments) {
  const candidates = [];
  for (const [, inst] of instruments) {
    if (inst.exchange !== "NSE") continue;
    const sym  = (inst.symbol || "").toUpperCase();
    const name = (inst.name   || "").toUpperCase();
    const itype = (inst.instrumentType || "").toUpperCase();
    const isIndex = itype === "AMXIDX" || itype === "INDEX" || itype === "";
    if (!isIndex) continue;
    if (sym === "NIFTY" || sym === "NIFTY 50" || sym === "NIFTY50" ||
        name === "NIFTY 50" || name === "NIFTY") {
      candidates.push({ inst, score: sym.replace(/\s/g,"") === "NIFTY50" ? 3 : name === "NIFTY 50" ? 2 : 1 });
    }
  }
  candidates.sort((a,b) => b.score - a.score);
  return candidates[0]?.inst || null;
}

// Sum OI change only over strikes present in BOTH snapshots. A strike entering
// or leaving the window (when the ATM re-centers) contributes nothing, so a
// total taken over a shifting strike set can no longer fake OI "flow".
function matchedOiDelta(refByStrike, curByStrike) {
  let ceDelta = 0, peDelta = 0;
  if (!refByStrike || !curByStrike) return { ceDelta, peDelta };
  for (const k of Object.keys(curByStrike)) {
    const cur = curByStrike[k];
    const ref = refByStrike[k];
    if (!ref) continue;
    if (cur.ce?.oi != null && ref.ce?.oi != null) ceDelta += cur.ce.oi - ref.ce.oi;
    if (cur.pe?.oi != null && ref.pe?.oi != null) peDelta += cur.pe.oi - ref.pe.oi;
  }
  return { ceDelta, peDelta };
}

// Day-cumulative OI change vs the day's first tick, summed per strike. This is
// the number every other option-chain platform shows as "OI Chg" and it is the
// actual writing signal: a snapshot PCR is dominated by OI carried over from
// previous days and barely moves intraday, while the day-change PCR swings hard
// when one side is being written. Baseline is the day's first tick, so it is
// "since tracker start", not since previous close — the Angel quote API does not
// expose previous-day OI. Start the tracker at 09:15 and the two coincide.
function dayDelta(base, cur) {
  let ceDelta = 0, peDelta = 0;
  if (!base || !cur) return { ceDelta: null, peDelta: null, pcrChange: null };
  for (const k of Object.keys(cur)) {
    const c = cur[k], b = base[k];
    if (!b) continue;
    if (c.ce?.oi != null && b.ce?.oi != null) ceDelta += c.ce.oi - b.ce.oi;
    if (c.pe?.oi != null && b.pe?.oi != null) peDelta += c.pe.oi - b.pe.oi;
  }
  // Only meaningful when both sides actually added OI; unwinding on either side
  // makes the ratio meaningless rather than "very bullish".
  const pcrChange = (ceDelta > 0 && peDelta > 0) ? round(peDelta / ceDelta, 3) : null;
  return { ceDelta, peDelta, pcrChange };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Confidence weights — must sum to 1. Structural cap: with price diverging
// (priceFactor 0) the max reachable score is w_pcr + w_flow = 0.70, so a
// divergent tick can never clear ~70% no matter how strong the OI flow.
const CONF_W = { pcr: 0.30, flow: 0.40, price: 0.30 };

function computeBias(history, latest) {
  const cutoff = latest.ts - LOOKBACK_MIN * 60 * 1000;
  let ref = null;
  for (const h of history) { if (h.ts <= cutoff) ref = h; else break; }
  if (!ref) return { ready: false };

  // Per-strike matched deltas — robust to the ATM window shifting between ref and now.
  const { ceDelta, peDelta } = matchedOiDelta(ref.byStrike, latest.byStrike);
  const netFlow = peDelta - ceDelta;
  const pcrOI = latest.peTotal / Math.max(latest.ceTotal, 1);

  // Normalize against the recent distribution of matched deltas vs the window base.
  const recent = history.slice(-60);
  const base = recent[0];
  const ceDeltas = recent.map(h => matchedOiDelta(base.byStrike, h.byStrike).ceDelta);
  const peDeltas = recent.map(h => matchedOiDelta(base.byStrike, h.byStrike).peDelta);
  const std = (xs) => {
    const m = xs.reduce((a,b)=>a+b,0)/Math.max(xs.length,1);
    return Math.sqrt(xs.reduce((a,b)=>a+(b-m)**2,0)/Math.max(xs.length,1)) || 1;
  };
  const ceN = ceDelta / std(ceDeltas);
  const peN = peDelta / std(peDeltas);
  const net = peN - ceN;

  // ---- Fix #3: price / trend confirmation ----
  // Direction the OI (seller-view) bias points, and the direction spot actually
  // moved over the same lookback. A deadband of 0.03% of spot ignores flat noise.
  const biasDir = Math.abs(netFlow) > 10000 ? (net > 0 ? 1 : net < 0 ? -1 : 0) : 0;
  const priceChg = (latest.spot != null && ref.spot != null) ? latest.spot - ref.spot : 0;
  const priceBand = (latest.spot ?? 0) * 0.0003;
  const priceDir = priceChg > priceBand ? 1 : priceChg < -priceBand ? -1 : 0;
  const confirmed = biasDir !== 0 && priceDir === biasDir;
  const divergence = biasDir !== 0 && priceDir !== 0 && priceDir !== biasDir;

  // Bias polarity — option-WRITER (seller) view, the standard OI-writing read:
  //   net > 0  => puts written faster than calls => support building => BULLISH
  //   net < 0  => calls written faster => resistance building => BEARISH
  // Do NOT invert this to "trade as a buyer". To trade against the signal use the
  // FADE book in paper/autoPaperTrader.js — that keeps this label correct while
  // still letting you test fading. See memory: auto-paper-follow-vs-fade.
  // "Strong" is only emitted when spot CONFIRMS the OI direction (Fix #3);
  // otherwise a strong OI reading against price is downgraded to plain
  // directional and flagged as a divergence for the UI / paper trader.
  let bias = "Neutral";
  if (Math.abs(netFlow) > 10000) {
    if (net > 1.5)        bias = confirmed ? "Strong Bullish" : "Bullish";
    else if (net > 0.5)   bias = "Bullish";
    else if (net < -1.5)  bias = confirmed ? "Strong Bearish" : "Bearish";
    else if (net < -0.5)  bias = "Bearish";
  }

  // ---- Fix #1: multi-factor bounded confidence (replaces |net|*40 saturation) ----
  //   PCR conviction  — how far PCR sits from the neutral 1.0 (½-unit = full).
  //   Flow conviction — normalized net writing strength, |net|/3 = full.
  //   Price factor    — 1 when spot confirms, 0 when it diverges, 0.5 when flat.
  const pcrConv  = clamp01(Math.abs(pcrOI - 1.0) / 0.5);
  const flowConv = clamp01(Math.abs(net) / 3);
  const priceFactor = confirmed ? 1 : divergence ? 0 : 0.5;
  const strength = round(
    (CONF_W.pcr * pcrConv + CONF_W.flow * flowConv + CONF_W.price * priceFactor) * 100,
    0
  );

  return {
    ready: true,
    ceDelta, peDelta, netFlow, pcrOI: round(pcrOI, 3),
    ceN: round(ceN, 2), peN: round(peN, 2), net: round(net, 2),
    bias,
    divergence,
    priceDir,
    priceChg: round(priceChg, 2),
    strength,
  };
}

// ---------- runner state (single in-process run at a time) ----------
let state = null;

function freshState() {
  return {
    status: "starting",
    startedAt: Date.now(),
    day: istDateKey(),
    ticks: [],   // newest-first, today's ticks only
    error: null,
    atm: null,
    expiry: null,
    spotOpen: null,
    forward: null,   // synthetic futures price from ATM put-call parity
    dayAtm: null,    // ATM at first tick of the day; the pinned window's centre
    dayBase: null,   // byStrike snapshot of the day's first tick (OI baseline)
    dayBaseAt: null, // IST time that baseline was taken
    ohlc: null,  // { open, high, low, close, ltp, ts }
    strikes: [], // [{ strike, ceOI, peOI, ceLtp, peLtp, ceDelta, peDelta, atm }]
  };
}

export function getOiState() {
  if (!state) return { status: "idle", ticks: [] };
  // Drop any ticks not from today (defensive — loop already resets at IST rollover).
  const today = istDateKey();
  const ticksToday = state.ticks.filter(t => t.day === today);
  return {
    status: state.status,
    startedAt: state.startedAt,
    atm: state.atm,
    dayAtm: state.dayAtm,
    expiry: state.expiry,
    spotOpen: state.spotOpen,
    forward: state.forward,
    dayBaseAt: state.dayBaseAt,
    error: state.error,
    ohlc: state.ohlc,
    strikes: state.strikes || [],
    ticks: ticksToday.slice(0, 1000),
  };
}

export function stopOiTest() {
  if (!state) return { ok: true, message: "not running" };
  state.status = "stopping";
  return { ok: true };
}

// Kept as a no-op for backward compatibility with any cached frontend.
export function updateOiParams() {
  return { ok: true };
}

export async function startOiTest({ jwtToken, apiKey }) {
  if (state && (state.status === "running" || state.status === "starting")) {
    throw new Error("OI tracker already running. Stop it first.");
  }
  if (!jwtToken || !apiKey) throw new Error("jwtToken and apiKey required");
  state = freshState();

  (async () => {
    try {
      const instruments = await loadInstruments();
      const niftyIdx = findNiftyIndex(instruments);
      if (!niftyIdx) throw new Error("NIFTY 50 index instrument not found");

      const idxQuote = await fetchQuotes(jwtToken, apiKey, [{
        exchange: niftyIdx.exchange, token: niftyIdx.token, symbol: "NIFTY50",
      }]);
      const spot = idxQuote.NIFTY50?.ltp;
      if (!spot) throw new Error("Failed to fetch NIFTY 50 spot");
      const atm = Math.round(spot / STRIKE_STEP) * STRIKE_STEP;
      state.atm = atm;
      state.dayAtm = atm;
      state.spotOpen = spot;

      let expiry = findNearestWeeklyExpiry(instruments);
      if (!expiry) throw new Error("No NIFTY weekly expiry found");
      state.expiry = expiry.str;

      let optTokens = pickStrikes(instruments, expiry.str, atm);
      if (optTokens.length === 0) throw new Error("No option tokens resolved around ATM");

      // Contract lot size from the instrument master. NIFTY's lot has moved
      // (75 -> 65); a hardcoded constant silently scales every P&L by the wrong
      // factor, so read it from the same rows we are already quoting.
      let lotSize = optTokens.find(t => t.lotSize)?.lotSize || null;

      // In-memory only — never persisted.
      let history = [];
      state.status = "running";

      while (state.status === "running" || state.status === "paused-market-closed") {
        try {
          // Market-hours gate — skip polling Angel when market is closed.
          const ms = getMarketStatus();
          if (!ms.trading) {
            state.status = "paused-market-closed";
            state.marketReason = ms.status + (ms.holiday ? ` (${ms.holiday})` : "");
            // sleep 30 sec, re-check (don't burn API quota)
            for (let i = 0; i < 30 && state.status === "paused-market-closed"; i++) {
              await new Promise(r => setTimeout(r, 1000));
            }
            continue;
          } else if (state.status === "paused-market-closed") {
            state.status = "running";
            state.marketReason = null;
          }

          // IST day rollover: reset ticks + bias history so the table shows today only.
          const curDay = istDateKey();
          if (curDay !== state.day) {
            state.day = curDay;
            state.ticks = [];
            history = [];
            // New day: drop the OI baseline, re-pin the strike window on the new
            // open, and re-resolve the expiry (the weekly contract rolls, and a
            // long-running process would otherwise keep quoting a dead one).
            state.dayBase = null;
            state.dayBaseAt = null;
            const rolled = findNearestWeeklyExpiry(instruments);
            if (rolled) { expiry = rolled; state.expiry = rolled.str; }
            const openAtm = Math.round((state.ohlc?.ltp ?? state.atm) / STRIKE_STEP) * STRIKE_STEP;
            state.atm = openAtm;
            state.dayAtm = openAtm;
            const repinned = pickStrikes(instruments, expiry.str, openAtm);
            if (repinned.length > 0) {
              optTokens = repinned;
              lotSize = optTokens.find(t => t.lotSize)?.lotSize || lotSize;
            }
          }

          const tokens = [
            { exchange: niftyIdx.exchange, token: niftyIdx.token, symbol: "NIFTY50" },
            ...optTokens.map(t => ({ exchange: t.exchange, token: t.token, symbol: t.symbol })),
          ];
          const q = await fetchQuotes(jwtToken, apiKey, tokens);
          const idx = q.NIFTY50 || {};
          const curSpot = idx.ltp ?? spot;

          // Track live ATM for the ATM-band PCR and the UI highlight. The token
          // window itself is NOT rebuilt here — it stays pinned at dayAtm for the
          // whole session (see DAY_BAND). Re-picking tokens mid-session is what
          // used to swap strikes in/out of the totals and fake 10% OI jumps.
          if (Math.abs(curSpot - state.atm) > STRIKE_STEP * 0.75) {
            const newAtm = Math.round(curSpot / STRIKE_STEP) * STRIKE_STEP;
            if (newAtm !== state.atm) state.atm = newAtm;
          }
          state.ohlc = {
            ltp: idx.ltp ?? null,
            open: idx.open ?? null,
            high: idx.high ?? null,
            low: idx.low ?? null,
            close: idx.close ?? null,
            ts: Date.now(),
          };

          let ceTotal = 0, peTotal = 0;
          // strike -> { ce: { oi, ltp, volume, iv }, pe: { oi, ltp, volume, iv } }
          const byStrike = {};
          const expDate = parseExpiry(state.expiry);
          const T = yearsToExpiry(expDate);

          // Pass 1 — quotes only. IV needs the forward, and the forward needs the
          // ATM call and put, so it cannot be computed inside this loop.
          for (const t of optTokens) {
            const row = q[t.symbol];
            if (!row) continue;
            if (!byStrike[t.strike]) byStrike[t.strike] = { ce: null, pe: null };
            const cell = {
              oi: row.opnInterest ?? null,
              ltp: row.ltp ?? null,
              volume: row.tradeVolume ?? null,
              iv: null,
            };
            if (t.side === "CE") byStrike[t.strike].ce = cell;
            else                 byStrike[t.strike].pe = cell;
            if (row.opnInterest != null) {
              if (t.side === "CE") ceTotal += row.opnInterest;
              else                 peTotal += row.opnInterest;
            }
          }

          // Synthetic forward from put-call parity at the live ATM strike. Index
          // options are priced off the forward; solving IV against spot biases
          // call IV down / put IV up and invents a CE-PE skew parity forbids.
          const atmCell = byStrike[state.atm] || {};
          const fwd = (T != null)
            ? forwardFromParity(atmCell.ce?.ltp, atmCell.pe?.ltp, state.atm, T)
            : null;
          state.forward = fwd != null ? round(fwd, 2) : null;

          // Pass 2 — IV against the forward (falls back to spot only if parity
          // was unusable, e.g. a crossed or stale ATM quote).
          const ivRef = fwd ?? curSpot;
          if (T != null && ivRef != null) {
            for (const k of Object.keys(byStrike)) {
              const strike = +k;
              for (const side of ["ce", "pe"]) {
                const cell = byStrike[k][side];
                if (!cell || cell.ltp == null) continue;
                cell.iv = impliedVolatilityFwd(cell.ltp, ivRef, strike, T, side === "ce");
              }
            }
          }

          const latest = { ts: Date.now(), ceTotal, peTotal, spot: curSpot, byStrike };

          // First tick of the day sets the OI baseline everything is measured from.
          if (!state.dayBase) {
            state.dayBase = byStrike;
            state.dayBaseAt = fmtIST();
          }
          const day = dayDelta(state.dayBase, byStrike);

          // Exchange OI refreshes once a MINUTE; this loop polls every 30s, so
          // ~30% of ticks carry no new OI at all and the next one carries a
          // double-sized jump. Flag those so the UI can mute them and the paper
          // trader can stop counting a repeat as an independent confirmation.
          const prevTick = state.ticks[0];
          const oiChanged = !prevTick
            || prevTick.ceTotal !== ceTotal
            || prevTick.peTotal !== peTotal;

          // ATM-band PCR (±5 strikes) alongside the full-window PCR. The full
          // number (peTotal / ceTotal) covers the pinned
          // ±15-strike window we poll; the band number follows live ATM and is
          // how most desks read PCR intraday. Neither is "all strikes", so both
          // are scoped in the UI. Both are now stable: the window no longer
          // moves, so a PCR change means OI changed, not that a strike swapped in.
          let ceBand = 0, peBand = 0;
          for (const k of Object.keys(byStrike)) {
            if (Math.abs((+k - state.atm) / STRIKE_STEP) > PCR_BAND) continue;
            const c = byStrike[k];
            if (c.ce?.oi != null) ceBand += c.ce.oi;
            if (c.pe?.oi != null) peBand += c.pe.oi;
          }
          const pcrBandOI = ceBand > 0 ? round(peBand / ceBand, 3) : null;

          // Build per-strike chain view with delta vs STRIKE_LOOKBACK_MIN ago.
          const cutoff = latest.ts - STRIKE_LOOKBACK_MIN * 60 * 1000;
          let refTick = null;
          for (const h of history) { if (h.ts <= cutoff) refTick = h; else break; }
          const strikes = Object.keys(byStrike)
            .map(s => +s)
            .sort((a, b) => a - b)
            .map(strike => {
              const cur = byStrike[strike] || {};
              const ref = refTick?.byStrike?.[strike] || {};
              const ceCur = cur.ce?.oi ?? null;
              const peCur = cur.pe?.oi ?? null;
              const ceRef = ref.ce?.oi ?? null;
              const peRef = ref.pe?.oi ?? null;
              const ceLtpCur = cur.ce?.ltp ?? null;
              const peLtpCur = cur.pe?.ltp ?? null;
              const ceLtpRef = ref.ce?.ltp ?? null;
              const peLtpRef = ref.pe?.ltp ?? null;
              const ceIvCur  = cur.ce?.iv ?? null;
              const peIvCur  = cur.pe?.iv ?? null;
              const ceIvRef  = ref.ce?.iv ?? null;
              const peIvRef  = ref.pe?.iv ?? null;
              const ceVolCur = cur.ce?.volume ?? null;
              const peVolCur = cur.pe?.volume ?? null;
              const pcrOiCur = (peCur != null && ceCur)   ? peCur / ceCur : null;
              const pcrOiRef = (peRef != null && ceRef)   ? peRef / ceRef : null;
              const pcrVol   = (peVolCur != null && ceVolCur) ? peVolCur / ceVolCur : null;
              return {
                strike,
                ceOI: ceCur,
                peOI: peCur,
                ceLtp: ceLtpCur,
                peLtp: peLtpCur,
                ceVol: ceVolCur,
                peVol: peVolCur,
                ceIv: ceIvCur,
                peIv: peIvCur,
                ceIvDelta: (ceIvCur != null && ceIvRef != null) ? ceIvCur - ceIvRef : null,
                peIvDelta: (peIvCur != null && peIvRef != null) ? peIvCur - peIvRef : null,
                ceDelta: (ceCur != null && ceRef != null) ? ceCur - ceRef : null,
                peDelta: (peCur != null && peRef != null) ? peCur - peRef : null,
                ceLtpDelta: (ceLtpCur != null && ceLtpRef != null) ? ceLtpCur - ceLtpRef : null,
                peLtpDelta: (peLtpCur != null && peLtpRef != null) ? peLtpCur - peLtpRef : null,
                pcrOi: pcrOiCur,
                pcrOiDelta: (pcrOiCur != null && pcrOiRef != null) ? pcrOiCur - pcrOiRef : null,
                pcrVol,
                atm: strike === state.atm,
              };
            });
          state.strikes = strikes;

          // Persist canonical snapshot for the signal engine.
          try {
            appendSnapshot({
              symbol: "NIFTY",
              expiryStr: state.expiry,
              spot: curSpot,
              vix: null,
              byStrike,
            });
          } catch {}

          history.push(latest);
          if (history.length > 240) history.splice(0, history.length - 240);
          const r = computeBias(history, latest);

          state.ticks.unshift({
            ts: latest.ts,
            tsIST: fmtIST(),
            day: curDay,
            spot: curSpot,
            ceTotal, peTotal,
            ceDelta: r.ceDelta ?? null,
            peDelta: r.peDelta ?? null,
            netFlow: r.netFlow ?? null,
            pcrOI: r.pcrOI ?? null,
            pcrBandOI,
            ceDayDelta: day.ceDelta,
            peDayDelta: day.peDelta,
            pcrDayChange: day.pcrChange,
            oiChanged,
            forward: state.forward,
            net: r.net ?? null,
            bias: r.ready ? r.bias : "WARMUP",
            divergence: r.divergence ?? false,
            priceDir: r.priceDir ?? null,
            strength: r.strength ?? null,
          });
          if (state.ticks.length > 1000) state.ticks.length = 1000;

          // Auto paper trader (FOLLOW vs FADE books) reacts to the live bias.
          // Self-guarded; never throws into the poll loop.
          autoPaperTick({
            ts: latest.ts,
            tsIST: fmtIST(),
            day: curDay,
            spot: curSpot,
            atm: state.atm,
            bias: r.ready ? r.bias : null,
            net: r.net ?? null,
            strength: r.strength ?? null,
            divergence: r.divergence ?? false,
            oiChanged,
            lotSize,
            byStrike,
          });
        } catch (e) {
          // Swallow transient poll errors; loop continues.
        }

        for (let i = 0; i < POLL_SEC && state.status === "running"; i++) {
          await new Promise(r => setTimeout(r, 1000));

          // Fast LTP-only refresh (~1s) so the UI's live premium / MTM on open
          // paper trades doesn't sit frozen between the 30s OI ticks. Fetches
          // only the open legs' option tokens (+ index) — a tiny batched request
          // — and updates the display mark. Runs NO exit/entry logic, so trade
          // behavior stays on the slow cadence above. Self-guarded.
          try {
            const legs = openTradeLegs();
            if (legs.length) {
              const want = new Set(legs.map(l => `${l.strike}${l.optType}`));
              const legToks = optTokens.filter(t => want.has(`${t.strike}${t.side}`));
              const fastTokens = [
                { exchange: niftyIdx.exchange, token: niftyIdx.token, symbol: "NIFTY50" },
                ...legToks.map(t => ({ exchange: t.exchange, token: t.token, symbol: t.symbol })),
              ];
              const fq = await fetchQuotes(jwtToken, apiKey, fastTokens);
              const fByStrike = {};
              for (const t of legToks) {
                const row = fq[t.symbol];
                if (!row) continue;
                if (!fByStrike[t.strike]) fByStrike[t.strike] = { ce: null, pe: null };
                const cell = { ltp: row.ltp ?? null };
                if (t.side === "CE") fByStrike[t.strike].ce = cell;
                else                 fByStrike[t.strike].pe = cell;
              }
              refreshOpenMarks({
                ts: Date.now(),
                tsIST: fmtIST(),
                spot: fq.NIFTY50?.ltp ?? state.ohlc?.ltp ?? state.atm,
                byStrike: fByStrike,
              });
            }
          } catch {
            // Transient fast-poll error — ignore; next OI tick still refreshes.
          }
        }
      }

      state.status = "finished";
    } catch (e) {
      if (state) {
        state.status = "error";
        state.error = e.message;
      }
    }
  })();

  return { ok: true, status: state.status };
}
