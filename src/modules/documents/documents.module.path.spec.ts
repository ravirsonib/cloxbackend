import { DocumentsModule } from './documents.module';
import { DocumentsService } from './documents.service';

describe('DocumentsModule onModuleInit leftover', () => {
  it('calls ensureStorageDir on init', () => {
    const documentsService = {
      ensureStorageDir: jest.fn(),
    };
    const mod = new DocumentsModule(documentsService as unknown as DocumentsService);
    mod.onModuleInit();
    expect(documentsService.ensureStorageDir).toHaveBeenCalled();
  });
});
