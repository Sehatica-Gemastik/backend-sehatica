/**
 * Beta-Bernoulli Thompson Sampling utilities.
 * Sampling via Marsaglia-Tsang gamma sampling: Beta(a,b) = X/(X+Y) where X~Gamma(a,1), Y~Gamma(b,1).
 */

function sampleStandardNormal(): number {
  const u1 = Math.random() || Number.MIN_VALUE;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function sampleGamma(shape: number): number {
  if (shape < 1) {
    const u = Math.random() || Number.MIN_VALUE;
    return sampleGamma(1 + shape) * Math.pow(u, 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleStandardNormal();
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Draw one sample from Beta(alpha, beta). Both params must be > 0. */
export function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

/** Thompson Sampling pick: highest Beta(successCount+1, failureCount+1) sample wins. */
export function pickByThompsonSampling<T>(
  candidates: T[],
  getCounts: (item: T) => { successCount: number; failureCount: number },
): T {
  let best = candidates[0];
  let bestSample = -Infinity;

  for (const candidate of candidates) {
    const { successCount, failureCount } = getCounts(candidate);
    const sample = sampleBeta(successCount + 1, failureCount + 1);
    if (sample > bestSample) {
      bestSample = sample;
      best = candidate;
    }
  }

  return best;
}
