import { FleetProfitService } from './fleet-profit.service';

describe('FleetProfitService.calculateTripProfit', () => {
  const service = new FleetProfitService({} as never, {} as never);

  it('applies 70% net and subtracts fuel wages tolls maint×distance', () => {
    const result = service.calculateTripProfit({
      grossFareAud: 1000,
      fuelAud: 50,
      wagesAud: 100,
      tollsAud: 20,
      maintenanceRatePerKm: 0.1,
      distanceKm: 100,
    });
    // net 700 − (50+100+20+10) = 520
    expect(result.netAud).toBe(700);
    expect(result.costsAud).toBe(180);
    expect(result.profitAud).toBe(520);
    expect(result.marginPct).toBeCloseTo((520 / 700) * 100, 5);
  });

  it('subtracts Enterprise depreciation when provided', () => {
    const result = service.calculateTripProfit({
      grossFareAud: 1000,
      fuelAud: 0,
      wagesAud: 0,
      tollsAud: 0,
      maintenanceRatePerKm: 0,
      distanceKm: 0,
      depreciationAud: 50,
    });
    expect(result.profitAud).toBe(650);
  });

  it('returns null margin when net is zero', () => {
    const result = service.calculateTripProfit({
      grossFareAud: 0,
      fuelAud: 10,
      wagesAud: 0,
      tollsAud: 0,
      maintenanceRatePerKm: 0,
      distanceKm: 0,
    });
    expect(result.marginPct).toBeNull();
    expect(result.profitAud).toBe(-10);
  });
});

describe('FleetProfitService.getAnalytics', () => {
  it('separates profitable and loss-making vehicles and includes OTHER costs', async () => {
    const prisma = {
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'v-profit',
            registration: 'PRO-1',
            label: 'Profitable Van',
            status: 'ACTIVE',
            maintenanceRatePerKm: 0.2,
            purchasePriceAud: null,
            residualValueAud: null,
            lifecycleMonths: null,
            maintenanceCause: null,
          },
          {
            id: 'v-loss',
            registration: 'LOS-2',
            label: 'Loss Truck',
            status: 'ACTIVE',
            maintenanceRatePerKm: 0,
            purchasePriceAud: null,
            residualValueAud: null,
            lifecycleMonths: null,
            maintenanceCause: null,
          },
        ]),
      },
      assignment: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              proposal: { amountIncGstCents: 100000 }, // $1000 gross -> $700 net
              trip: {
                status: 'COMPLETED',
                startedAt: new Date('2026-11-01T00:00:00Z'),
                completedAt: new Date('2026-11-25T00:00:00Z'),
                odometerStartKm: 1000,
                odometerEndKm: 1100, // 100 km * 0.2 = $20 maint
              },
            },
          ])
          .mockResolvedValueOnce([]), // $0 revenue for v-loss
      },
      vehicleCostEntry: {
        groupBy: jest
          .fn()
          .mockResolvedValueOnce([
            { kind: 'WAGE', _sum: { amountAud: 100 } },
            { kind: 'OTHER', _sum: { amountAud: 30 } },
          ])
          .mockResolvedValueOnce([
            { kind: 'MAINTENANCE', _sum: { amountAud: 250 } },
            { kind: 'OTHER', _sum: { amountAud: 50 } },
          ]),
      },
      vehicleFuelLog: {
        aggregate: jest
          .fn()
          .mockResolvedValueOnce({ _sum: { amountAud: 50, liters: 25 } })
          .mockResolvedValueOnce({ _sum: { amountAud: 100, liters: 50 } }),
      },
    };
    const fleetPlus = {
      getFleetPlus: jest.fn().mockResolvedValue({
        companyId: 'co-1',
        entitled: true,
        tier: 'GROWTH',
      }),
      assertFleetPlus: jest.fn().mockResolvedValue(undefined),
    };

    const service = new FleetProfitService(prisma as never, fleetPlus as never);
    const res = await service.getAnalytics({} as never, {
      from: '2026-11-01T00:00:00Z',
      to: '2026-12-01T00:00:00Z',
    });

    const prof = res.vehicles.find((v) => v.vehicleId === 'v-profit')!;
    // net 700, costs = 50 fuel + 100 wage + 20 maint(rate) + 30 other = 200 -> profit 500
    expect(prof.revenueNetAud).toBe(700);
    expect(prof.otherCostsAud).toBe(30);
    expect(prof.totalCostsAud).toBe(200);
    expect(prof.costPerKmAud).toBe(2);
    expect(prof.fuelLitersPer100Km).toBe(25);
    expect(prof.profitAud).toBe(500);
    expect(prof.lossAud).toBe(0);
    expect(prof.flaggedLoss).toBe(false);

    const loss = res.vehicles.find((v) => v.vehicleId === 'v-loss')!;
    // net 0, costs = 100 fuel + 250 maint + 50 other = 400 -> profit -400, loss 400
    expect(loss.revenueNetAud).toBe(0);
    expect(loss.otherCostsAud).toBe(50);
    expect(loss.totalCostsAud).toBe(400);
    expect(loss.profitAud).toBe(-400);
    expect(loss.lossAud).toBe(400);
    expect(loss.flaggedLoss).toBe(true);

    expect(res.summary.totalRevenueNetAud).toBe(700);
    expect(res.summary.totalCostsAud).toBe(600);
    expect(res.summary.totalProfitAud).toBe(100);
    expect(res.summary.totalLossAud).toBe(400);
    expect(res.summary.profitableVehicleCount).toBe(1);
    expect(res.summary.lossVehicleCount).toBe(1);
    expect(res.summary.flaggedCount).toBe(1);
  });
});
