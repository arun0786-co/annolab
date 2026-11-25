// Video box tracks: keyframes with linear interpolation between them.
import type { Keyframe } from "../api/types";

const EPS = 1e-6;

export function sortKeyframes(kfs: Keyframe[]): Keyframe[] {
  return [...kfs].sort((a, b) => a.t - b.t);
}

/**
 * Box at time t. A track exists only between its first and last keyframe;
 * outside that range this returns null. Between keyframes each of x, y, w, h is linear in t.
 */
export function interpolate(kfs: Keyframe[], t: number): Keyframe | null {
  if (!kfs.length) return null;
  const k = sortKeyframes(kfs);
  if (t < k[0].t - EPS || t > k[k.length - 1].t + EPS) return null;
  for (let i = 0; i < k.length; i++) {
    if (Math.abs(k[i].t - t) <= EPS) return { ...k[i], t };
    if (i + 1 < k.length && t > k[i].t && t < k[i + 1].t) {
      const a = k[i];
      const b = k[i + 1];
      const u = (t - a.t) / (b.t - a.t);
      return {
        t,
        x: a.x + (b.x - a.x) * u,
        y: a.y + (b.y - a.y) * u,
        w: a.w + (b.w - a.w) * u,
        h: a.h + (b.h - a.h) * u,
      };
    }
  }
  return null;
}

/** Insert or replace the keyframe at kf.t (within `tol` seconds). Returns a new sorted array. */
export function upsertKeyframe(kfs: Keyframe[], kf: Keyframe, tol = 1e-3): Keyframe[] {
  const rest = kfs.filter((k) => Math.abs(k.t - kf.t) > tol);
  return sortKeyframes([...rest, kf]);
}

export function removeKeyframe(kfs: Keyframe[], t: number, tol = 1e-3): Keyframe[] {
  return kfs.filter((k) => Math.abs(k.t - t) > tol);
}

export function isKeyframe(kfs: Keyframe[], t: number, tol = 1e-3): boolean {
  return kfs.some((k) => Math.abs(k.t - t) <= tol);
}

export function trackExtent(kfs: Keyframe[]): { start: number; end: number } | null {
  if (!kfs.length) return null;
  const k = sortKeyframes(kfs);
  return { start: k[0].t, end: k[k.length - 1].t };
}

/** Snap a time to the nearest frame boundary. */
export function snapToFrame(t: number, fps: number): number {
  if (!fps || fps <= 0) return t;
  return Math.round(t * fps) / fps;
}
