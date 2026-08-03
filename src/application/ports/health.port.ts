/**
 * Readiness probing (ADR-017). A port rather than a direct import so the health controller does
 * not reach into concrete infrastructure — and so `criticality` is declared by the dependency
 * itself rather than hard-coded in the controller, which is what stops "is Dragonfly required?"
 * from being answered in two places that can disagree.
 */
export interface HealthIndicator {
  readonly name: string;
  /**
   * `required` — unreadiness. `optional` — degradation. The cache is optional by ADR-003: the
   * system is correct without it, and failing readiness for a cache outage would pull healthy
   * instances out of rotation for an optimisation.
   */
  readonly criticality: 'required' | 'optional';
  /** Must resolve within its own timeout; a probe that can hang is not a probe. */
  check(): Promise<void>;
}

export const HEALTH_INDICATORS = Symbol('HealthIndicators');
