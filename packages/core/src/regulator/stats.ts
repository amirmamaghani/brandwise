// Small, pure statistics for comparing two rates. No dependencies.

/** Standard normal CDF (Abramowitz and Stegun 7.1.26, error below 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Wilson score interval of k successes in n trials. */
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n, z2 = z * z, denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** (z of a two-sided 5 % test + z of 80 % power) squared: 7.85. */
const POWER_K = (1.96 + 0.8416) ** 2;

/** Recipients per arm an A/B test needs to show a change from rate p1 to p2 (two-sided 5 %, 80 % power), each arm with its own variance. */
export function requiredPerArm(p1: number, p2: number): number {
  return (POWER_K * (p1 * (1 - p1) + p2 * (1 - p2))) / (p2 - p1) ** 2;
}

/**
 * The smallest relative lift (0.3 = 30 %) an A/B test with `nPerArm` recipients per arm can show reliably (two-sided 5 % significance,
 * 80 % power) when the base rate is `rate`. Smaller effects will end inconclusive however real they are: the experiment is underpowered.
 * Solves requiredPerArm(rate, rate x (1 + lift)) = nPerArm; null when no lift up to a rate of 1 is detectable.
 */
export function minDetectableLift(rate: number, nPerArm: number): number | null {
  if (!(rate > 0) || rate >= 1 || nPerArm <= 0) return null;
  let lo = 0, hi = (1 - rate) / rate - 1e-9;
  if (requiredPerArm(rate, rate * (1 + hi)) > nPerArm) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (requiredPerArm(rate, rate * (1 + mid)) > nPerArm) lo = mid; else hi = mid;
  }
  return hi;
}

/** For rare events (leads, orders): how many events the control arm needs to show a relative effect r. */
export const eventsNeeded = (r: number) => (POWER_K * (2 + r)) / (r * r);

/** How many rounds of `perRound` recipients per arm make `expectedLift` detectable at `rate`; null when even `max` rounds are not enough. */
export function roundsNeeded(rate: number, perRound: number, expectedLift: number, max = 20): number | null {
  for (let k = 1; k <= max; k++) {
    const mde = minDetectableLift(rate, perRound * k);
    if (mde !== null && mde <= expectedLift) return k;
  }
  return null;
}

/** One 2x2 table of a series: clicks k out of n in arm A and arm B. */
export type Stratum = { kA: number; nA: number; kB: number; nB: number };

/**
 * Cochran-Mantel-Haenszel test over the rounds of a series (each round a stratum, so a different audience per send is fine) and the
 * Mantel-Haenszel common rate ratio of B against A. Two-sided, no continuity correction (like `compareRates`).
 */
export function cmh(strata: Stratum[]): { z: number; p: number; rateRatio: number | null; lift: number | null } {
  let dev = 0, variance = 0, num = 0, den = 0;
  for (const s of strata) {
    const N = s.nA + s.nB, m1 = s.kA + s.kB, m0 = N - m1;
    if (N < 2 || s.nA === 0 || s.nB === 0) continue;
    dev += s.kB - (s.nB * m1) / N;
    variance += (s.nA * s.nB * m1 * m0) / (N * N * (N - 1));
    num += (s.kB * s.nA) / N;
    den += (s.kA * s.nB) / N;
  }
  const z = variance > 0 ? dev / Math.sqrt(variance) : 0;
  const rateRatio = den > 0 ? num / den : null;
  return { z, p: 2 * (1 - normalCdf(Math.abs(z))), rateRatio, lift: rateRatio === null ? null : rateRatio - 1 };
}

/** log Gamma (Lanczos, g = 7): enough for binomial probabilities of e-mail sizes. */
function lgamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
const binomPmf = (k: number, n: number, p: number) => (p <= 0 ? (k === 0 ? 1 : 0) : p >= 1 ? (k === n ? 1 : 0) : Math.exp(lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log(1 - p)));

/**
 * Exact conditional test for rare events (leads, orders): given kA + kB events, under "no difference" kB follows a binomial with the
 * share of B's audience. `fewer` is the one-sided p that B has fewer than A; `p` is two-sided (the sum of outcomes no likelier than kB).
 */
export function exactRateTest(kA: number, nA: number, kB: number, nB: number): { p: number; fewer: number; rateRatio: number | null } {
  const n = kA + kB, share = nB / (nA + nB || 1);
  const probs = Array.from({ length: n + 1 }, (_, k) => binomPmf(k, n, share));
  const obs = probs[kB];
  const p = Math.min(1, probs.filter((x) => x <= obs * (1 + 1e-7)).reduce((t, x) => t + x, 0));
  const fewer = Math.min(1, probs.slice(0, kB + 1).reduce((t, x) => t + x, 0));
  return { p, fewer, rateRatio: kA > 0 && nB > 0 ? (kB / nB) / (kA / nA) : null };
}

/** One-sided: is B's rate (of complaints, unsubscribes) higher than A's? Small p = B is worse. */
export function worseOneSided(kA: number, nA: number, kB: number, nB: number): number {
  const pooled = nA + nB > 0 ? (kA + kB) / (nA + nB) : 0;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / (nA || 1) + 1 / (nB || 1)));
  if (se === 0) return 1;
  return 1 - normalCdf((kB / (nB || 1) - kA / (nA || 1)) / se);
}

export type RateComparison = { rateA: number; rateB: number; lift: number | null; z: number; p: number };

/** Two-sided two-proportion z-test (pooled). lift is the relative change of B against A (null when A is 0). */
export function compareRates(kA: number, nA: number, kB: number, nB: number): RateComparison {
  const rateA = nA > 0 ? kA / nA : 0, rateB = nB > 0 ? kB / nB : 0;
  const pooled = nA + nB > 0 ? (kA + kB) / (nA + nB) : 0;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / (nA || 1) + 1 / (nB || 1)));
  const z = se > 0 ? (rateB - rateA) / se : 0;
  return { rateA, rateB, lift: rateA > 0 ? (rateB - rateA) / rateA : null, z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}
