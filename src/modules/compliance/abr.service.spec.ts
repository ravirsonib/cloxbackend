import { AbrService } from './abr.service';

describe('AbrService', () => {
  it('returns configured false when ABR_GUID missing', async () => {
    const service = new AbrService({ get: () => undefined } as never);
    await expect(service.lookupAbn('51 824 753 556')).resolves.toMatchObject({
      configured: false,
      abn: '51824753556',
      active: null,
      message: expect.stringContaining('ABR_GUID not configured'),
    });
  });

  it('parses JSONP callback response when configured', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      text: async () =>
        'callback({"Abn":"51824753556","EntityName":"Test Co","AbnStatus":"Active","Message":"ok"});',
    } as Response);

    const service = new AbrService({
      get: () => 'guid-1',
    } as never);
    const result = await service.lookupAbn('51824753556');
    expect(result).toMatchObject({
      configured: true,
      abn: '51824753556',
      active: true,
      entityName: 'Test Co',
      abnStatus: 'Active',
    });
    expect(fetchMock).toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('returns manual-verify message when fetch fails', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('network'));
    const service = new AbrService({ get: () => 'guid-1' } as never);
    await expect(service.lookupAbn('51824753556')).resolves.toMatchObject({
      configured: true,
      active: null,
      message: 'ABR lookup failed — verify manually',
    });
    fetchMock.mockRestore();
  });

  it('inactive status + missing optional fields use fallbacks', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      text: async () => 'callback({"AbnStatus":"Cancelled"});',
    } as Response);
    const service = new AbrService({ get: () => 'guid-1' } as never);
    await expect(service.lookupAbn('51 824 753 556')).resolves.toMatchObject({
      configured: true,
      active: false,
      entityName: null,
      abnStatus: 'Cancelled',
      message: 'See AbnStatus',
    });
    fetchMock.mockRestore();
  });

  it('missing AbnStatus yields active null + assist message when Message absent', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      text: async () => 'callback({"EntityName":"Only Name"})',
    } as Response);
    const service = new AbrService({ get: () => 'guid-1' } as never);
    await expect(service.lookupAbn('51824753556')).resolves.toMatchObject({
      active: null,
      entityName: 'Only Name',
      abnStatus: null,
      message: 'See AbnStatus',
    });
    fetchMock.mockRestore();
  });

  it('active without Message uses assist-only copy', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      text: async () => 'callback({"AbnStatus":"ACTIVE"})',
    } as Response);
    const service = new AbrService({ get: () => 'guid-1' } as never);
    await expect(service.lookupAbn('51824753556')).resolves.toMatchObject({
      active: true,
      message: 'ABN appears active (assist only)',
    });
    fetchMock.mockRestore();
  });

  it('non-Error throw still returns manual-verify message', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue('boom');
    const service = new AbrService({ get: () => 'guid-1' } as never);
    await expect(service.lookupAbn('51824753556')).resolves.toMatchObject({
      configured: true,
      message: 'ABR lookup failed — verify manually',
    });
    fetchMock.mockRestore();
  });
});
