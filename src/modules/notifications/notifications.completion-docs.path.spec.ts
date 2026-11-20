import { NotificationsService } from './notifications.service';

describe('NotificationsService.notifyTripCompletionDocuments role scoping', () => {
  function makeService() {
    const config = {
      get: (key: string) =>
        key === 'ADMIN_APP_URL' ? 'http://localhost:5174' : undefined,
    } as never;
    const service = new NotificationsService(config);
    const sendBranded = jest
      .spyOn(
        service as unknown as { sendBranded: (...args: unknown[]) => Promise<unknown> },
        'sendBranded',
      )
      .mockResolvedValue({ skipped: false });
    return { service, sendBranded };
  }

  const pdf = (name: string) => ({
    filename: name,
    content: Buffer.from(`%PDF-${name}`),
    contentType: 'application/pdf',
  });

  it('sends tax invoice only to sender; run sheet to sender+carrier; POD to sender+receiver', async () => {
    const { service, sendBranded } = makeService();
    const taxInvoice = pdf('CLOX-tax-invoice-abc.pdf');
    const runSheet = pdf('CLOX-run-sheet-abc.pdf');
    const pod = pdf('CLOX-POD-abc.pdf');

    const result = await service.notifyTripCompletionDocuments({
      senderEmails: ['sender@example.com', 'SENDER@example.com'],
      carrierEmails: ['carrier@example.com'],
      receiverEmail: 'receiver@example.com',
      jobId: 'job-1',
      jobTitle: 'Metro day hire',
      totalIncGstCents: 14200,
      taxInvoice,
      runSheet,
      pod,
    });

    expect(result.byRole).toEqual({
      sender: ['sender@example.com'],
      carrier: ['carrier@example.com'],
      receiver: ['receiver@example.com'],
    });

    const calls = sendBranded.mock.calls.map((c) => c[0] as {
      to: string;
      attachments?: Array<{ filename: string }>;
    });

    const byTo = Object.fromEntries(calls.map((c) => [c.to, c]));
    expect(byTo['sender@example.com']?.attachments?.map((a) => a.filename)).toEqual([
      'CLOX-tax-invoice-abc.pdf',
      'CLOX-run-sheet-abc.pdf',
      'CLOX-POD-abc.pdf',
    ]);
    expect(byTo['carrier@example.com']?.attachments?.map((a) => a.filename)).toEqual([
      'CLOX-run-sheet-abc.pdf',
    ]);
    expect(byTo['receiver@example.com']?.attachments?.map((a) => a.filename)).toEqual([
      'CLOX-POD-abc.pdf',
    ]);
    expect(sendBranded).toHaveBeenCalledTimes(3);
  });

  it('does not email tax invoice to carrier or receiver when no run sheet/POD', async () => {
    const { service, sendBranded } = makeService();

    await service.notifyTripCompletionDocuments({
      senderEmails: ['sender@example.com'],
      carrierEmails: ['carrier@example.com'],
      receiverEmail: 'receiver@example.com',
      jobId: 'job-2',
      jobTitle: null,
      totalIncGstCents: 10000,
      taxInvoice: pdf('CLOX-tax-invoice-xyz.pdf'),
      runSheet: null,
      pod: null,
    });

    expect(sendBranded).toHaveBeenCalledTimes(1);
    expect(sendBranded.mock.calls[0]?.[0]).toMatchObject({
      to: 'sender@example.com',
      attachments: [expect.objectContaining({ filename: 'CLOX-tax-invoice-xyz.pdf' })],
    });
  });
});
