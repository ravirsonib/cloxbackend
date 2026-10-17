import { useTranslation } from 'react-i18next';
import { RoleBadge } from '@/components/ui';
import type { IdentityMe } from '@/lib/api/identity.types';
import { roleBadgeLabel } from '@/lib/role-theme';

export type { IdentityMe };

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-semibold text-clox-faint">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-clox-ink">{value}</dd>
    </div>
  );
}

function humanStatus(value: string | boolean | null | undefined, t: (k: string) => string) {
  if (value === true || value === 'ACTIVE') return t('identity.active');
  if (value === false) return t('identity.inactive');
  if (!value) return t('dash');
  return String(value).replaceAll('_', ' ');
}

export function IdentitySummary({
  me,
  className,
}: {
  me: IdentityMe;
  className?: string;
}) {
  const { t } = useTranslation('common');
  const displayName = me.name?.trim() || me.email;
  const scopeText =
    me.scopes && me.scopes.length > 0
      ? me.scopes
          .map((s) =>
            [s.scopeType, s.regionCode, s.territoryCode].filter(Boolean).join(' · '),
          )
          .join(', ')
      : null;

  return (
    <section className={className ?? 'clox-card p-5'}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-lg font-semibold text-clox-ink">{displayName}</h2>
        <RoleBadge role={me.role} />
      </div>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <Row label={t('email')} value={me.email} />
        {me.phone ? <Row label={t('phone')} value={me.phone} /> : null}
        <Row label={t('identity.role')} value={roleBadgeLabel(me.role)} />
        {me.kind === 'admin' ? (
          <Row label={t('identity.accountStatus')} value={humanStatus(me.active, t)} />
        ) : (
          <Row label={t('identity.accountStatus')} value={humanStatus(me.status, t)} />
        )}
        {me.company ? (
          <>
            <Row
              label={t('identity.company')}
              value={me.company.legalName || t('dash')}
            />
            <Row
              label={t('identity.companyStatus')}
              value={humanStatus(me.company.status, t)}
            />
          </>
        ) : null}
        {scopeText ? <Row label={t('identity.scope')} value={scopeText} /> : null}
      </dl>
    </section>
  );
}

/** Readable key/value dump for ops payloads (no raw JSON). */
export function KeyValueList({
  data,
  emptyLabel,
}: {
  data: unknown;
  emptyLabel: string;
}) {
  if (data == null || (typeof data === 'object' && Object.keys(data as object).length === 0)) {
    return <p className="text-sm text-clox-faint">{emptyLabel}</p>;
  }

  if (typeof data !== 'object') {
    return <p className="text-sm text-clox-ink">{String(data)}</p>;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <p className="text-sm text-clox-faint">{emptyLabel}</p>;
    }
    return (
      <ul className="space-y-2">
        {data.map((item, index) => (
          <li key={index} className="rounded-lg border border-clox-border bg-clox-surface-alt p-3">
            <KeyValueList data={item} emptyLabel={emptyLabel} />
          </li>
        ))}
      </ul>
    );
  }

  const entries = Object.entries(data as Record<string, unknown>);
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {entries.map(([key, value]) => {
        const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
        const isNested = value != null && typeof value === 'object';
        return (
          <div key={key} className={isNested ? 'sm:col-span-2' : 'min-w-0'}>
            <dt className="text-[12px] font-semibold text-clox-faint">{label}</dt>
            <dd className="mt-0.5 text-sm text-clox-ink">
              {isNested ? (
                <div className="mt-1 rounded-lg border border-clox-border-soft bg-clox-surface-alt/60 p-3">
                  <KeyValueList data={value} emptyLabel="—" />
                </div>
              ) : value == null || value === '' ? (
                '—'
              ) : (
                String(value)
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
