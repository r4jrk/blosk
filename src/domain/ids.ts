/**
 * Identifiers and the tenancy scope. Framework-free by construction (ADR-001).
 *
 * The IDs are branded so that a `PublicationId` cannot be passed where a `ConnectedAccountId` is
 * expected. In a codebase where four different UUIDs travel together through every signature,
 * that is not ceremony — it is the only thing standing between a correct call and a silent
 * cross-entity mix-up that typechecks.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type PublicationId = Brand<string, 'PublicationId'>;
export type ConnectedAccountId = Brand<string, 'ConnectedAccountId'>;
export type LocalReplyId = Brand<string, 'LocalReplyId'>;

export const workspaceId = (value: string): WorkspaceId => value as WorkspaceId;
export const publicationId = (value: string): PublicationId => value as PublicationId;
export const connectedAccountId = (value: string): ConnectedAccountId => value as ConnectedAccountId;
export const localReplyId = (value: string): LocalReplyId => value as LocalReplyId;

export const Platform = {
  LinkedIn: 'LINKEDIN',
  X: 'X',
  Facebook: 'FACEBOOK',
  Instagram: 'INSTAGRAM',
} as const;

export type Platform = (typeof Platform)[keyof typeof Platform];

export const isPlatform = (value: string): value is Platform =>
  (Object.values(Platform) as string[]).includes(value);

/**
 * The tenancy anchor (ADR-012). Every repository and cache method takes one, so an unscoped read
 * does not typecheck — the guarantee is structural rather than a habit each endpoint author has
 * to remember.
 *
 * It is a class rather than a bare string for one reason: `f(workspaceId, publicationId)` and
 * `f(publicationId, workspaceId)` are the same call to the compiler, and this one is not.
 */
export class TenantScope {
  private constructor(readonly workspaceId: WorkspaceId) {}

  static of(workspace: WorkspaceId): TenantScope {
    return new TenantScope(workspace);
  }

  /** Cache keys are composed from the scope, never from a caller-supplied string (ADR-003). */
  get cacheNamespace(): string {
    return this.workspaceId;
  }
}
