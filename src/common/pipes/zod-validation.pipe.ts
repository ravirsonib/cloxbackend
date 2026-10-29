import {
  ArgumentMetadata,
  BadRequestException,
  PipeTransform,
} from '@nestjs/common';
import type { ZodIssue, ZodType } from 'zod';

const FILE_TOO_LARGE =
  'This file is too large. Please choose a file under 10 MB.';
const UNSUPPORTED_FILE_TYPE =
  'Unsupported file type. Please use PDF, JPEG, PNG, or WebP.';

function formatZodIssue(issue: ZodIssue): string {
  const path = issue.path.join('.');

  if (path === 'sizeBytes' || path.endsWith('.sizeBytes')) {
    return FILE_TOO_LARGE;
  }
  if (path === 'mimeType' || path.endsWith('.mimeType')) {
    return UNSUPPORTED_FILE_TYPE;
  }
  if (path === 'originalFilename' || path.endsWith('.originalFilename')) {
    if (issue.code === 'too_small') {
      return 'Please choose a file with a valid name.';
    }
    return issue.message;
  }

  // Zod default "Too big: expected number to be <=N" is not user-facing.
  if (/^Too (big|small):/i.test(issue.message)) {
    if (typeof (issue as { maximum?: unknown }).maximum === 'number') {
      const max = (issue as { maximum: number }).maximum;
      if (max === 10 * 1024 * 1024) return FILE_TOO_LARGE;
    }
    return path
      ? `Please check ${path.replace(/([A-Z])/g, ' $1').toLowerCase()} and try again.`
      : 'Please check the form and try again.';
  }

  if (!path || path === 'body') {
    return issue.message;
  }
  // Prefer schema custom messages as-is; only prefix when message is generic.
  if (
    issue.message.startsWith('Required') ||
    issue.message.startsWith('Expected') ||
    issue.message.startsWith('Invalid')
  ) {
    return `${path}: ${issue.message}`;
  }
  return issue.message;
}

export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  transform(value: unknown, _metadata: ArgumentMetadata) {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      const detail = parsed.error.issues.map(formatZodIssue).join('; ');
      throw new BadRequestException({
        error: 'Validation failed',
        message: detail,
      });
    }
    return parsed.data;
  }
}
