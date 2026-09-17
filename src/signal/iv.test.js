// Run: node src/signal/iv.test.js
// Guards the two things that were actually wrong: IV solved against spot instead
// of the forward (which invented a CE/PE skew put-call parity forbids), and the
// day-cumulative OI delta that the runner reports as the writing signal.

import assert from "node:assert/strict";
import { impliedVolatility, impliedVolatilityFwd, forwardFromParity } from "./iv.js";

const T = 5 / 365;
const K = 23300;
// Live NIFTY 22SEP26 quotes, 2026-09-17 12:44 IST. Spot was 23347.20 and
// Sensibull's synthetic future was 23369.54.
const CE = 160.55, PE = 95.75, SPOT = 23347.20;

// --- forward recovers the real basis, not spot ------------------------------
const F = forwardFromParity(CE, PE, K, T);
assert.ok(F > SPOT, `forward ${F} should sit above spot ${SPOT}`);
assert.ok(Math.abs(F - 23369.54) < 10, `forward ${F} should land near the observed 23369.54`);

// --- parity: one IV per strike ----------------------------------------------
const fwdCE = impliedVolatilityFwd(CE, F, K, T, true);
const fwdPE = impliedVolatilityFwd(PE, F, K, T, false);
assert.ok(Math.abs(fwdCE - fwdPE) < 0.01,
  `forward-based CE/PE IV must agree (got ${fwdCE} vs ${fwdPE})`);

// --- and the old spot-based path really did skew ----------------------------
const spotCE = impliedVolatility(CE, SPOT, K, T, true);
const spotPE = impliedVolatility(PE, SPOT, K, T, false);
assert.ok(Math.abs(spotCE - spotPE) > 0.2,
  "spot-based IV should show the phantom skew this fix removes");

// --- bad input is rejected, not guessed at ----------------------------------
assert.equal(forwardFromParity(0, PE, K, T), null);
assert.equal(forwardFromParity(CE, PE, K, 0), null);
// A crossed quote implying a >5% basis is a stale feed, not a real forward.
assert.equal(forwardFromParity(2000, 1, K, T), null);
assert.equal(impliedVolatilityFwd(CE, null, K, T, true), null);

// --- day-cumulative OI delta (mirrors dayDelta in oiRunner.js) --------------
function dayDelta(base, cur) {
  let ceDelta = 0, peDelta = 0;
  if (!base || !cur) return { ceDelta: null, peDelta: null, pcrChange: null };
  for (const k of Object.keys(cur)) {
    const c = cur[k], b = base[k];
    if (!b) continue;
    if (c.ce?.oi != null && b.ce?.oi != null) ceDelta += c.ce.oi - b.ce.oi;
    if (c.pe?.oi != null && b.pe?.oi != null) peDelta += c.pe.oi - b.pe.oi;
  }
  const pcrChange = (ceDelta > 0 && peDelta > 0)
    ? Math.round((peDelta / ceDelta) * 1000) / 1000 : null;
  return { ceDelta, peDelta, pcrChange };
}

const base = { 23300: { ce: { oi: 100 }, pe: { oi: 100 } }, 23350: { ce: { oi: 50 }, pe: { oi: 50 } } };
const cur  = { 23300: { ce: { oi: 110 }, pe: { oi: 200 } }, 23350: { ce: { oi: 50 }, pe: { oi: 100 } } };
const d = dayDelta(base, cur);
assert.equal(d.ceDelta, 10);
assert.equal(d.peDelta, 150);
assert.equal(d.pcrChange, 15);  // heavy put writing -> strongly bullish

// A strike absent from the baseline contributes nothing, so a window that
// changes shape can never fake flow.
const widened = { ...cur, 23400: { ce: { oi: 9e9 }, pe: { oi: 9e9 } } };
assert.deepEqual(dayDelta(base, widened), d);

// Unwinding on either side makes the ratio meaningless rather than "bullish".
assert.equal(dayDelta(base, { 23300: { ce: { oi: 90 }, pe: { oi: 200 } } }).pcrChange, null);

console.log("iv + day-delta self-check passed");
