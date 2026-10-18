import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../../config/env.validation';
import { ComplianceService } from './compliance.service';
import { DriverService } from '../driver/driver.service';

@Injectable()
export class ExpiryWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExpiryWatchdogService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly compliance: ComplianceService,
    private readonly drivers: DriverService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  onModuleInit() {
    const ms = this.config.get('COMPLIANCE_WATCHDOG_MS', { infer: true });
    if (!ms || ms <= 0) {
      this.logger.warn('Compliance expiry watchdog disabled (COMPLIANCE_WATCHDOG_MS=0)');
      return;
    }

    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, ms);
    this.logger.log(`Compliance expiry watchdog every ${ms}ms`);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async tick() {
    try {
      const result = await this.compliance.runExpiryWatchdog();
      const driverResult = await this.drivers.suspendExpiredLicences();
      if (result.expired > 0 || driverResult.suspended > 0) {
        this.logger.warn(
          `Expiry watchdog: expired=${result.expired} vehicles=${result.suspendedVehicles} companies=${result.suspendedCompanies} drivers=${driverResult.suspended}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Expiry watchdog failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
