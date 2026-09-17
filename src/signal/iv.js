// Black-Scholes implied volatility solver (European, no-dividend index options).
// Inputs are simple; output is annualized vol as a percentage (e.g. 14.25 = 14.25%).
// Returns null if inputs are invalid or solver fails to converge.

const SQRT2 = Math.SQRT2;

function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 approximation.
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / SQRT2;
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function bsPrice(S, K, T, r, sigma, isCall) {
  if (T <= 0 || sigma <= 0) {
    const intrinsic = isCall ? Math.max(0, S - K) : Math.max(0, K - S);
    return intrinsic;
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  if (isCall) return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

function bsVega(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return 0;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  return S * normPdf(d1) * sqrtT;
}

/**
 * Solve for implied volatility (annualized, percent).
 * @param {number} price  Option market price (LTP)
 * @param {number} S      Spot
 * @param {number} K      Strike
 * @param {number} T      Time to expiry in years
 * @param {boolean} isCall true for CE, false for PE
 * @param {number} r      Risk-free rate (annualized, default 0.065 for India)
 * @returns {number|null} IV as percent (e.g. 14.25) or null if not solvable
 */
export function impliedVolatility(price, S, K, T, isCall, r = 0.065) {
  if (!isFinite(price) || price <= 0) return null;
  if (!isFinite(S) || S <= 0) return null;
  if (!isFinite(K) || K <= 0) return null;
  if (!isFinite(T) || T <= 0) return null;

  // Intrinsic-value floor: if price < intrinsic, no real IV exists.
  const intrinsic = isCall ? Math.max(0, S - K * Math.exp(-r * T)) : Math.max(0, K * Math.exp(-r * T) - S);
  if (price < intrinsic - 1e-6) return null;

  // Newton-Raphson with bisection fallback.
  let sigma = 0.25;
  for (let i = 0; i < 50; i++) {
    const p = bsPrice(S, K, T, r, sigma, isCall);
    const v = bsVega(S, K, T, r, sigma);
    if (!isFinite(p) || !isFinite(v) || v < 1e-8) break;
    const diff = p - price;
    if (Math.abs(diff) < 1e-4) return Math.max(0.1, Math.min(500, sigma * 100));
    sigma -= diff / v;
    if (sigma <= 0.001) sigma = 0.001;
    if (sigma > 5) sigma = 5;
  }

  // Bisection fallback for stability.
  let lo = 0.001, hi = 5.0;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    const p = bsPrice(S, K, T, r, mid, isCall);
    if (!isFinite(p)) return null;
    if (p > price) hi = mid; else lo = mid;
    if (hi - lo < 1e-5) return Math.max(0.1, Math.min(500, mid * 100));
  }
  return null;
}

/**
 * Forward (synthetic futures) price from put-call parity at a single strike:
 *     F = (CE - PE) * e^{rT} + K
 * Index options are priced off the FORWARD, not spot. On NIFTY the forward sits
 * 10-25 points above spot intraday, so solving IV against spot pushes every call
 * IV down and every put IV up by ~0.4-0.5 vol points and invents a CE/PE skew
 * that cannot exist — parity forces one IV per strike. Use the ATM strike, where
 * both legs are liquid and the parity residual is smallest.
 *
 * @param {number} ceLtp  ATM call price
 * @param {number} peLtp  ATM put price
 * @param {number} K      ATM strike
 * @param {number} T      Time to expiry in years
 * @param {number} r      Risk-free rate
 * @returns {number|null} Forward price, or null if inputs are unusable
 */
export function forwardFromParity(ceLtp, peLtp, K, T, r = 0.065) {
  if (![ceLtp, peLtp, K, T].every((v) => isFinite(v) && v > 0)) return null;
  const F = (ceLtp - peLtp) * Math.exp(r * T) + K;
  // Sanity band: a forward more than 5% away from the strike it was derived at
  // means a stale or crossed quote, not a real basis.
  if (!isFinite(F) || F <= 0 || Math.abs(F / K - 1) > 0.05) return null;
  return F;
}

/**
 * Implied volatility solved against the FORWARD (Black-76) rather than spot.
 *
 * Black-76 is Black-Scholes evaluated at S = F * e^{-rT}: substituting that into
 * the BS d1 cancels the rT drift term exactly, leaving d1 = (ln(F/K) + sigma^2 T/2)
 * / (sigma sqrt(T)) and price = e^{-rT}[F N(d1) - K N(d2)]. So we can reuse the
 * solver below verbatim instead of maintaining a second one.
 *
 * @param {number} price  Option market price (LTP)
 * @param {number} F      Forward price
 * @param {number} K      Strike
 * @param {number} T      Time to expiry in years
 * @param {boolean} isCall
 * @param {number} r      Risk-free rate
 * @returns {number|null} IV as percent, or null
 */
export function impliedVolatilityFwd(price, F, K, T, isCall, r = 0.065) {
  if (!isFinite(F) || F <= 0 || !isFinite(T) || T <= 0) return null;
  return impliedVolatility(price, F * Math.exp(-r * T), K, T, isCall, r);
}

/**
 * Time to expiry in years, assuming Indian options expire at 15:30 IST.
 * @param {Date} expiryDate Date object pointing at expiry day 15:30 IST
 * @param {number} nowMs    Current epoch ms
 */
export function yearsToExpiry(expiryDate, nowMs = Date.now()) {
  if (!expiryDate) return null;
  const ms = expiryDate.getTime() - nowMs;
  if (ms <= 0) return null;
  return ms / (365 * 24 * 60 * 60 * 1000);
}
