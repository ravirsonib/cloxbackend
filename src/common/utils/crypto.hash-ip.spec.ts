import { hashIp, safeEqual } from './crypto';

describe('crypto hashIp leftovers', () => {
  it('hashIp returns undefined for missing ip', () => {
    expect(hashIp(undefined)).toBeUndefined();
  });

  it('hashIp hashes a provided ip', () => {
    expect(hashIp('127.0.0.1')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('safeEqual returns false when lengths differ', () => {
    expect(safeEqual('ab', 'abc')).toBe(false);
  });
});
