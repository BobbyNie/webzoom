import {visibleStrokes,type AnnotationState,type Point} from './annotations';

export const POINTER_LIFETIME_MS = 1800;
export type FeedbackMode = 'overview' | 'focus' | 'annotations';

// All geometry is relative to the shared image, never the outer browser window.
export function focusCenter(point: Point, zoom = 2): Point {
  const half = 1 / (2 * Math.max(1, zoom));
  const clamp = (value: number) => Math.max(half, Math.min(1 - half, Number.isFinite(value) ? value : .5));
  return {x: clamp(point.x), y: clamp(point.y)};
}

export function currentPointers(state: AnnotationState, now: number) {
  return Object.values(state.pointers ?? {}).filter(p => now - p.updatedAt < POINTER_LIFETIME_MS);
}

export function latestFeedback(state: AnnotationState, now: number,expiryNow=now) {
  const pointer = currentPointers(state, now).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (pointer) return {point: pointer.point, name: pointer.user.name};
  const stroke = visibleStrokes(state,expiryNow).at(-1);
  const point = stroke?.points.at(-1);
  return point && stroke ? {point, name: stroke.user.name} : null;
}
