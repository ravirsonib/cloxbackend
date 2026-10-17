import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  confirmDocument,
  createUploadIntent,
  getErrorDetail,
  getIdentityMe,
  submitCompliance,
  uploadDocumentContent,
} from '@/lib/api';
import { Button, Notice, Select } from '@/components/ui';
import { AppRole } from '@/shared/types';
import { useAuthStore } from '@/stores/auth-store';

type UploadedDoc = { id: string; docType: string; contentHash: string };

const SENDER_COMPANY = '00000000-0000-4000-8000-000000000001';
const CARRIER_COMPANY = '00000000-0000-4000-8000-000000000002';

export function QaUploadPage() {
  const { t } = useTranslation('common');
  const role = useAuthStore((s) => s.role);
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState('PUBLIC_LIABILITY');
  const [uploaded, setUploaded] = useState<UploadedDoc[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const me = useQuery({
    queryKey: ['identity', 'me'],
    queryFn: () => getIdentityMe(),
  });

  const companyId = useMemo(() => {
    if (me.data?.company?.id) return me.data.company.id;
    if (role === AppRole.SENDER) return SENDER_COMPANY;
    return CARRIER_COMPANY;
  }, [me.data, role]);

  const caseType =
    role === AppRole.SENDER ? ('SENDER_KYB' as const) : ('CARRIER_KYB' as const);

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error(t('qa.errorChooseFile'));
      const mime = (file.type || 'application/pdf') as
        | 'application/pdf'
        | 'image/jpeg'
        | 'image/png'
        | 'image/webp';
      const intent = await createUploadIntent({
        companyId,
        docType,
        originalFilename: file.name,
        mimeType: mime,
        sizeBytes: file.size,
      });
      const uploadedRes = await uploadDocumentContent(intent.id, file);
      await confirmDocument(intent.id, uploadedRes.contentHash);
      return {
        id: intent.id,
        docType,
        contentHash: uploadedRes.contentHash,
      };
    },
    onSuccess: (doc) => {
      setUploaded((prev) => [...prev.filter((d) => d.docType !== doc.docType), doc]);
      setMessage(
        t('qa.uploadedMessage', { docType: doc.docType, idPrefix: doc.id.slice(0, 8) }),
      );
      setFile(null);
    },
  });

  const submitMutation = useMutation({
    mutationFn: () =>
      submitCompliance({
        companyId,
        caseType,
        documentIds: uploaded.map((d) => d.id),
      }),
    onSuccess: (res) => {
      setMessage(
        t('qa.submittedMessage', {
          id: res.id.slice(0, 8),
          companyStatus: res.companyStatus,
        }),
      );
    },
  });

  const docOptions =
    role === AppRole.SENDER
      ? ['ABN_EXTRACT', 'GOVERNMENT_ID', 'OTHER']
      : ['PUBLIC_LIABILITY', 'CARGO_INSURANCE', 'RWC', 'ABN_EXTRACT', 'OTHER'];

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-2xl font-bold text-clox-ink">{t('qa.title')}</h1>
      <p className="mt-2 text-sm text-clox-mute">{t('qa.subtitle')}</p>

      <Notice tone="info" className="mt-4">
        companyId: <span className="font-mono text-clox-ink">{companyId}</span> · caseType:{' '}
        <span className="font-mono text-clox-ink">{caseType}</span>
      </Notice>

      <div className="mt-6">
        <Select
          label={t('qa.docTypeLabel')}
          value={docType}
          onChange={(e) => setDocType(e.target.value)}
        >
          {docOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
        <label className="mb-4 block">
          <span className="mb-1.5 block text-[12.5px] font-semibold text-clox-ink">
            {t('qa.fileLabel')}
          </span>
          <input
            type="file"
            accept=".pdf,image/jpeg,image/png,image/webp"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-clox-mute"
          />
        </label>

        {uploadMutation.isError || submitMutation.isError ? (
          <Notice tone="error" className="mb-4">
            {getErrorDetail(uploadMutation.error ?? submitMutation.error)}
          </Notice>
        ) : null}
        {message ? (
          <Notice tone="success" className="mb-4">
            {message}
          </Notice>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="cta"
            disabled={!file || uploadMutation.isPending}
            onClick={() => uploadMutation.mutate()}
          >
            {uploadMutation.isPending ? t('qa.uploading') : t('qa.uploadButton')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={uploaded.length === 0 || submitMutation.isPending}
            onClick={() => submitMutation.mutate()}
          >
            {submitMutation.isPending ? t('qa.submitting') : t('qa.submitButton')}
          </Button>
        </div>
      </div>

      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold text-clox-ink">{t('qa.readyDocs')}</h2>
        {uploaded.length === 0 ? (
          <p className="mt-2 text-sm text-clox-faint">{t('qa.noneYet')}</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {uploaded.map((d) => (
              <li
                key={d.id}
                className="rounded-clox-md border border-clox-border bg-clox-surface px-3 py-2 font-mono text-xs"
              >
                {d.docType} · {d.id}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
