import { http } from '@/lib/http';

export type JobSummary = {
  id: string;
  status: string;
  pricingModel: string;
  title: string | null;
  receiverName?: string | null;
  receiverEmail?: string | null;
  deadWeightKg?: number | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  loadTypes?: string[];
  hourlyPattern?: string | null;
  minVehicleClass: string | null;
  recommendedVehicleClass: string | null;
  chargeableWeightKg: number | null;
  requiresDg: boolean;
  route: {
    distanceKm: number | null;
    durationMinutes: number | null;
    fatigueBreakMinutes: number;
    billableHours: number | null;
    mock: boolean;
  };
  estimate: {
    exGstCents: number | null;
    gstCents: number | null;
    incGstCents: number | null;
  };
  proposals?: Array<{
    id: string;
    status: string;
    amountIncGstCents: number;
    etaMinutes: number | null;
    carrierLabel: string;
    vehicleClass: string | null;
    netToCarrierCents: number;
  }>;
  assignment?: {
    id: string;
    status: string;
    lockedAt: string | null;
    paidAndConfirmed: boolean;
  } | null;
  payment?: {
    id: string;
    status: string;
    amountIncGstCents: number;
    stripePaymentIntentId: string | null;
  } | null;
  stops: Array<{
    sequence: number;
    stopType: string;
    suburb: string | null;
    state: string | null;
  }>;
};

export type AcceptProposalResult = {
  paymentEventId: string;
  paymentStatus: string;
  amountIncGstCents: number;
  stripePaymentIntentId: string | null;
  jobId: string | null;
  assignmentId: string | null;
  assignmentStatus: string | null;
  lockedAt: string | null;
  paidAndConfirmed: boolean;
  idempotentReplay: boolean;
  clientSecret?: string | null;
  publishableKey?: string | null;
  stripeStatus?: string;
  mock?: boolean;
  message?: string;
};

export type CarrierAssignment = {
  id: string;
  status: string;
  lockedAt: string | null;
  paidAndConfirmed: boolean;
  tripBlockedUntilPaid: boolean;
  amountIncGstCents: number;
  etaMinutes: number | null;
  job: {
    id: string;
    title: string | null;
    status: string;
    pricingModel: string;
    estimateIncGstCents: number | null;
  };
};

export type MarketBoard = {
  netPayoutHint: string;
  jobs: Array<{
    id: string;
    title: string | null;
    status: string;
    pricingModel: string;
    minVehicleClass: string | null;
    requiresDg: boolean;
    requiresReefer: boolean;
    estimateIncGstCents: number | null;
    estimateNetToCarrierCents: number | null;
    routeDistanceKm: number | null;
    routeFatigueBreakMinutes: number;
    billableHours: number | null;
    alreadyBid: boolean;
    stopsSummary: string;
  }>;
};

export function listSenderJobs() {
  return http.get<JobSummary[]>('/jobs').then((r) => r.data);
}

export function getSenderJob(id: string) {
  return http.get<JobSummary>(`/jobs/${id}`).then((r) => r.data);
}

export function createJob(payload: Record<string, unknown>) {
  return http.post<JobSummary>('/jobs', payload).then((r) => r.data);
}

export function updateJob(id: string, payload: Record<string, unknown>) {
  return http.patch<JobSummary>(`/jobs/${id}`, payload).then((r) => r.data);
}

export function publishJob(id: string) {
  return http.post<JobSummary>(`/jobs/${id}/publish`, {}).then((r) => r.data);
}

export function acceptProposal(jobId: string, proposalId: string) {
  return http
    .post<AcceptProposalResult>(`/jobs/${jobId}/proposals/${proposalId}/accept`, {})
    .then((r) => r.data);
}

export function getCarrierAssignments() {
  return http.get<CarrierAssignment[]>('/payments/assignments').then((r) => r.data);
}

export function getJobPayment(jobId: string) {
  return http.get(`/payments/jobs/${jobId}`).then((r) => r.data);
}

export function recommendVehicle(payload: {
  deadWeightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}) {
  return http
    .post<{ chargeableWeightKg: number; recommendedVehicleClass: string }>(
      '/jobs/meta/recommend',
      payload,
    )
    .then((r) => r.data);
}

export type JobRouteEstimate = {
  distanceKm: number;
  durationMinutes: number;
  drivingMinutes: number;
  fatigueBreakMinutes: number;
  billableHours: number | null;
  mock: boolean;
};

export function previewJobRoute(payload: {
  pricingModel: 'PER_KM' | 'HOURLY';
  stops: Array<Record<string, unknown>>;
}) {
  return http.post<JobRouteEstimate>('/jobs/route-estimate', payload).then((r) => r.data);
}

export function getMarketBoard() {
  return http.get<MarketBoard>('/matching/board').then((r) => r.data);
}

export function submitBid(payload: {
  jobId: string;
  vehicleId: string;
  driverId: string;
  amountIncGstCents: number;
  etaMinutes: number;
}) {
  return http.post('/matching/bids', payload).then((r) => r.data);
}
