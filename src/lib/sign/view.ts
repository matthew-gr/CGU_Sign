// What a signing page needs about one signer (server-only helper for the signer pages).
import { db } from "../db";
import { now } from "../clock";
import { appSettings, currentConsent } from "../settings";
import { dateShort } from "../tz";
import { savedSignature } from "./core";

type FieldKind = "SIGNATURE" | "INITIALS" | "DATE_SIGNED" | "NAME" | "TITLE" | "TEXT" | "CHECKBOX";

export async function roomData(signerId: string) {
  const signer = await db.signSigner.findUniqueOrThrow({ where: { id: signerId } });
  const env = await db.signEnvelope.findUniqueOrThrow({ where: { id: signer.envelopeId } });
  const owner = await db.user.findUnique({ where: { id: env.ownerId }, select: { name: true } });
  const fields = await db.signField.findMany({ where: { signerId }, orderBy: [{ page: "asc" }, { y: "asc" }, { id: "asc" }] });
  const s = await appSettings();
  return {
    signer,
    env,
    from: owner ? `${owner.name}, ${s.companyName}` : s.companyName,
    consentText: currentConsent(s).text,
    today: dateShort(await now(), s.timeZone),
    // Users signing as themselves are offered their saved signature (applied only by a click).
    saved: signer.userId ? await savedSignature(signer.userId) : null,
    fields: fields.map((f) => ({ id: f.id, type: f.type as FieldKind, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, required: f.required, label: f.label })),
  };
}
