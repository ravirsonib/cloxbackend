import { NotificationType, PushPlatform } from '@prisma/client';

export type PushCategory =
  | 'trip_updates'
  | 'jobs_and_bids'
  | 'schedule_and_compliance'
  | 'payments_and_billing';

export type PushPriority = 'high' | 'normal';

export type AndroidChannelId =
  | 'clox_urgent'
  | 'clox_trips'
  | 'clox_schedule'
  | 'clox_general';

export type PushNotificationPolicy = {
  category: PushCategory;
  channelId: AndroidChannelId;
  priority: PushPriority;
  /** Critical operational/safety alerts bypass user quiet hours. */
  isCritical: boolean;
  /** Whether this notification type is eligible for mobile push. */
  pushEligible: boolean;
};

export type PushPayload = {
  title: string;
  body: string | null;
  data: Record<string, string>;
  channelId: AndroidChannelId;
  priority: PushPriority;
  collapseKey: string | null;
  badge: number;
  isCritical: boolean;
};

export type PushSendRequest = {
  token: string;
  platform: PushPlatform;
  payload: PushPayload;
};

export type PushSendResult =
  | { ok: true; messageId: string; mode: 'fcm' | 'mock' }
  | {
      ok: false;
      errorCode: 'UNREGISTERED' | 'INVALID_TOKEN' | 'TRANSIENT' | 'CONFIG_ERROR';
      errorMessage: string;
      shouldDeactivateDevice: boolean;
      retryable: boolean;
    };

export interface PushProvider {
  readonly mode: 'fcm' | 'mock';
  send(request: PushSendRequest): Promise<PushSendResult>;
}

const DEFAULT_POLICY: PushNotificationPolicy = {
  category: 'trip_updates',
  channelId: 'clox_general',
  priority: 'normal',
  isCritical: false,
  pushEligible: true,
};

const POLICY_BY_TYPE: Partial<Record<NotificationType, PushNotificationPolicy>> = {
  // Urgent / critical alerts (bypass quiet hours)
  [NotificationType.TRIP_EXCEPTION]: {
    category: 'trip_updates',
    channelId: 'clox_urgent',
    priority: 'high',
    isCritical: true,
    pushEligible: true,
  },
  [NotificationType.TRIP_REASSIGNED]: {
    category: 'trip_updates',
    channelId: 'clox_urgent',
    priority: 'high',
    isCritical: true,
    pushEligible: true,
  },
  [NotificationType.PAYMENT_SETUP_REQUIRED]: {
    category: 'payments_and_billing',
    channelId: 'clox_urgent',
    priority: 'high',
    isCritical: true,
    pushEligible: true,
  },
  [NotificationType.SURCHARGE_ACTION_REQUIRED]: {
    category: 'payments_and_billing',
    channelId: 'clox_urgent',
    priority: 'high',
    isCritical: true,
    pushEligible: true,
  },

  // Active trip execution
  [NotificationType.TRIP_ASSIGNED]: {
    category: 'trip_updates',
    channelId: 'clox_trips',
    priority: 'high',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.TRIP_REMINDER]: {
    category: 'trip_updates',
    channelId: 'clox_trips',
    priority: 'high',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.TRIP_APPROACHING]: {
    category: 'trip_updates',
    channelId: 'clox_trips',
    priority: 'high',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.TRIP_AT_PICKUP]: {
    category: 'trip_updates',
    channelId: 'clox_trips',
    priority: 'high',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.TRIP_STARTED]: {
    category: 'trip_updates',
    channelId: 'clox_trips',
    priority: 'normal',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.TRIP_BREAK]: {
    category: 'trip_updates',
    channelId: 'clox_trips',
    priority: 'normal',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.TRIP_AT_DROPOFF]: {
    category: 'trip_updates',
    channelId: 'clox_trips',
    priority: 'high',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.DETENTION_STARTED]: {
    category: 'trip_updates',
    channelId: 'clox_trips',
    priority: 'high',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.POD_FINALIZED]: {
    category: 'trip_updates',
    channelId: 'clox_trips',
    priority: 'high',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.TRIP_COMPLETED]: {
    category: 'trip_updates',
    channelId: 'clox_trips',
    priority: 'normal',
    isCritical: false,
    pushEligible: true,
  },

  // Marketplace jobs & bids
  [NotificationType.JOB_PUBLISHED]: {
    category: 'jobs_and_bids',
    channelId: 'clox_general',
    priority: 'normal',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.BID_RECEIVED]: {
    category: 'jobs_and_bids',
    channelId: 'clox_general',
    priority: 'normal',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.BID_ACCEPTED]: {
    category: 'jobs_and_bids',
    channelId: 'clox_trips',
    priority: 'high',
    isCritical: false,
    pushEligible: true,
  },

  // Schedule & compliance
  [NotificationType.SCHEDULE_REQUESTED]: {
    category: 'schedule_and_compliance',
    channelId: 'clox_schedule',
    priority: 'normal',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.SCHEDULE_APPROVED]: {
    category: 'schedule_and_compliance',
    channelId: 'clox_schedule',
    priority: 'normal',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.SCHEDULE_REJECTED]: {
    category: 'schedule_and_compliance',
    channelId: 'clox_schedule',
    priority: 'high',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.COMPLIANCE_APPROVED]: {
    category: 'schedule_and_compliance',
    channelId: 'clox_schedule',
    priority: 'normal',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.COMPLIANCE_INFO_REQUESTED]: {
    category: 'schedule_and_compliance',
    channelId: 'clox_schedule',
    priority: 'high',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.DOCUMENT_EXPIRING]: {
    category: 'schedule_and_compliance',
    channelId: 'clox_schedule',
    priority: 'normal',
    isCritical: false,
    pushEligible: true,
  },

  // Payments / disputes
  [NotificationType.PAYOUT_SETUP_REQUIRED]: {
    category: 'payments_and_billing',
    channelId: 'clox_general',
    priority: 'normal',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.DISPUTE]: {
    category: 'payments_and_billing',
    channelId: 'clox_urgent',
    priority: 'high',
    isCritical: false,
    pushEligible: true,
  },

  // Ops inbox types — delivered via Web PWA Push when Ops admins opt in
  [NotificationType.COMPLIANCE_CASE_OPENED]: {
    category: 'schedule_and_compliance',
    channelId: 'clox_schedule',
    priority: 'high',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.COMPLIANCE_CASE_RESUBMITTED]: {
    category: 'schedule_and_compliance',
    channelId: 'clox_schedule',
    priority: 'high',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.ADMIN_PARTNER_KYB_SUBMITTED]: {
    category: 'schedule_and_compliance',
    channelId: 'clox_schedule',
    priority: 'high',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.COMPLIANCE_ESCALATED]: {
    category: 'schedule_and_compliance',
    channelId: 'clox_urgent',
    priority: 'high',
    isCritical: true,
    pushEligible: true,
  },
  [NotificationType.TRIP_EXCEPTION_ESCALATED]: {
    category: 'trip_updates',
    channelId: 'clox_urgent',
    priority: 'high',
    isCritical: true,
    pushEligible: true,
  },
  [NotificationType.FLEET_RWC_REVIEW_OPENED]: {
    category: 'schedule_and_compliance',
    channelId: 'clox_schedule',
    priority: 'normal',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.DRIVER_LICENCE_REVIEW_OPENED]: {
    category: 'schedule_and_compliance',
    channelId: 'clox_schedule',
    priority: 'normal',
    isCritical: false,
    pushEligible: true,
  },
  [NotificationType.FUEL_INDEX_STALE]: {
    category: 'payments_and_billing',
    channelId: 'clox_general',
    priority: 'normal',
    isCritical: false,
    pushEligible: true,
  },
};

export function getPushPolicy(type: NotificationType): PushNotificationPolicy {
  return POLICY_BY_TYPE[type] ?? DEFAULT_POLICY;
}

export type PreferenceSnapshot = {
  pushEnabled: boolean;
  tripUpdates: boolean;
  jobsAndBids: boolean;
  scheduleAndCompliance: boolean;
  paymentsAndBilling: boolean;
  quietHoursEnabled: boolean;
  quietStartMinute: number;
  quietEndMinute: number;
  timezone: string;
};

export const DEFAULT_NOTIFICATION_PREFERENCE: PreferenceSnapshot = {
  pushEnabled: true,
  tripUpdates: true,
  jobsAndBids: true,
  scheduleAndCompliance: true,
  paymentsAndBilling: true,
  quietHoursEnabled: false,
  quietStartMinute: 1320, // 22:00
  quietEndMinute: 360, // 06:00
  timezone: 'Australia/Sydney',
};

export function isCategoryEnabled(
  pref: PreferenceSnapshot,
  category: PushCategory,
): boolean {
  switch (category) {
    case 'trip_updates':
      return pref.tripUpdates;
    case 'jobs_and_bids':
      return pref.jobsAndBids;
    case 'schedule_and_compliance':
      return pref.scheduleAndCompliance;
    case 'payments_and_billing':
      return pref.paymentsAndBilling;
  }
}

/**
 * Evaluates whether `now` falls inside the user's quiet-hours window in `timezone`.
 * Supports wrap-around windows (e.g. 22:00 -> 06:00) and same-day windows (e.g. 13:00 -> 15:00).
 */
export function isWithinQuietHours(
  pref: Pick<
    PreferenceSnapshot,
    'quietHoursEnabled' | 'quietStartMinute' | 'quietEndMinute' | 'timezone'
  >,
  now: Date = new Date(),
): boolean {
  if (!pref.quietHoursEnabled) return false;
  if (pref.quietStartMinute === pref.quietEndMinute) return false;

  const tz = pref.timezone || 'Australia/Sydney';
  let currentMinute: number;
  try {
    const parts = new Intl.DateTimeFormat('en-AU', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    currentMinute = (hour % 24) * 60 + minute;
  } catch {
    currentMinute = now.getUTCHours() * 60 + now.getUTCMinutes();
  }

  if (pref.quietStartMinute < pref.quietEndMinute) {
    return (
      currentMinute >= pref.quietStartMinute &&
      currentMinute < pref.quietEndMinute
    );
  }
  // Wrap-around midnight (e.g. 22:00 -> 06:00)
  return (
    currentMinute >= pref.quietStartMinute || currentMinute < pref.quietEndMinute
  );
}

/**
 * Builds the flat string-only `data` map required by FCM HTTP v1,
 * giving mobile apps a deterministic deep-link and entity contract.
 */
export function buildPushData(input: {
  notificationId: string | null;
  type: NotificationType;
  entityType?: string | null;
  entityId?: string | null;
  href?: string | null;
  unreadCount: number;
}): Record<string, string> {
  const policy = getPushPolicy(input.type);
  const data: Record<string, string> = {
    schemaVersion: '1',
    type: input.type,
    category: policy.category,
    priority: policy.priority,
    channelId: policy.channelId,
    unreadCount: String(Math.max(0, input.unreadCount)),
  };
  if (input.notificationId) data.notificationId = input.notificationId;
  if (input.entityType) data.entityType = input.entityType;
  if (input.entityId) data.entityId = input.entityId;
  if (input.href) data.route = input.href;

  if (input.entityType === 'Trip' && input.entityId) {
    data.tripId = input.entityId;
  } else if (input.entityType === 'Job' && input.entityId) {
    data.jobId = input.entityId;
  } else if (input.entityType === 'TripException' && input.entityId) {
    data.exceptionId = input.entityId;
  }

  return data;
}

/**
 * Collapse key prevents noisy bursts for repeatable updates (e.g. approaching ETA).
 */
export function buildCollapseKey(
  type: NotificationType,
  entityId?: string | null,
): string | null {
  if (!entityId) return null;
  if (
    type === NotificationType.TRIP_APPROACHING ||
    type === NotificationType.TRIP_REMINDER ||
    type === NotificationType.DETENTION_STARTED
  ) {
    return `${type.toLowerCase()}:${entityId}`.slice(0, 64);
  }
  return null;
}

export function maskPushToken(token: string): string {
  if (token.length <= 12) return '***';
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
}
