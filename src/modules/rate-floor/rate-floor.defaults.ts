/**
 * Section 4 hard floors from CLOX-PRICING-MinimumRateFloorByVehicleClass-V1.0
 * (AUD ex-GST → cents). Mapped onto existing VehicleClassConfig codes.
 */
export type DefaultRateFloorLine = {
  vehicleClassCode: string;
  hourlyFloorCents: number;
  kmFloorCents: number;
  variableKmCents: number;
  litresPerKm: number;
  basis: 'V' | 'W' | 'D';
};

export const DEFAULT_RATE_FLOOR_VERSION_LABEL = '2026-10 Section 4 initial';

/** Reference diesel cpl and labour from the pricing PDF (Wave 1 header). */
export const DEFAULT_RATE_FLOOR_VERSION_PARAMS = {
  referenceDieselCpl: 211.4,
  labourRateHrCents: 3440,
  minHours: 4.0,
  minKmChargeKm: 25.0,
  backhaulFactor: 0.85,
} as const;

export {
  DEFAULT_LABOUR_MULTIPLIERS,
  type LabourPeriodCode,
} from './rate-floor.labour';

export {
  DEFAULT_BODY_LOADINGS,
  inferBodyCode,
  type BodyCode,
} from './rate-floor.body';

export const DEFAULT_RATE_FLOOR_LINES: DefaultRateFloorLine[] = [
  {
    vehicleClassCode: 'MOTORBIKE',
    hourlyFloorCents: 4600,
    kmFloorCents: 90,
    variableKmCents: 40,
    litresPerKm: 0.05,
    basis: 'D',
  },
  {
    vehicleClassCode: 'CAR',
    hourlyFloorCents: 4900,
    kmFloorCents: 100,
    variableKmCents: 45,
    litresPerKm: 0.08,
    basis: 'D',
  },
  {
    vehicleClassCode: 'UTE',
    hourlyFloorCents: 5600,
    kmFloorCents: 115,
    variableKmCents: 29,
    litresPerKm: 0.111,
    basis: 'V',
  },
  {
    vehicleClassCode: 'VAN_SWB',
    hourlyFloorCents: 5300,
    kmFloorCents: 110,
    variableKmCents: 29,
    litresPerKm: 0.111,
    basis: 'V',
  },
  {
    vehicleClassCode: 'VAN_MWB',
    hourlyFloorCents: 5500,
    kmFloorCents: 115,
    variableKmCents: 29,
    litresPerKm: 0.111,
    basis: 'D',
  },
  {
    vehicleClassCode: 'VAN',
    hourlyFloorCents: 5800,
    kmFloorCents: 125,
    variableKmCents: 32,
    litresPerKm: 0.12,
    basis: 'D',
  },
  {
    vehicleClassCode: 'RIGID_1_2T',
    hourlyFloorCents: 5700,
    kmFloorCents: 125,
    variableKmCents: 35,
    litresPerKm: 0.13,
    basis: 'D',
  },
  {
    vehicleClassCode: 'RIGID_3T',
    hourlyFloorCents: 5900,
    kmFloorCents: 130,
    variableKmCents: 40,
    litresPerKm: 0.14,
    basis: 'D',
  },
  {
    vehicleClassCode: 'RIGID_3_4T',
    hourlyFloorCents: 6050,
    kmFloorCents: 133,
    variableKmCents: 42,
    litresPerKm: 0.15,
    basis: 'D',
  },
  {
    vehicleClassCode: 'RIGID_4_6T',
    hourlyFloorCents: 6200,
    kmFloorCents: 135,
    variableKmCents: 45,
    litresPerKm: 0.15,
    basis: 'W',
  },
  {
    vehicleClassCode: 'RIGID_8_10T',
    hourlyFloorCents: 6400,
    kmFloorCents: 140,
    variableKmCents: 50,
    litresPerKm: 0.173,
    basis: 'V',
  },
  {
    vehicleClassCode: 'RIGID_12_14',
    hourlyFloorCents: 6700,
    kmFloorCents: 175,
    variableKmCents: 85,
    litresPerKm: 0.23,
    basis: 'V',
  },
  {
    vehicleClassCode: 'FLATBED',
    hourlyFloorCents: 6700,
    kmFloorCents: 175,
    variableKmCents: 85,
    litresPerKm: 0.23,
    basis: 'D',
  },
  {
    vehicleClassCode: 'REEFER',
    hourlyFloorCents: 8040,
    kmFloorCents: 210,
    variableKmCents: 102,
    litresPerKm: 0.26,
    basis: 'D',
  },
  {
    vehicleClassCode: 'CRANE',
    hourlyFloorCents: 10050,
    kmFloorCents: 263,
    variableKmCents: 128,
    litresPerKm: 0.28,
    basis: 'D',
  },
  {
    vehicleClassCode: 'SEMI',
    hourlyFloorCents: 10400,
    kmFloorCents: 255,
    variableKmCents: 179,
    litresPerKm: 0.47,
    basis: 'V',
  },
  {
    vehicleClassCode: 'CONTAINER',
    hourlyFloorCents: 10400,
    kmFloorCents: 255,
    variableKmCents: 179,
    litresPerKm: 0.47,
    basis: 'D',
  },
  {
    vehicleClassCode: 'BDOUBLE',
    hourlyFloorCents: 13000,
    kmFloorCents: 320,
    variableKmCents: 220,
    litresPerKm: 0.6,
    basis: 'W',
  },
  {
    vehicleClassCode: 'ROAD_TRAIN',
    hourlyFloorCents: 13800,
    kmFloorCents: 340,
    variableKmCents: 240,
    litresPerKm: 0.7,
    basis: 'W',
  },
];
