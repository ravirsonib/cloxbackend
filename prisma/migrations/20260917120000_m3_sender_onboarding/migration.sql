-- M3 sender onboarding fields

CREATE TYPE "SenderAccountType" AS ENUM ('BUSINESS', 'INDIVIDUAL');

ALTER TABLE "Company" ADD COLUMN "senderAccountType" "SenderAccountType";
ALTER TABLE "Company" ADD COLUMN "invoiceLegalName" TEXT;
ALTER TABLE "Company" ADD COLUMN "invoiceAddressLine1" TEXT;
ALTER TABLE "Company" ADD COLUMN "invoiceSuburb" TEXT;
ALTER TABLE "Company" ADD COLUMN "invoiceState" TEXT;
ALTER TABLE "Company" ADD COLUMN "invoicePostcode" TEXT;
ALTER TABLE "Company" ADD COLUMN "gstRegistered" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Company" ADD COLUMN "paymentReady" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Company" ADD COLUMN "stripeDefaultPaymentMethodId" TEXT;
