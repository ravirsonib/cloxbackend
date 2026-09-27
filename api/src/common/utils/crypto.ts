import { createHash, randomInt, timingSafeEqual } from 'crypto';

export function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashIp(ip: string | undefined): string | undefined {
  if (!ip) {
    return undefined;
  }
  return hashValue(ip);
}

export function generateOtpCode(length: number): string {
  const max = 10 ** length;
  return randomInt(0, max).toString().padStart(length, '0');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
