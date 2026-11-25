// Audio analysis computed in the browser: waveform peaks, STFT spectrogram, energy onsets.

/** Min/max per bucket for drawing a waveform at `buckets` columns. */
export function peaks(samples: Float32Array, buckets: number, from = 0, to = samples.length) {
  const n = Math.max(1, Math.floor(buckets));
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  const span = Math.max(1, to - from);
  for (let i = 0; i < n; i++) {
    const a = from + Math.floor((i * span) / n);
    const b = Math.max(a + 1, from + Math.floor(((i + 1) * span) / n));
    let lo = Infinity,
      hi = -Infinity;
    for (let j = a; j < b && j < samples.length; j++) {
      const v = samples[j];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[i] = lo === Infinity ? 0 : lo;
    max[i] = hi === -Infinity ? 0 : hi;
  }
  return { min, max };
}

/** In-place iterative radix-2 FFT. `re` and `im` length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1,
        ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export interface Spectrogram {
  frames: number;
  bins: number;
  hop: number;
  size: number;
  /** dB values, row-major [frame][bin]. */
  db: Float32Array;
  minDb: number;
  maxDb: number;
}

/** Hann-windowed short-time Fourier transform magnitude in dB. */
export function spectrogram(samples: Float32Array, size = 512, hop = 256): Spectrogram {
  const bins = size / 2;
  const frames = Math.max(1, Math.floor((samples.length - size) / hop) + 1);
  const db = new Float32Array(frames * bins);
  const win = new Float64Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let minDb = Infinity,
    maxDb = -Infinity;
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < size; i++) {
      re[i] = (samples[off + i] ?? 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bins; b++) {
      const v = 20 * Math.log10(Math.hypot(re[b], im[b]) + 1e-9);
      db[f * bins + b] = v;
      if (v < minDb) minDb = v;
      if (v > maxDb) maxDb = v;
    }
  }
  return { frames, bins, hop, size, db, minDb, maxDb };
}

/**
 * Energy-based event detection: RMS envelope over `win` seconds, threshold at
 * `k` x median envelope, merge gaps shorter than `minGap`, drop events shorter than `minLen`.
 * Used as a local fallback when the server pre-labeller is unavailable.
 */
export function detectOnsets(
  samples: Float32Array,
  sampleRate: number,
  opts: { win?: number; k?: number; minGap?: number; minLen?: number } = {},
): { start: number; end: number }[] {
  const win = Math.max(1, Math.round((opts.win ?? 0.02) * sampleRate));
  const k = opts.k ?? 3;
  const minGap = opts.minGap ?? 0.04;
  const minLen = opts.minLen ?? 0.03;
  const n = Math.floor(samples.length / win);
  if (n === 0) return [];
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * win; j < (i + 1) * win; j++) s += samples[j] * samples[j];
    env[i] = Math.sqrt(s / win);
  }
  const sorted = Float32Array.from(env).sort();
  const thr = Math.max(k * sorted[Math.floor(n / 2)], 1e-4);
  const raw: { start: number; end: number }[] = [];
  let open = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && env[i] > thr;
    if (on && open < 0) open = i;
    if (!on && open >= 0) {
      raw.push({ start: (open * win) / sampleRate, end: (i * win) / sampleRate });
      open = -1;
    }
  }
  const merged: { start: number; end: number }[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < minGap) last.end = r.end;
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.end - r.start >= minLen);
}

/** Map a dB value to an 8-bit intensity for the spectrogram image. */
export function dbToByte(v: number, floor: number, ceil: number) {
  const u = (v - floor) / Math.max(1e-6, ceil - floor);
  return Math.max(0, Math.min(255, Math.round(u * 255)));
}
