import { AppModule } from './app.module';

describe('AppModule wiring leftover', () => {
  it('registers correlation + security middleware for all routes', () => {
    const module = new AppModule();
    const apply = jest.fn().mockReturnValue({ forRoutes: jest.fn() });
    const consumer = { apply } as never;
    module.configure(consumer);
    expect(apply).toHaveBeenCalled();
    expect(apply.mock.results[0].value.forRoutes).toHaveBeenCalledWith('*');
  });
});
