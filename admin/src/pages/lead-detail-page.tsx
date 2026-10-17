import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LoadingBlock } from '@/components/status-blocks';
import { KeyValueList } from '@/components/identity-summary';
import { Button, Notice, Select, TextArea, Timeline, useToast } from '@/components/ui';
import { addLeadNote, getErrorDetail, getLead, updateLead } from '@/lib/api';
import { formatAuditAction } from '@/lib/audit-format';
import {
  LEAD_STATUS_KEYS,
  formatDateTime,
  formatLeadStatus,
  formatLeadType,
} from '@/lib/leads';
import { LeadStatus } from '@/shared/types';

export function LeadDetailPage() {
  const { t } = useTranslation('common');
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [status, setStatus] = useState<LeadStatus | ''>('');
  const [priority, setPriority] = useState(false);
  const [note, setNote] = useState('');

  const leadQuery = useQuery({
    queryKey: ['admin', 'lead', id],
    queryFn: ({ signal }) => getLead(id, { signal }),
    enabled: Boolean(id),
  });

  const lead = leadQuery.data;

  useEffect(() => {
    if (lead) {
      setStatus(lead.status);
      setPriority(lead.priority);
    }
  }, [lead]);

  const updateMutation = useMutation({
    mutationFn: () =>
      updateLead(id, {
        status: status || undefined,
        priority,
      }),
    onSuccess: () => {
      toast.success(t('saved'));
      void queryClient.invalidateQueries({ queryKey: ['admin', 'lead', id] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'leads'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
    },
    onError: (err) => toast.error(getErrorDetail(err)),
  });

  const noteMutation = useMutation({
    mutationFn: () => addLeadNote(id, { body: note.trim() }),
    onSuccess: () => {
      setNote('');
      toast.success(t('saved'));
      void queryClient.invalidateQueries({ queryKey: ['admin', 'lead', id] });
    },
    onError: (err) => toast.error(getErrorDetail(err)),
  });

  return (
    <div>
      <Link to="/leads" className="text-sm font-medium text-clox-orange hover:underline">
        ← {t('admin.leadsTitle')}
      </Link>

      {leadQuery.isLoading ? (
        <div className="mt-6">
          <LoadingBlock label={t('loading')} />
        </div>
      ) : null}

      {leadQuery.isError ? (
        <Notice tone="error" className="mt-6">
          {getErrorDetail(leadQuery.error)}
        </Notice>
      ) : null}

      {lead ? (
        <div className="mt-4 grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <section className="clox-card p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-clox-orange">
                {formatLeadType(lead.type)}
              </p>
              <h1 className="mt-2 break-words font-display text-2xl font-bold text-clox-ink sm:text-3xl">
                {lead.companyName || lead.email}
              </h1>
              <p className="mt-1 break-all text-clox-mute">{lead.email}</p>
              <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-clox-faint">{t('admin.phone')}</dt>
                  <dd className="text-clox-ink">{lead.phone || t('dash')}</dd>
                </div>
                <div>
                  <dt className="text-clox-faint">{t('admin.abnAcn')}</dt>
                  <dd className="text-clox-ink">
                    {[lead.abn, lead.acn].filter(Boolean).join(' / ') || t('dash')}
                  </dd>
                </div>
                <div>
                  <dt className="text-clox-faint">{t('admin.location')}</dt>
                  <dd className="text-clox-ink">
                    {[lead.state, lead.territory].filter(Boolean).join(' · ') || t('dash')}
                  </dd>
                </div>
                <div>
                  <dt className="text-clox-faint">{t('admin.source')}</dt>
                  <dd className="text-clox-ink">{lead.source || t('dash')}</dd>
                </div>
                <div>
                  <dt className="text-clox-faint">{t('admin.created')}</dt>
                  <dd className="text-clox-ink">{formatDateTime(lead.createdAt)}</dd>
                </div>
                <div>
                  <dt className="text-clox-faint">{t('admin.updated')}</dt>
                  <dd className="text-clox-ink">{formatDateTime(lead.updatedAt)}</dd>
                </div>
              </dl>
            </section>

            <section className="clox-card p-5">
              <h2 className="font-display text-lg font-semibold text-clox-ink">
                {t('admin.payload')}
              </h2>
              <div className="mt-3 max-h-96 overflow-y-auto">
                <KeyValueList data={lead.payload ?? {}} emptyLabel={t('admin.noPayload')} />
              </div>
            </section>

            <section className="clox-card p-5">
              <h2 className="font-display text-lg font-semibold text-clox-ink">
                {t('admin.notes')}
              </h2>
              <form
                className="mt-3 space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (note.trim()) noteMutation.mutate();
                }}
              >
                <TextArea
                  rows={3}
                  placeholder={t('admin.notePlaceholder')}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
                <Button
                  type="submit"
                  variant="cta"
                  disabled={noteMutation.isPending || !note.trim()}
                >
                  {noteMutation.isPending ? t('loading') : t('admin.addNote')}
                </Button>
              </form>
              <ul className="mt-5 space-y-3">
                {(lead.notes ?? []).length === 0 ? (
                  <li className="text-sm text-clox-faint">{t('admin.noNotes')}</li>
                ) : (
                  lead.notes.map((item) => (
                    <li
                      key={item.id}
                      className="rounded-xl border border-clox-border bg-clox-surface-alt p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-clox-faint">
                        <span>
                          {item.author?.name || item.author?.email || t('admin.adminFallback')}
                        </span>
                        <span>{formatDateTime(item.createdAt)}</span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-clox-text">{item.body}</p>
                    </li>
                  ))
                )}
              </ul>
            </section>
          </div>

          <div className="space-y-6">
            <section className="clox-card p-5">
              <h2 className="font-display text-lg font-semibold text-clox-ink">
                {t('admin.review')}
              </h2>
              <div className="mt-4 space-y-3">
                <Select
                  label={t('admin.status')}
                  value={status}
                  onChange={(event) => setStatus(event.target.value as LeadStatus)}
                >
                  {LEAD_STATUS_KEYS.map((value) => (
                    <option key={value} value={value}>
                      {t(`leadStatuses.${value}`)}
                    </option>
                  ))}
                </Select>
                <label className="flex items-center gap-2 text-sm text-clox-mute">
                  <input
                    type="checkbox"
                    checked={priority}
                    onChange={(event) => setPriority(event.target.checked)}
                  />
                  {t('admin.priority')}
                </label>
                <Button
                  variant="cta"
                  size="block"
                  disabled={updateMutation.isPending}
                  onClick={() => updateMutation.mutate()}
                >
                  {updateMutation.isPending ? t('loading') : t('admin.saveStatus')}
                </Button>
                <p className="text-xs text-clox-faint">
                  {t('admin.currentStatus', { status: formatLeadStatus(lead.status) })}
                </p>
              </div>
            </section>

            <section className="clox-card p-5">
              <h2 className="font-display text-lg font-semibold text-clox-ink">
                {t('admin.activity')}
              </h2>
              <Timeline
                className="mt-4"
                items={(lead.events ?? []).map((event, index) => ({
                  id: event.id,
                  title: formatAuditAction(event.action, t),
                  subtitle: `${event.actor?.email || t('system')} · ${formatDateTime(event.createdAt)}`,
                  tone: index === 0 ? 'now' : 'done',
                }))}
                empty={<p className="text-sm text-clox-faint">{t('admin.noEvents')}</p>}
              />
            </section>

            <Link to="/leads" className="clox-btn clox-btn-secondary inline-flex w-full justify-center">
              {t('admin.backToQueue')}
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
