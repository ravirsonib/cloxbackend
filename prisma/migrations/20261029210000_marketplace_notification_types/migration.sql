-- Marketplace inbox types (compliance decisions + bids)
ALTER TYPE "NotificationType" ADD VALUE 'COMPLIANCE_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'COMPLIANCE_INFO_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'BID_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE 'BID_ACCEPTED';
