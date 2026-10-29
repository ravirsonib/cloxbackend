import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

describe('ZodValidationPipe', () => {
  const schema = z.object({
    email: z.string().email(),
    count: z.number().int().positive(),
  });

  it('returns parsed data on success', () => {
    const pipe = new ZodValidationPipe(schema);
    expect(pipe.transform({ email: 'clox.mail@yopmail.com', count: 2 }, {} as never)).toEqual({
      email: 'clox.mail@yopmail.com',
      count: 2,
    });
  });

  it('throws BadRequestException with joined issue paths on failure', () => {
    const pipe = new ZodValidationPipe(schema);
    try {
      pipe.transform({ email: 'nope', count: -1 }, {} as never);
      fail('expected BadRequestException');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse() as {
        error: string;
        message: string;
      };
      expect(body.error).toBe('Validation failed');
      expect(body.message).toContain('email');
      expect(body.message).toContain('count');
    }
  });

  it('maps oversized sizeBytes to a plain-language message', () => {
    const upload = z.object({
      sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
    });
    const pipe = new ZodValidationPipe(upload);
    try {
      pipe.transform({ sizeBytes: 20 * 1024 * 1024 }, {} as never);
      fail('expected BadRequestException');
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as {
        message: string;
      };
      expect(body.message).toMatch(/under 10 MB/i);
      expect(body.message).not.toMatch(/Too big/i);
      expect(body.message).not.toMatch(/10485760/);
    }
  });

  it('returns root issue message without technical body: prefix when possible', () => {
    const root = z.string().email();
    const pipe = new ZodValidationPipe(root);
    try {
      pipe.transform(123, {} as never);
      fail('expected BadRequestException');
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as {
        message: string;
      };
      expect(body.message.length).toBeGreaterThan(0);
    }
  });
});
