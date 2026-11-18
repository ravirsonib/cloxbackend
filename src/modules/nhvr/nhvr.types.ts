import { z } from 'zod';
import { EwdActivityType, FatigueScheme, EwdBreachSeverity } from '@prisma/client';

export const switchActivitySchema = z.object({
  activity: z.nativeEnum(EwdActivityType),
  workType: z.enum(['DRIVING', 'OTHER']).optional(),
  vehicleRego: z.string().trim().min(1).max(20).optional(),
  odometer: z.number().int().nonnegative().optional(),
  location: z.string().trim().max(100).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});
export type SwitchActivityInput = z.infer<typeof switchActivitySchema>;

export const manualRecordSchema = z.object({
  activity: z.nativeEnum(EwdActivityType),
  workType: z.enum(['DRIVING', 'OTHER']).optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  vehicleRego: z.string().trim().max(20).optional(),
  locationStart: z.string().trim().max(100).optional(),
  locationEnd: z.string().trim().max(100).optional(),
  editReason: z.string().trim().min(5).max(255),
});
export type ManualRecordInput = z.infer<typeof manualRecordSchema>;

export const SCHEDULE_A_STATUTORY_DECLARATION =
  'I declare that the records in this Electronic Work Diary are a true and correct record of my work and rest hours under the Heavy Vehicle National Law. I understand that giving false or misleading information is a serious offence under section 701 of the HVNL with heavy penalties.';

export const signDailySheetSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date format must be YYYY-MM-DD'),
  signature: z.string().min(5, 'Signature is required'),
});
export type SignDailySheetInput = z.infer<typeof signDailySheetSchema>;

export const roadsideInspectSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits'),
});
export type RoadsideInspectInput = z.infer<typeof roadsideInspectSchema>;

export interface FatigueStatusResult {
  currentActivity: EwdActivityType;
  currentDurationMinutes: number;
  minutesUntilBreakRequired: number;
  remainingSeconds: number;
  currentDurationSeconds: number;
  minRestMinutes: number;
  workLimitMinutes: number;
  breakRequiredAt?: string | null;
  activityStartedAt?: string | null;
  workMinutesLast24h: number;
  restMinutesLast24h: number;
  continuousRestMinutesLast24h: number;
  potentialBreaches: EwdBreachItem[];
}

export interface EwdBreachItem {
  ruleName: string;
  severity: EwdBreachSeverity;
  description: string;
  actualMinutes: number;
  allowableMinutes: number;
}

