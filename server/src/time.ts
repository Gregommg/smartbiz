import { z } from 'zod'
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const todayEAT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })
/** SQL condition: column falls on or between two calendar dates (parameters $a and $b) in Nairobi time. */
export const win = (col: string, a: number, b: number) =>
  `(${col} >= ($${a}::date)::timestamp AT TIME ZONE 'Africa/Nairobi' AND ${col} < (($${b}::date + 1)::timestamp AT TIME ZONE 'Africa/Nairobi'))`
