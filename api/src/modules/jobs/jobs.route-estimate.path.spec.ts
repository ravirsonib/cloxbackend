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

  it('suggests positive distance from pickup + drop', () => {
    const service = makeService();
    const route = service.previewRoute({ pricingModel: 'PER_KM', stops });
    expect(route.distanceKm).toBeGreaterThan(0);
    expect(route.durationMinutes).toBeGreaterThan(0);
    expect(route.billableHours).toBeNull();
    expect(route.mock).toBe(true);
  });

  it('suggests hourly billable floor for short hops', () => {
    const service = makeService();
    const route = service.previewRoute({
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
});
