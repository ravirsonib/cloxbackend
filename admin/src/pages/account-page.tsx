import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IdentitySummary } from '@/components/identity-summary';
import { getErrorDetail, getIdentityMe, listSessions, revokeSession } from '@/lib/api';
import { LoadingBlock } from '@/components/status-blocks';
import { Button, DataCard, Notice, RoleBadge, useToast } from '@/components/ui';
import { useAuthStore } from '@/stores/auth-store';

export function AccountPage() {
  const { t } = useTranslation('common');
  const role = useAuthStore((s) => s.role);
  const qc = useQueryClient();
  const toast = useToast();

  const me = useQuery({
    queryKey: ['identity', 'me'],
    queryFn: () => getIdentityMe(),
  });

  const sessions = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: () => listSessions(),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeSession(id),
    onSuccess: async () => {
      toast.success(t('account.revokeSuccess'));
      await qc.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    },
    onError: (err) => toast.error(getErrorDetail(err)),
  });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-bold text-clox-ink">{t('account.title')}</h1>
        <RoleBadge role={role} />
      </div>
      <p className="mt-2 text-sm text-clox-mute">{t('account.subtitle')}</p>

      {me.isLoading || sessions.isLoading ? (
        <div className="mt-8">
          <LoadingBlock label={t('account.loading')} />
        </div>
      ) : null}

      {me.isError ? (
        <Notice tone="error" className="mt-4">
          {getErrorDetail(me.error)}
        </Notice>
      ) : null}

      {me.data ? <IdentitySummary me={me.data} className="clox-card mt-6 p-5" /> : null}

      <h2 className="mt-10 font-display text-lg font-semibold text-clox-ink">
        {t('account.activeSessions')}
      </h2>
      {sessions.isError ? (
        <Notice tone="error" className="mt-2">
          {getErrorDetail(sessions.error)}
        </Notice>
      ) : null}

      <ul className="mt-3 space-y-2">
        {(sessions.data?.data ?? []).map((s) => (
          <li key={s.id}>
            <DataCard className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className="font-medium text-clox-ink">
                  {s.deviceLabel || t('account.session')}{' '}
                  {s.isCurrent ? t('account.current') : ''}
                </p>
                <p className="text-xs text-clox-faint">
                  {t('account.lastUsed', { date: new Date(s.lastUsedAt).toLocaleString() })}
                </p>
              </div>
              {!s.isCurrent ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(s.id)}
                >
                  {t('account.revoke')}
                </Button>
              ) : null}
            </DataCard>
          </li>
        ))}
      </ul>
    </div>
  );
}
