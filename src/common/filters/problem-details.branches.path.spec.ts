import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { ProblemDetailsFilter } from './problem-details.filter';

describe('ProblemDetailsFilter branch leftovers', () => {
  function host(url = '/v1/x') {
    const json = jest.fn();
    const type = jest.fn().mockReturnValue({ json });
    const status = jest.fn().mockReturnValue({ type });
    return {
      host: {
        switchToHttp: () => ({
          getResponse: () => ({ status }),
          getRequest: () => ({ url }),
        }),
      } as never,
      status,
      json,
    };
  }

  it('uses string HttpException response as detail', () => {
    const filter = new ProblemDetailsFilter();
    const { host: h, json } = host();
    // Nest BadRequestException('x') wraps into an object; raw HttpException string hits the string arm.
    filter.catch(new HttpException('plain string', HttpStatus.BAD_REQUEST), h);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: 'plain string',
        title: expect.any(String),
      }),
    );
  });

  it('maps non-Error unknown to Unexpected error', () => {
    const filter = new ProblemDetailsFilter();
    const { host: h, status, json } = host();
    filter.catch('not-an-error', h);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'Unexpected error', status: 500 }),
    );
  });

  it('copies known extra fields and skips undefined extras', () => {
    const filter = new ProblemDetailsFilter();
    const { host: h, json } = host();
    filter.catch(
      new HttpException(
        {
          error: 'Conflict',
          message: 'locked',
          code: 'JOB_LOCKED',
          jobId: 'j1',
          proposalId: 'p1',
          amountIncGstCents: 100,
          nextMilestone: 'M10',
          goNoGo: false,
          minBaseCents: 50,
          recommended: 'SEMI',
          ignored: 'x',
          amountIncGstCentsUndefined: undefined,
        },
        HttpStatus.CONFLICT,
      ),
      h,
    );
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'JOB_LOCKED',
        jobId: 'j1',
        proposalId: 'p1',
        amountIncGstCents: 100,
        nextMilestone: 'M10',
        goNoGo: false,
        minBaseCents: 50,
        recommended: 'SEMI',
      }),
    );
    const body = json.mock.calls[0][0] as Record<string, unknown>;
    expect(body.ignored).toBeUndefined();
  });

  it('skips extra copy when response is an array', () => {
    const filter = new ProblemDetailsFilter();
    const { host: h, json } = host();
    filter.catch(new BadRequestException(['a', 'b'] as never), h);
    const body = json.mock.calls[0][0] as Record<string, unknown>;
    expect(body.code).toBeUndefined();
  });

  it('falls back title when status has no HttpStatus enum label', () => {
    const filter = new ProblemDetailsFilter();
    const { host: h, json } = host();
    filter.catch(new HttpException({ message: 'weird' }, 599), h);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Error', detail: 'weird', status: 599 }),
    );
  });
});
