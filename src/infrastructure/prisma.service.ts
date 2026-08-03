import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { HealthIndicator } from '../application/ports/health.port';

const READINESS_TIMEOUT_MS = 1_000;

/**
 * PrismaClient with Nest's lifecycle attached, and the readiness probe for PostgreSQL (ADR-017).
 *
 * The probe is `SELECT 1` under a hard timeout. A probe that can block for the connection pool's
 * acquire timeout is not a probe — it is a second outage stacked on the first.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy, HealthIndicator {
  readonly name = 'postgres';
  /** Without the database we cannot resolve a publication, so we cannot serve a request at all. */
  readonly criticality = 'required' as const;

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async check(): Promise<void> {
    await Promise.race([
      this.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('postgres probe timed out')), READINESS_TIMEOUT_MS).unref(),
      ),
    ]);
  }
}
