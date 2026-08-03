import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { CallerError, SystemError } from '../domain/errors';
import { TenantScope, workspaceId } from '../domain/ids';
import { parseOrThrow, uuidParamSchema } from './api.contracts';

/**
 * Derives the `TenantScope` once, at the edge (ADR-012).
 *
 * The guard is deliberately *not* the enforcement point — repository and cache signatures are,
 * because a guard is something a future endpoint author can forget and the failure is silent and
 * cross-tenant. What the guard does is establish the scope; what makes it unforgettable is that
 * every data-access method requires one as an argument, so an endpoint that skipped this would
 * have nothing to pass and would not compile.
 *
 * A9: the workspace / connected-account authorisation model already exists upstream of this
 * feature. In the real product the workspace comes from the authenticated principal on the JWT;
 * a header stands in for it here so the exercise is runnable, and it is the one line that would
 * change.
 */

const SCOPE = Symbol('TenantScope');

interface ScopedRequest extends Request {
  [SCOPE]?: TenantScope;
}

@Injectable()
export class TenantScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ScopedRequest>();
    const header = request.headers['x-workspace-id'];
    if (typeof header !== 'string') {
      throw CallerError.invalid('WORKSPACE_REQUIRED', 'The x-workspace-id header is required.');
    }
    request[SCOPE] = TenantScope.of(
      workspaceId(parseOrThrow(uuidParamSchema, header, 'WORKSPACE_INVALID')),
    );
    return true;
  }
}

export const tenantScopeOf = (request: Request): TenantScope => {
  const scope = (request as ScopedRequest)[SCOPE];
  if (scope === undefined) {
    // Reachable only if a controller is registered without the guard, which is a wiring defect
    // rather than anything a caller did.
    throw new SystemError('SCOPE_MISSING', 'The request reached a handler with no tenant scope.');
  }
  return scope;
};
