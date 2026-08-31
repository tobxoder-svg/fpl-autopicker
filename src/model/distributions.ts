/**
 * Count distributions used by the xP components.
 *
 * Goals and saves are Poisson. Defensive actions are NOT — the same player
 * swings between 4 and 15 CBIT depending on game state, and Poisson badly
 * understates the fat right tail that actually earns the DEFCON point. Those
 * use a negative binomial.
 */

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function lgamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < 8; i++) a += LANCZOS[i] / (z + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

export function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda + k * Math.log(lambda) - lgamma(k + 1));
}

/** E[floor(X / divisor)] for X ~ Poisson(lambda). Goals conceded, saves. */
export function poissonFloorDiv(lambda: number, divisor: number, kmax = 25): number {
  let sum = 0;
  for (let k = 0; k <= kmax; k++) sum += Math.floor(k / divisor) * poissonPmf(k, lambda);
  return sum;
}

/** P(X >= threshold) for X ~ NegBinomial(mean, dispersion r). */
export function nbinomSf(threshold: number, mean: number, dispersion: number): number {
  if (mean <= 0) return 0;
  const r = dispersion;
  const p = r / (r + mean);
  let pmf = Math.pow(p, r);
  let cdf = pmf;
  for (let k = 1; k < threshold; k++) {
    pmf *= ((k + r - 1) / k) * (1 - p);
    cdf += pmf;
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}

/** Variance of a negative binomial, for the risk-aware objective. */
export function nbinomVar(mean: number, dispersion: number): number {
  return mean + (mean * mean) / dispersion;
}
