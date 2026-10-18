import { CorrelationIdMiddleware } from './correlation-id.middleware';
import { SecurityHeadersMiddleware } from './security-headers.middleware';

describe('HTTP middleware leftovers', () => {
  describe('CorrelationIdMiddleware', () => {
    it('reuses incoming x-correlation-id', () => {
      const mw = new CorrelationIdMiddleware();
      const req = {
        header: jest.fn().mockReturnValue('corr-123'),
        headers: {} as Record<string, string>,
      };
      const res = { setHeader: jest.fn() };
      const next = jest.fn();

      mw.use(req as never, res as never, next);

      expect(req.headers['x-correlation-id']).toBe('corr-123');
      expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', 'corr-123');
      expect(next).toHaveBeenCalled();
    });

    it('generates UUID when header missing or blank', () => {
      const mw = new CorrelationIdMiddleware();
      const req = {
        header: jest.fn().mockReturnValue('   '),
        headers: {} as Record<string, string>,
      };
      const res = { setHeader: jest.fn() };
      const next = jest.fn();

      mw.use(req as never, res as never, next);

      expect(req.headers['x-correlation-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'x-correlation-id',
        req.headers['x-correlation-id'],
      );
      expect(next).toHaveBeenCalled();
    });
  });

  describe('SecurityHeadersMiddleware', () => {
    it('sets baseline security headers', () => {
      const mw = new SecurityHeadersMiddleware();
      const res = { setHeader: jest.fn() };
      const next = jest.fn();

      mw.use({} as never, res as never, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
      expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Referrer-Policy',
        'strict-origin-when-cross-origin',
      );
      expect(res.setHeader).toHaveBeenCalledWith('X-XSS-Protection', '0');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=()',
      );
      expect(next).toHaveBeenCalled();
    });
  });
});
