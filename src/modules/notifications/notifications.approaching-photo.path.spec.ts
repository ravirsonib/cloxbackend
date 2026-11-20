import { NotificationsService } from './notifications.service';

describe('NotificationsService.notifyTripApproaching identity', () => {
  it('includes driver name, vehicle, and photo attachment', async () => {
    const service = new NotificationsService({
      get: (key: string) =>
        key === 'ADMIN_APP_URL' ? 'http://localhost:5174' : undefined,
    } as never);
    const sendBranded = jest
      .spyOn(
        service as unknown as { sendBranded: (...args: unknown[]) => Promise<unknown> },
        'sendBranded',
      )
      .mockResolvedValue({ skipped: false });

    const photo = {
      filename: 'CLOX-driver-photo-abc.jpg',
      content: Buffer.from('fake-image'),
      contentType: 'image/jpeg',
    };

    await service.notifyTripApproaching({
      senderEmails: ['sender@example.com'],
      receiverEmail: 'receiver@example.com',
      jobId: 'job-1',
      jobTitle: 'Metro drop',
      dropSuburb: 'Richmond',
      dropAddress: '1 Swan St',
      etaLabel: '~15 min',
      source: 'DRIVER',
      driverName: 'Jamie Nguyen',
      vehicleRego: 'ABC123',
      facePhoto: photo,
    });

    expect(sendBranded).toHaveBeenCalledTimes(2);
    for (const call of sendBranded.mock.calls) {
      const arg = call[0] as {
        details: Array<{ label: string; value: string }>;
        attachments?: Array<{ filename: string }>;
        intro: string;
      };
      expect(arg.details).toEqual(
        expect.arrayContaining([
          { label: 'Driver', value: 'Jamie Nguyen' },
          { label: 'Vehicle', value: 'ABC123' },
        ]),
      );
      expect(arg.attachments?.[0]?.filename).toBe('CLOX-driver-photo-abc.jpg');
      expect(arg.intro).toContain('Jamie Nguyen');
      expect(arg.intro).toContain('ABC123');
    }
  });
});
