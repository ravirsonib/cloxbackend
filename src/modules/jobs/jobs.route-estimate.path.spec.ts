import type { JobRouteEstimateInput } from '../../shared/types';
import { JobsService } from './jobs.service';

const stops: JobRouteEstimateInput['stops'] = [
  {
    sequence: 0,
    stopType: 'PICKUP',
    addressLine: '1 Collins St',
    suburb: 'Melbourne',
    state: 'VIC',
    postcode: '3000',
    lat: -37.8136,
    lng: 144.9631,
  },
  {
    sequence: 1,
    stopType: 'DROPOFF',
    addressLine: '100 Airport Dr',
    suburb: 'Tullamarine',
    state: 'VIC',
    postcode: '3045',
    lat: -37.669,
    lng: 144.841,
  },
];

describe('JobsService previewRoute', () => {
  function makeService() {
    return new JobsService(
      { isConnected: () => true } as never,
      { recordPlatform: jest.fn() } as never,
      { getBookingEligibility: jest.fn() } as never,
      { acceptProposal: jest.fn() } as never,
    );
  }

  it('suggests positive distance from pickup + drop', async () => {
    const service = makeService();
    const route = await service.previewRoute({ pricingModel: 'PER_KM', stops });
    expect(route.distanceKm).toBeGreaterThan(0);
    expect(route.durationMinutes).toBeGreaterThan(0);
    expect(route.billableHours).toBeNull();
    expect(route.mock).toBe(true);
  });

  it('suggests hourly billable floor for short hops', async () => {
    const service = makeService();
    const route = await service.previewRoute({
      pricingModel: 'HOURLY',
      stops: [
        stops[0],
        {
          ...stops[1],
          lat: -37.82,
          lng: 144.97,
          suburb: 'Richmond',
          postcode: '3121',
          addressLine: '50 Swan St',
        },
      ],
    });
    expect(route.billableHours).toBe(4);
  });

  it('uses Valhalla route when available and returns encodedPolyline', async () => {
    const valhalla = {
      isEnabled: true,
      getRoute: jest.fn().mockResolvedValue({
        encodedPolyline: 'abc_polyline6',
        distanceKm: 23.45,
        durationMin: 28,
      }),
    };
    const service = new JobsService(
      { isConnected: () => true } as never,
      { recordPlatform: jest.fn() } as never,
      { getBookingEligibility: jest.fn() } as never,
      { acceptProposal: jest.fn() } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      valhalla as never,
    );
    const route = await service.previewRoute({ pricingModel: 'PER_KM', stops });
    expect(valhalla.getRoute).toHaveBeenCalledTimes(1);
    expect(route.mock).toBe(false);
    expect(route.routeSource).toBe('valhalla');
    expect(route.encodedPolyline).toBe('abc_polyline6');
    expect(route.distanceKm).toBe(23.5);
    expect(route.drivingMinutes).toBe(28);
  });

  it('falls back to mock route when Valhalla returns null', async () => {
    const valhalla = {
      isEnabled: true,
      getRoute: jest.fn().mockResolvedValue(null),
    };
    const service = new JobsService(
      { isConnected: () => true } as never,
      { recordPlatform: jest.fn() } as never,
      { getBookingEligibility: jest.fn() } as never,
      { acceptProposal: jest.fn() } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      valhalla as never,
    );
    const route = await service.previewRoute({ pricingModel: 'PER_KM', stops });
    expect(valhalla.getRoute).toHaveBeenCalledTimes(1);
    expect(route.mock).toBe(true);
    expect(route.routeSource).toBe('mock');
    expect(route.encodedPolyline).toBeNull();
    expect(route.distanceKm).toBeGreaterThan(0);
  });
});
