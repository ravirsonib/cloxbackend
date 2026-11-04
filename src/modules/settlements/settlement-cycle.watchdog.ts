import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminRole, SettlementCycleStatus } from '@prisma/client';
import { AppEnv } from '../../config/env.validation';
import { AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { SettlementCyclesService } from './settlement-cycles.service';

const systemPrincipal: AuthenticatedPrincipal = {
  id: 'system-settlement-scheduler',
  email: 'settlement-cron@clox.internal',
  role: AdminRole.SUPER_ADMIN,
  kind: 'admin',
  regionCodes: [],
  territoryCodes: [],
};

@Injectable()
export class SettlementCycleWatchdog implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettlementCycleWatchdog.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cycles: SettlementCyclesService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  onModuleInit() {
    const ms = this.config.get('SETTLEMENT_WATCHDOG_MS', { infer: true });
    if (!ms || ms <= 0) {
      this.logger.warn('Settlement cycle watchdog disabled (SETTLEMENT_WATCHDOG_MS=0)');
      return;
    }
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, ms);
    this.logger.log(`Settlement cycle watchdog scheduled every ${ms}ms`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    try {
      if (!this.prisma.isConnected()) return;

      const now = new Date();
      // Check for OPEN cycles that have passed their scheduledDisburseAt
      const dueCycle = await this.prisma.settlementCycle.findFirst({
        where: {
          status: SettlementCycleStatus.OPEN,
          scheduledDisburseAt: { lte: now },
        },
        orderBy: { scheduledDisburseAt: 'asc' },
      });

      if (dueCycle) {
        this.logger.log(
          `Settlement watchdog: running due cycle ${dueCycle.cycleNumber} (scheduled for ${dueCycle.scheduledDisburseAt.toISOString()})`,
        );
        const result = await this.cycles.runDisbursement(systemPrincipal, {
          cycleId: dueCycle.id,
          notes: `Automated scheduled cycle disbursement run on ${now.toISOString()}`,
        });
        this.logger.log(
          `Settlement watchdog: successfully disbursed cycle ${result.cycleNumber} ($${(result.totalDisbursedCents / 100).toFixed(2)} AUD)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Settlement cycle watchdog tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
