// Local demo data: wipes the database, then adds an Admin, a Sender and nothing else. Tests reseed before each run.
// Never run against production (it refuses when NODE_ENV=production).
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed in production.");
  const tables = [
    "McpAudit", "ApiKey", "McpToken", "OAuthCode", "OAuthClient", "SignDocVersion", "SignEvent", "SignFieldTemplate", "SignField", "SignaturePreference", "SignSigner", "SignEnvelope",
    "AgreementCounter", "Agreement", "TemplateParty", "TemplateField", "TemplateVersion", "Template", "AirtableWrite", "AirtableConnection", "Setting", "Session", "LoginCode", "User",
  ];
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} CASCADE`);
  await db.user.create({ data: { email: (process.env.SEED_ADMIN_EMAIL || "admin@example.com").toLowerCase(), name: "Alex Admin", title: "CEO", role: "ADMIN" } });
  await db.user.create({ data: { email: "sam@example.com", name: "Sam Sender", title: "Sales", role: "SENDER" } });
  console.log("Seeded: admin@example.com (Admin), sam@example.com (Sender).");
}

main().finally(() => db.$disconnect());
