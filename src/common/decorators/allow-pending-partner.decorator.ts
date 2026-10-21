import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_PARTNER_KEY = 'allowPendingPartner';

/**
 * Allow State Master / Local BDE JWT access while status !== ACTIVE
 * (partner onboarding + document upload only).
 */
export const AllowPendingPartner = () => SetMetadata(ALLOW_PENDING_PARTNER_KEY, true);
