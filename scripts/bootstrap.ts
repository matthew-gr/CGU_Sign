// Runs at every hosted start (after migrations). On an empty database it creates the first Admin from
// BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_NAME, so someone can sign in. Safe to run repeatedly.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!email) return console.log("[bootstrap] BOOTSTRAP_ADMIN_EMAIL not set; skipping.");
  if (await db.user.count()) return console.log("[bootstrap] users exist; nothing to do.");
  await db.user.create({ data: { email, name: process.env.BOOTSTRAP_ADMIN_NAME || email.split("@")[0], role: "ADMIN" } });
  console.log(`[bootstrap] created the first Admin: ${email}`);
}

main()
  .catch((e) => {
    console.error("[bootstrap] failed", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
