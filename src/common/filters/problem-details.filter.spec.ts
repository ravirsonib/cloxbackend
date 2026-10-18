import { BadRequestException, HttpStatus } from '@nestjs/common';
import { ProblemDetailsFilter } from './problem-details.filter';

describe('ProblemDetailsFilter', () => {
  function host(url = '/v1/jobs') {
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
      type,
      json,
    };
  }

  it('maps HttpException object response with code into problem+json', () => {
    const filter = new ProblemDetailsFilter();
    const { host: h, status, type, json } = host();
    filter.catch(
      new BadRequestException({
        error: 'Bad Request',
        message: 'Sender payment method not ready',
        code: 'SENDER_NOT_PAYMENT_READY',
      }),
      h,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(type).toHaveBeenCalledWith('application/problem+json');
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'Sender payment method not ready',
        code: 'SENDER_NOT_PAYMENT_READY',
        instance: '/v1/jobs',
      }),
    );
  });

  it('joins array message and maps unknown Error to 500', () => {
    const filter = new ProblemDetailsFilter();
    const { host: h, json } = host('/x');
    filter.catch(
      new BadRequestException({ message: ['a', 'b'], error: 'Validation' }),
      h,
    );
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'a; b', title: 'Validation' }),
    );

    const again = host('/y');
    filter.catch(new Error('boom'), again.host);
    expect(again.status).toHaveBeenCalledWith(500);
    expect(again.json).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'boom', status: 500 }),
    );
  });
});
