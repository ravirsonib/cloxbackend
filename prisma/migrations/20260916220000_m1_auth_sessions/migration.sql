-- M1 identity: unified OTP, auth sessions

CREATE TYPE "OtpPurpose" AS ENUM ('LOGIN', 'STEP_UP');
CREATE TYPE "AuthPrincipalType" AS ENUM ('ADMIN', 'USER');

-- OtpChallenge: allow platform users + purpose
ALTER TABLE "OtpChallenge" ALTER COLUMN "adminUserId" DROP NOT NULL;
ALTER TABLE "OtpChallenge" ADD COLUMN "userId" TEXT;
ALTER TABLE "OtpChallenge" ADD COLUMN "purpose" "OtpPurpose" NOT NULL DEFAULT 'LOGIN';

ALTER TABLE "OtpChallenge" ADD CONSTRAINT "OtpChallenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "OtpChallenge_userId_createdAt_idx" ON "OtpChallenge"("userId", "createdAt");

CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "principalType" "AuthPrincipalType" NOT NULL,
    "adminUserId" TEXT,
    "userId" TEXT,
    "refreshTokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "deviceLabel" TEXT,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuthSession_adminUserId_revokedAt_idx" ON "AuthSession"("adminUserId", "revokedAt");
CREATE INDEX "AuthSession_userId_revokedAt_idx" ON "AuthSession"("userId", "revokedAt");
CREATE INDEX "AuthSession_refreshTokenHash_idx" ON "AuthSession"("refreshTokenHash");
CREATE INDEX "AuthSession_familyId_idx" ON "AuthSession"("familyId");

ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_adminUserId_fkey"
  FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "User_phone_idx" ON "User"("phone");
