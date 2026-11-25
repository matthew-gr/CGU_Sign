import { db } from "./db";

export const DAY_MS = 86_400_000;

/** Simulated "now": real time plus the demo offset set by Advance time. */
export async function now(): Promise<Date> {
  const row = await db.setting.findUnique({ where: { key: "clockOffsetDays" } });
  const offset = row ? Number(JSON.parse(row.value)) : 0;
  return new Date(Date.now() + offset * DAY_MS);
}

export async function getOffsetDays(): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: "clockOffsetDays" } });
  return row ? Number(JSON.parse(row.value)) : 0;
}

export async function addDays(days: number) {
  const offset = (await getOffsetDays()) + days;
  await db.setting.upsert({
    where: { key: "clockOffsetDays" },
    update: { value: String(offset) },
    create: { key: "clockOffsetDays", value: String(offset) },
  });
}

export const plusDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);
