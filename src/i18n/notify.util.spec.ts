import { DEFAULT_LOCALE } from '../shared/types';
import { tNotify } from './notify.util';

describe('tNotify', () => {
  it('returns English for unknown locale', () => {
    expect(tNotify('ru', 'otp.subject')).toBe(tNotify(DEFAULT_LOCALE, 'otp.subject'));
  });

  it('interpolates vars', () => {
    expect(
      tNotify('en', 'bid.received.body', { amount: '12.50' }),
    ).toContain('12.50');
  });

  it('falls back to English when key missing in locale catalog', () => {
    expect(tNotify('hi', 'otp.subject')).toBeTruthy();
    expect(tNotify('hi', 'otp.subject')).not.toBe('otp.subject');
  });

  it('returns key when completely unknown', () => {
    expect(tNotify('en', 'does.not.exist')).toBe('does.not.exist');
  });
});
