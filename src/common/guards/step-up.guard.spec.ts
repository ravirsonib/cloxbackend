import {
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { StepUpGuard } from './step-up.guard';

describe('StepUpGuard', () => {
  function mockCtx(opts: {
    user?: { id: string };
    header?: string | string[];
  }) {
    const request: {
      user?: { id: string };
      headers: Record<string, string | string[] | undefined>;
    } = {
      user: opts.user,
      headers: { 'x-step-up-token': opts.header },
    };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    };
  }

  it('rejects when principal is missing', async () => {
    const guard = new StepUpGuard(
      { verifyAsync: jest.fn() } as never,
      { get: () => 'secret' } as never,
    );
    await expect(guard.canActivate(mockCtx({}) as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when step-up header is missing', async () => {
    const guard = new StepUpGuard(
      { verifyAsync: jest.fn() } as never,
      { get: () => 'secret' } as never,
    );
    await expect(
      guard.canActivate(mockCtx({ user: { id: 'admin-1' } }) as never),
    ).rejects.toMatchObject({ message: 'Step-up OTP required' });
  });

  it('accepts valid stepup token matching principal', async () => {
    const verifyAsync = jest.fn().mockResolvedValue({
      sub: 'admin-1',
      typ: 'stepup',
      kind: 'admin',
    });
    const guard = new StepUpGuard(
      { verifyAsync } as never,
      { get: () => 'secret' } as never,
    );
    await expect(
      guard.canActivate(
        mockCtx({ user: { id: 'admin-1' }, header: 'tok' }) as never,
      ),
    ).resolves.toBe(true);
    expect(verifyAsync).toHaveBeenCalledWith('tok', { secret: 'secret' });
  });

  it('rejects when typ is not stepup or sub mismatches', async () => {
    const guard = new StepUpGuard(
      {
        verifyAsync: jest.fn().mockResolvedValue({
          sub: 'other',
          typ: 'stepup',
          kind: 'admin',
        }),
      } as never,
      { get: () => 'secret' } as never,
    );
    await expect(
      guard.canActivate(
        mockCtx({ user: { id: 'admin-1' }, header: 'tok' }) as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects expired/invalid JWT as Invalid or expired step-up token', async () => {
    const guard = new StepUpGuard(
      {
        verifyAsync: jest.fn().mockRejectedValue(new Error('jwt expired')),
      } as never,
      { get: () => 'secret' } as never,
    );
    await expect(
      guard.canActivate(
        mockCtx({ user: { id: 'admin-1' }, header: ['tok'] }) as never,
      ),
    ).rejects.toMatchObject({ message: 'Invalid or expired step-up token' });
  });
});
