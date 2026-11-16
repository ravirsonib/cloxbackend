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
