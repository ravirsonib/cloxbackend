import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../../config/env.validation';
import { ExceptionsService } from './exceptions.service';

@Injectable()
export class ExceptionEscalationWatchdog implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExceptionEscalationWatchdog.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly exceptions: ExceptionsService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  onModuleInit() {
    const ms = this.config.get('EXCEPTION_WATCHDOG_MS', { infer: true });
    if (!ms || ms <= 0) {
      this.logger.warn('Exception escalation watchdog disabled (EXCEPTION_WATCHDOG_MS=0)');
      return;
    }
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, ms);
    this.logger.log(`Exception escalation watchdog every ${ms}ms`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    try {
      const result = await this.exceptions.runEscalationWatchdog();
      if (result.escalated > 0) {
        this.logger.warn(
          `Exception escalation: scanned=${result.scanned} escalated=${result.escalated}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Exception escalation watchdog failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
