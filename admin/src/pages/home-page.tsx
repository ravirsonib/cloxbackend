import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IdentitySummary } from '@/components/identity-summary';
import { DashboardPage } from '@/pages/dashboard-page';
import { LoadingBlock } from '@/components/status-blocks';
import { Notice, RoleBadge, dataCardClassName } from '@/components/ui';
import { getErrorDetail, getIdentityMe } from '@/lib/api';
import { cn } from '@/lib/cn';
import { AdminRole, AppRole } from '@/shared/types';
import { useAuthStore } from '@/stores/auth-store';

export function HomePage() {
  const role = useAuthStore((s) => s.role);

  if (role === AdminRole.SUPER_ADMIN) {
    return <DashboardPage />;
  }

  return <RoleHomePage />;
}

function HomeLink({
  to,
  title,
  hint,
}: {
  to: string;
  title: string;
  hint: string;
}) {
  return (
    <Link to={to} className={cn('block h-full', dataCardClassName)}>
      <p className="font-display text-lg font-semibold text-clox-ink">{title}</p>
      <p className="mt-1 text-sm text-clox-mute">{hint}</p>
    </Link>
  );
}

function RoleHomePage() {
  const { t } = useTranslation('common');
  const role = useAuthStore((s) => s.role);
  const email = useAuthStore((s) => s.email);

  const me = useQuery({
    queryKey: ['identity', 'me'],
    queryFn: () => getIdentityMe(),
  });

  const isOps = role === AdminRole.STATE_MASTER || role === AdminRole.LOCAL_BDE;
  const isMarketplace =
    role === AppRole.SENDER ||
    role === AppRole.TRANSPORT_COMPANY ||
    role === AppRole.DRIVER;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-bold text-clox-ink sm:text-3xl">
          {t('home.title')}
        </h1>
        <RoleBadge role={role} />
      </div>
      <p className="mt-2 text-sm text-clox-mute">
        {t('home.signedInAs')} <span className="font-medium text-clox-ink">{email}</span>
      </p>

      {me.isLoading ? (
        <div className="mt-6">
          <LoadingBlock label={t('loading')} />
        </div>
      ) : null}

      {me.isError ? (
        <Notice tone="error" className="mt-4">
          {getErrorDetail(me.error)}
        </Notice>
      ) : null}

      {me.data ? <IdentitySummary me={me.data} className="clox-card mt-6 p-5" /> : null}

      <h2 className="mt-8 font-display text-lg font-semibold text-clox-ink">
        {t('home.shortcuts')}
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {isOps ? (
          <HomeLink
            to="/compliance"
            title={t('home.complianceTitle')}
            hint={t('home.complianceHint')}
          />
        ) : null}
        {isMarketplace ? (
          <HomeLink to="/qa/upload" title={t('home.qaTitle')} hint={t('home.qaHint')} />
        ) : null}
        {role === AppRole.SENDER ? (
          <HomeLink
            to="/sender/onboarding"
            title={t('home.senderOnboardingTitle')}
            hint={t('home.senderOnboardingHint')}
          />
        ) : null}
        {role === AppRole.SENDER ? (
          <HomeLink to="/jobs" title={t('home.jobsTitle')} hint={t('home.jobsHint')} />
        ) : null}
        {role === AppRole.SENDER ? (
          <HomeLink
            to="/surcharges"
            title={t('home.surchargesTitle')}
            hint={t('home.surchargesHint')}
          />
        ) : null}
        {role === AppRole.TRANSPORT_COMPANY ? (
          <HomeLink
            to="/carrier/onboarding"
            title={t('home.carrierOnboardingTitle')}
            hint={t('home.carrierOnboardingHint')}
          />
        ) : null}
        {role === AppRole.TRANSPORT_COMPANY ? (
          <HomeLink
            to="/market"
            title={t('home.jobBoardTitle')}
            hint={t('home.jobBoardHint')}
          />
        ) : null}
        {role === AppRole.TRANSPORT_COMPANY ? (
          <HomeLink
            to="/assignments"
            title={t('home.assignmentsTitle')}
            hint={t('home.assignmentsHint')}
          />
        ) : null}
        {role === AppRole.DRIVER ? (
          <HomeLink
            to="/driver/onboarding"
            title={t('home.driverOnboardingTitle')}
            hint={t('home.driverOnboardingHint')}
          />
        ) : null}
        {role === AppRole.DRIVER ? (
          <HomeLink to="/trips" title={t('home.tripsTitle')} hint={t('home.tripsHint')} />
        ) : null}
        <HomeLink to="/account" title={t('home.accountTitle')} hint={t('home.accountHint')} />
      </div>
    </div>
  );
}
