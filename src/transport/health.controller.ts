import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { HEALTH_INDICATORS, type HealthIndicator } from '../application/ports/health.port';
import { HealthDto, ReadinessDto } from './api.contracts';

/**
 * Liveness and readiness (ADR-017), which are two questions with two different consumers and
 * therefore two endpoints.
 *
 * **Neither one contacts a social platform**, and that is the decision worth defending. A deep
 * check would make our health a function of theirs: an outage at one platform would fail our
 * readiness probe, pull healthy instances out of rotation, and take down comment reads for every
 * *other* platform. It would also burn per-account rate limit on a timer, forever, in exchange for
 * information no orchestrator can act on. Platform reachability is a monitoring concern.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(HEALTH_INDICATORS) private readonly indicators: readonly HealthIndicator[]) {}

  @Get()
  @ApiOperation({
    summary: 'Liveness',
    description:
      'The process is up and serving. No dependency checks and no auth — this is what the orchestrator restarts on, and restarting a container because Postgres blipped is worse than serving errors from a live one.',
  })
  @ApiResponse({ status: 200, type: HealthDto })
  liveness(): HealthDto {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness',
    description:
      'Checks PostgreSQL and Dragonfly, each under a hard 1s timeout. Dragonfly being down reports "degraded" and still returns 200: by ADR-003 the cache is an optimisation and the system is correct without it. A green probe does not promise that replies will succeed — only that we can accept a request and report a failure properly.',
  })
  @ApiResponse({ status: 200, type: ReadinessDto })
  @ApiResponse({ status: 503, type: ReadinessDto })
  async readiness(@Res({ passthrough: true }) response: Response): Promise<ReadinessDto> {
    const results = await Promise.all(
      this.indicators.map(async (indicator) => {
        const up = await indicator.check().then(
          () => true,
          () => false,
        );
        return { indicator, up };
      }),
    );

    const dependencies = Object.fromEntries(
      results.map(({ indicator, up }) => [indicator.name, up ? 'up' : 'down'] as const),
    );
    const down = results.filter(({ up }) => !up);
    const status = down.some(({ indicator }) => indicator.criticality === 'required')
      ? 'unhealthy'
      : down.length > 0
        ? 'degraded'
        : 'ready';

    response.status(status === 'unhealthy' ? 503 : 200);
    return { status, dependencies };
  }
}
