import { generateOtpCode, hashValue, safeEqual } from '../../common/utils/crypto';

describe('crypto utils', () => {
  it('hashes consistently', () => {
    expect(hashValue('123456')).toBe(hashValue('123456'));
    expect(hashValue('123456')).not.toBe(hashValue('654321'));
  });

  it('compares safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  it('generates padded OTP codes', () => {
    const code = generateOtpCode(6);
    expect(code).toMatch(/^\d{6}$/);
  });
});
