import { TranslationsService } from './translations.service';

describe('TranslationsService.preview', () => {
  it('returns identity when source and target match', async () => {
    const prisma = {
      isConnected: () => true,
      contentTranslation: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };
    const service = new TranslationsService(prisma as never);
    const result = await service.preview({
      text: 'Hello note',
      targetLocale: 'en',
      sourceLocale: 'en',
    });
    expect(result.translatedText).toBe('Hello note');
    expect(result.provider).toBe('identity');
    expect(prisma.contentTranslation.findUnique).not.toHaveBeenCalled();
  });

  it('caches stub translation per sourceHash + targetLocale', async () => {
    const create = jest.fn().mockResolvedValue({
      text: '[hi] Hello note',
      provider: 'stub',
      sourceLocale: null,
    });
    const prisma = {
      isConnected: () => true,
      contentTranslation: {
        findUnique: jest.fn().mockResolvedValue(null),
        create,
      },
    };
    const service = new TranslationsService(prisma as never);
    const result = await service.preview({
      text: 'Hello note',
      targetLocale: 'hi',
    });
    expect(result.translatedText).toBe('[hi] Hello note');
    expect(result.cached).toBe(false);
    expect(create).toHaveBeenCalled();
  });

  it('returns cached row when present', async () => {
    const prisma = {
      isConnected: () => true,
      contentTranslation: {
        findUnique: jest.fn().mockResolvedValue({
          text: '[pa] cached',
          provider: 'stub',
          sourceLocale: 'en',
        }),
        create: jest.fn(),
      },
    };
    const service = new TranslationsService(prisma as never);
    const result = await service.preview({
      text: 'anything',
      targetLocale: 'pa',
    });
    expect(result.translatedText).toBe('[pa] cached');
    expect(result.cached).toBe(true);
    expect(prisma.contentTranslation.create).not.toHaveBeenCalled();
  });
});
