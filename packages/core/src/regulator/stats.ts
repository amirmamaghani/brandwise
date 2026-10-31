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

/**
 * The smallest relative lift (0.3 = 30 %) an A/B test with `nPerArm` recipients per arm can show reliably (two-sided 5 % significance,
 * 80 % power) when the base rate is `rate`. Smaller effects will end inconclusive however real they are: the experiment is underpowered.
 */
export function minDetectableLift(rate: number, nPerArm: number): number | null {
  if (!(rate > 0) || rate >= 1 || nPerArm <= 0) return null;
  return ((1.96 + 0.8416) * Math.sqrt((2 * rate * (1 - rate)) / nPerArm)) / rate;
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
