import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AdminShell } from '@/components/admin-shell';
import { useAuthStore } from '@/stores/auth-store';
import { AdminRole } from '@/shared/types';
import { HomePage } from '@/pages/home-page';
import { AuditPage } from '@/pages/audit-page';
import { LeadDetailPage } from '@/pages/lead-detail-page';
import { LeadsPage } from '@/pages/leads-page';
import { LoginPage } from '@/pages/login-page';
import { ComplianceCasePage, ComplianceQueuePage } from '@/pages/compliance-pages';
import { QaUploadPage } from '@/pages/qa-upload-page';
import { AccountPage } from '@/pages/account-page';
import { CarrierRegisterPage } from '@/pages/carrier-register-page';
import { CarrierOnboardingPage } from '@/pages/carrier-onboarding-page';
import { DriverInvitePage } from '@/pages/driver-invite-page';
import { DriverOnboardingPage } from '@/pages/driver-onboarding-page';
import { JobCreatePage, JobDetailPage, JobEditPage, JobsListPage } from '@/pages/jobs-pages';
import { MarketBoardPage } from '@/pages/market-board-page';
import { CarrierAssignmentsPage } from '@/pages/carrier-assignments-page';
import { DriverTripsPage, DriverTripDetailPage } from '@/pages/driver-trips-page';
import { SenderTrackPage } from '@/pages/sender-track-page';
import { SenderRegisterPage } from '@/pages/sender-register-page';
import { SenderOnboardingPage } from '@/pages/sender-onboarding-page';
import { SurchargesPage } from '@/pages/surcharges-page';

function ProtectedRoute({ children }: { children: ReactNode }) {
  const accessToken = useAuthStore((state) => state.accessToken);
  if (!accessToken) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

function SuperOnly({ children }: { children: ReactNode }) {
  const role = useAuthStore((s) => s.role);
  if (role !== AdminRole.SUPER_ADMIN) {
    return <Navigate to="/" replace />;
  }
  return children;
}

function OpsOnly({ children }: { children: ReactNode }) {
  const role = useAuthStore((s) => s.role);
  const ok =
    role === AdminRole.SUPER_ADMIN ||
    role === AdminRole.STATE_MASTER ||
    role === AdminRole.LOCAL_BDE;
  if (!ok) {
    return <Navigate to="/" replace />;
  }
  return children;
}

function ProtectedShell() {
  return (
    <ProtectedRoute>
      <AdminShell />
    </ProtectedRoute>
  );
}

function ComplianceCaseRoute() {
  const { id } = useParams();
  if (!id) return <Navigate to="/compliance" replace />;
  return <ComplianceCasePage caseId={id} />;
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register/sender" element={<SenderRegisterPage />} />
      <Route path="/register/carrier" element={<CarrierRegisterPage />} />
      <Route path="/driver/invite/:token" element={<DriverInvitePage />} />
      <Route element={<ProtectedShell />}>
        <Route path="/" element={<HomePage />} />
        <Route
          path="/leads"
          element={
            <SuperOnly>
              <LeadsPage />
            </SuperOnly>
          }
        />
        <Route
          path="/leads/:id"
          element={
            <SuperOnly>
              <LeadDetailPage />
            </SuperOnly>
          }
        />
        <Route
          path="/audit"
          element={
            <SuperOnly>
              <AuditPage />
            </SuperOnly>
          }
        />
        <Route
          path="/compliance"
          element={
            <OpsOnly>
              <ComplianceQueuePage />
            </OpsOnly>
          }
        />
        <Route
          path="/compliance/:id"
          element={
            <OpsOnly>
              <ComplianceCaseRoute />
            </OpsOnly>
          }
        />
        <Route path="/sender/onboarding" element={<SenderOnboardingPage />} />
        <Route path="/carrier/onboarding" element={<CarrierOnboardingPage />} />
        <Route path="/driver/onboarding" element={<DriverOnboardingPage />} />
        <Route path="/jobs" element={<JobsListPage />} />
        <Route path="/jobs/new" element={<JobCreatePage />} />
        <Route path="/jobs/:id/edit" element={<JobEditPage />} />
        <Route path="/jobs/:id" element={<JobDetailPage />} />
        <Route path="/market" element={<MarketBoardPage />} />
        <Route path="/assignments" element={<CarrierAssignmentsPage />} />
        <Route path="/trips" element={<DriverTripsPage />} />
        <Route path="/trips/:tripId" element={<DriverTripDetailPage />} />
        <Route path="/jobs/:jobId/track" element={<SenderTrackPage />} />
        <Route path="/surcharges" element={<SurchargesPage />} />
        <Route path="/qa/upload" element={<QaUploadPage />} />
        <Route path="/account" element={<AccountPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
