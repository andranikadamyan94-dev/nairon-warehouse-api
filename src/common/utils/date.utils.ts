import { BadRequestException } from '@nestjs/common';

const YEREVAN_UTC_OFFSET = 4; // UTC+4, no DST
const WORKING_HOUR_START = 9;  // Yerevan local
const WORKING_HOUR_END = 16;   // Yerevan local
export const WORKING_START_UTC = WORKING_HOUR_START - YEREVAN_UTC_OFFSET; // 05:00 UTC
export const WORKING_END_UTC = WORKING_HOUR_END - YEREVAN_UTC_OFFSET;     // 12:00 UTC

export interface DaySlot {
  startDate: Date;    // UTC
  endDate: Date;      // UTC
  yerevanDate: string; // "YYYY-MM-DD" in Yerevan local date
}

function isDateOnly(dateStr: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

function parseYerevanComponents(dateStr: string): {
  year: number;
  month: number; // 0-indexed
  day: number;
  hour: number;
  minute: number;
  hasTime: boolean;
} {
  if (isDateOnly(dateStr)) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return { year, month: month - 1, day, hour: 0, minute: 0, hasTime: false };
  }
  // "2026-05-26T09:00:00" or "2026-05-26T09:00:00.000Z" — treat as Yerevan local
  const stripped = dateStr.replace('Z', '').split('.')[0];
  const [datePart, timePart] = stripped.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  return { year, month: month - 1, day, hour, minute, hasTime: true };
}

function makeUTCSlotStart(y: number, m: number, d: number, hour: number, min: number): Date {
  return new Date(Date.UTC(y, m, d, hour - YEREVAN_UTC_OFFSET, min, 0));
}

/**
 * Split a Yerevan date range into daily working-hour slots for HOUR unit items.
 *
 * - customTime provided → use those Yerevan times for every day.
 * - Single-day with explicit time in the date string → use those Yerevan times.
 * - All other cases → full working hours (09:00–16:00 Yerevan) per day.
 *
 * All returned dates are in UTC.
 */
export function splitIntoWorkingDaySlots(
  startDateStr: string,
  endDateStr: string,
  customTime?: { startHour: number; startMinute: number; endHour: number; endMinute: number },
): DaySlot[] {
  const start = parseYerevanComponents(startDateStr);
  const end = parseYerevanComponents(endDateStr);

  const startDayUTC = new Date(Date.UTC(start.year, start.month, start.day));
  const endDayUTC = new Date(Date.UTC(end.year, end.month, end.day));

  const isSingleDay = startDayUTC.getTime() === endDayUTC.getTime();

  // Validate explicit times on single-day bookings
  if (isSingleDay) {
    if (start.hasTime) {
      if (start.hour < WORKING_HOUR_START || start.hour >= WORKING_HOUR_END) {
        throw new BadRequestException(
          `Start time must be between ${WORKING_HOUR_START}:00 and ${WORKING_HOUR_END}:00 Yerevan time`,
        );
      }
    }
    if (end.hasTime) {
      if (end.hour > WORKING_HOUR_END || (end.hour === WORKING_HOUR_END && end.minute > 0)) {
        throw new BadRequestException(
          `End time cannot exceed ${WORKING_HOUR_END}:00 Yerevan time`,
        );
      }
    }
    if (start.hasTime && end.hasTime) {
      const startMin = start.hour * 60 + start.minute;
      const endMin = end.hour * 60 + end.minute;
      if (startMin >= endMin) {
        throw new BadRequestException('Start time must be before end time');
      }
    }
  }

  const slots: DaySlot[] = [];
  let current = new Date(startDayUTC);

  while (current <= endDayUTC) {
    const y = current.getUTCFullYear();
    const m = current.getUTCMonth();
    const d = current.getUTCDate();

    const isFirst = current.getTime() === startDayUTC.getTime();
    const isLast = current.getTime() === endDayUTC.getTime();

    // Priority: customTime > single-day explicit time > default working hours
    const useExplicitStart = !customTime && isSingleDay && start.hasTime;
    const useExplicitEnd = !customTime && isSingleDay && end.hasTime;

    const slotStart = customTime
      ? makeUTCSlotStart(y, m, d, customTime.startHour, customTime.startMinute)
      : useExplicitStart
        ? makeUTCSlotStart(y, m, d, start.hour, start.minute)
        : new Date(Date.UTC(y, m, d, WORKING_START_UTC, 0, 0));

    const slotEnd = customTime
      ? makeUTCSlotStart(y, m, d, customTime.endHour, customTime.endMinute)
      : useExplicitEnd
        ? makeUTCSlotStart(y, m, d, end.hour, end.minute)
        : new Date(Date.UTC(y, m, d, WORKING_END_UTC, 0, 0));

    const yerevanDate = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    slots.push({ startDate: slotStart, endDate: slotEnd, yerevanDate });

    // Advance to next day
    current = new Date(Date.UTC(y, m, d + 1));

    // suppress unused warning for isFirst/isLast (kept for future first/last day partial logic)
    void isFirst;
    void isLast;
  }

  return slots;
}

/**
 * Recover the Yerevan calendar date (YYYY-MM-DD) from a UTC Date.
 * Used to match existing reservation rows to new day slots.
 */
export function getYerevanDateKey(utcDate: Date): string {
  const yerevanMs = utcDate.getTime() + YEREVAN_UTC_OFFSET * 60 * 60 * 1000;
  const d = new Date(yerevanMs);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const dy = d.getUTCDate();
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
}
