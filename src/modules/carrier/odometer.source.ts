/**
 * Odometer source port for Fleet+ Maintenance Watchdog (AC5).
 * v1: trip POD odometer + manual logs. J1939 CAN-bus is a stub adapter only.
 */
export type OdometerReading = {
  vehicleId: string;
  odometerKm: number;
  source: 'TRIP_ODOMETER' | 'MANUAL' | 'TELEMATICS_STUB';
  at: Date;
};

export interface OdometerSource {
  getLatestOdometerKm(vehicleId: string): Promise<number | null>;
}

/** Production adapter: prefer latest fuel-log odo, else max trip end odo. */
export class TripAndManualOdometerSource implements OdometerSource {
  constructor(
    private readonly deps: {
      latestFuelLogOdometer: (vehicleId: string) => Promise<number | null>;
      latestTripEndOdometer: (vehicleId: string) => Promise<number | null>;
    },
  ) {}

  async getLatestOdometerKm(vehicleId: string): Promise<number | null> {
    const fromFuel = await this.deps.latestFuelLogOdometer(vehicleId);
    const fromTrip = await this.deps.latestTripEndOdometer(vehicleId);
    if (fromFuel == null) return fromTrip;
    if (fromTrip == null) return fromFuel;
    return Math.max(fromFuel, fromTrip);
  }
}

/** Stub for future J1939 / CAN-bus ingest — always returns null. */
export class J1939TelematicsOdometerStub implements OdometerSource {
  async getLatestOdometerKm(_vehicleId: string): Promise<number | null> {
    return null;
  }
}
