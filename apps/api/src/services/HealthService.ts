/**
 * @module HealthService
 * @description Provides component-level health checks for all infrastructure
 * dependencies: PostgreSQL (via Prisma), Redis, and local filesystem storage.
 *
 * The health check endpoint (GET /api/v1/health) calls this service to return
 * a structured health status response including individual component statuses,
 * response times, and an overall health determination.
 *
 * Architecture notes:
 * - R37: /api/v1/health exposes health status; this service provides the data.
 * - R28: Zero console.log calls — structured logging only.
 * - R7 : Zero warnings build — TypeScript strict mode.
 * - R17 exception: HealthService receives raw PrismaClient and Redis instances
 *   (not domain interfaces) because health checks probe infrastructure directly.
 */

import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum time in milliseconds allowed for each individual component check. */
const HEALTH_CHECK_TIMEOUT_MS = 5000;

/** Default upload directory path used for storage health verification. */
const DEFAULT_UPLOAD_DIR: string = process.env['UPLOAD_DIR'] ?? './uploads';

/** Application version reported in health responses. */
const APP_VERSION: string = process.env['npm_package_version'] ?? '1.0.0';

// ---------------------------------------------------------------------------
// Exported Interfaces
// ---------------------------------------------------------------------------

/**
 * Represents the health status of a single infrastructure component.
 */
export interface ComponentHealth {
  /** Current health status of the component. */
  status: 'healthy' | 'unhealthy' | 'degraded';

  /** Time in milliseconds taken to complete the health probe. */
  responseTimeMs: number;

  /** Human-readable description when the component is unhealthy. */
  message?: string;

  /** Optional structured details (e.g. Redis memory statistics). */
  details?: Record<string, unknown>;
}

/**
 * Aggregated health check result returned by HealthService.getHealth().
 */
export interface HealthCheckResult {
  /** Overall health status derived from individual component statuses. */
  status: 'healthy' | 'unhealthy' | 'degraded';

  /** ISO-8601 timestamp of when the health check was performed. */
  timestamp: string;

  /** Service uptime in seconds since instantiation. */
  uptime: number;

  /** Application semantic version string. */
  version: string;

  /** Per-component health statuses. */
  components: {
    database: ComponentHealth;
    redis: ComponentHealth;
    storage: ComponentHealth;
  };
}

// ---------------------------------------------------------------------------
// Type alias for overall status determination
// ---------------------------------------------------------------------------
type HealthStatus = 'healthy' | 'unhealthy' | 'degraded';

// ---------------------------------------------------------------------------
// HealthService Class
// ---------------------------------------------------------------------------

/**
 * Service responsible for probing infrastructure dependencies and reporting
 * their health. Intended for use by the /api/v1/health controller endpoint.
 *
 * @example
 * ```typescript
 * const healthService = new HealthService(prismaClient, redisClient);
 * const result = await healthService.getHealth();
 * // result.status === 'healthy' | 'degraded' | 'unhealthy'
 * ```
 */
export class HealthService {
  /** Timestamp (epoch ms) when this service instance was created. */
  private readonly startTime: number;

  /**
   * @param prisma - Prisma ORM client for PostgreSQL connectivity checks.
   * @param redis  - ioredis client for Redis connectivity and memory checks.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis
  ) {
    this.startTime = Date.now();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Execute all component health checks in parallel and return an aggregated
   * health result.
   *
   * Each individual check is wrapped with a 5-second timeout. If a check
   * exceeds the timeout it is reported as unhealthy.
   *
   * Overall status logic:
   * - `healthy`  : ALL components report healthy.
   * - `degraded` : Some components healthy, some unhealthy.
   * - `unhealthy`: ALL components report unhealthy.
   *
   * This method **never throws** — all errors are caught and surfaced as
   * unhealthy component statuses within the returned structure.
   */
  public async getHealth(): Promise<HealthCheckResult> {
    const [databaseResult, redisResult, storageResult] =
      await Promise.allSettled([
        this.withTimeout(this.checkDatabase(), HEALTH_CHECK_TIMEOUT_MS),
        this.withTimeout(this.checkRedis(), HEALTH_CHECK_TIMEOUT_MS),
        this.withTimeout(this.checkStorage(), HEALTH_CHECK_TIMEOUT_MS),
      ]);

    const database = this.extractResult(databaseResult, 'database');
    const redis = this.extractResult(redisResult, 'redis');
    const storage = this.extractResult(storageResult, 'storage');

    const componentsMap = { database, redis, storage };
    const statuses: HealthStatus[] = Object.values(componentsMap).map(
      (c) => c.status,
    );

    const overallStatus = this.determineOverallStatus(statuses);

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: this.getUptime(),
      version: APP_VERSION,
      components: componentsMap,
    };
  }

  /**
   * Return the service uptime in seconds since instantiation.
   */
  public getUptime(): number {
    return (Date.now() - this.startTime) / 1000;
  }

  // -------------------------------------------------------------------------
  // Private — Individual Component Checks
  // -------------------------------------------------------------------------

  /**
   * Probe PostgreSQL connectivity by executing a lightweight query via Prisma.
   * Uses `$queryRaw\`SELECT 1\`` to avoid any ORM overhead.
   */
  private async checkDatabase(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const responseTimeMs = Date.now() - start;
      return {
        status: 'healthy',
        responseTimeMs,
      };
    } catch (error: unknown) {
      const responseTimeMs = Date.now() - start;
      const message =
        error instanceof Error ? error.message : 'Unknown database error';
      return {
        status: 'unhealthy',
        responseTimeMs,
        message,
      };
    }
  }

  /**
   * Probe Redis connectivity via PING and optionally retrieve memory
   * statistics for the details payload.
   */
  private async checkRedis(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      const pong = await this.redis.ping();
      const responseTimeMs = Date.now() - start;

      if (pong !== 'PONG') {
        return {
          status: 'unhealthy',
          responseTimeMs,
          message: `Unexpected ping response: ${pong}`,
        };
      }

      // Retrieve memory info for enriched details (best-effort).
      let details: Record<string, unknown> | undefined;
      try {
        const memoryInfo = await this.redis.info('memory');
        details = this.parseRedisMemoryInfo(memoryInfo);
      } catch {
        // Memory info is supplementary — do not fail the overall check.
      }

      return {
        status: 'healthy',
        responseTimeMs,
        details,
      };
    } catch (error: unknown) {
      const responseTimeMs = Date.now() - start;
      const message =
        error instanceof Error ? error.message : 'Unknown Redis error';
      return {
        status: 'unhealthy',
        responseTimeMs,
        message,
      };
    }
  }

  /**
   * Verify the upload directory exists and is both readable and writable by
   * the current process.
   */
  private async checkStorage(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      // eslint-disable-next-line no-bitwise
      await access(DEFAULT_UPLOAD_DIR, constants.R_OK | constants.W_OK);
      const responseTimeMs = Date.now() - start;
      return {
        status: 'healthy',
        responseTimeMs,
        details: {
          path: DEFAULT_UPLOAD_DIR,
        },
      };
    } catch (error: unknown) {
      const responseTimeMs = Date.now() - start;
      const message =
        error instanceof Error
          ? error.message
          : 'Storage directory not accessible';
      return {
        status: 'unhealthy',
        responseTimeMs,
        message,
        details: {
          path: DEFAULT_UPLOAD_DIR,
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // Private — Helpers
  // -------------------------------------------------------------------------

  /**
   * Wraps a promise with a timeout. If the promise does not settle within
   * `timeoutMs` milliseconds, the returned promise rejects with a descriptive
   * error.
   *
   * @typeParam T - The resolved type of the wrapped promise.
   * @param promise   - The promise to race against the timer.
   * @param timeoutMs - Maximum allowed duration in milliseconds.
   * @returns The result of the original promise if it settles in time.
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Health check timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Convert a `PromiseSettledResult<ComponentHealth>` into a concrete
   * `ComponentHealth` value. Rejected promises (e.g. timeouts) are mapped to
   * an unhealthy status.
   *
   * @param result        - The settled promise result.
   * @param componentName - Human-readable name used in fallback error messages.
   */
  private extractResult(
    result: PromiseSettledResult<ComponentHealth>,
    componentName: string,
  ): ComponentHealth {
    if (result.status === 'fulfilled') {
      return result.value;
    }

    // Rejected — most commonly a timeout.
    const message =
      result.reason instanceof Error
        ? result.reason.message
        : `${componentName} check failed`;
    return {
      status: 'unhealthy',
      responseTimeMs: HEALTH_CHECK_TIMEOUT_MS,
      message,
    };
  }

  /**
   * Determine the overall health status from an array of individual component
   * statuses.
   *
   * - All healthy   → `healthy`
   * - All unhealthy → `unhealthy`
   * - Mixed         → `degraded`
   */
  private determineOverallStatus(statuses: HealthStatus[]): HealthStatus {
    const allHealthy = statuses.every((s) => s === 'healthy');
    if (allHealthy) {
      return 'healthy';
    }

    const allUnhealthy = statuses.every((s) => s === 'unhealthy');
    if (allUnhealthy) {
      return 'unhealthy';
    }

    return 'degraded';
  }

  /**
   * Parse the raw Redis INFO memory section output into a slim key-value map
   * containing human-readable memory statistics.
   *
   * @param info - Raw output from `redis.info('memory')`.
   * @returns A record with relevant memory fields.
   */
  private parseRedisMemoryInfo(info: string): Record<string, unknown> {
    const details: Record<string, unknown> = {};
    const relevantKeys = new Set([
      'used_memory_human',
      'used_memory_peak_human',
      'maxmemory_human',
      'used_memory_rss_human',
      'total_system_memory_human',
    ]);

    const lines = info.split('\r\n');
    for (const line of lines) {
      if (line.startsWith('#') || line.trim() === '') {
        continue;
      }
      const colonIndex = line.indexOf(':');
      if (colonIndex !== -1) {
        const key = line.substring(0, colonIndex).trim();
        if (relevantKeys.has(key)) {
          details[key] = line.substring(colonIndex + 1).trim();
        }
      }
    }

    return details;
  }
}
