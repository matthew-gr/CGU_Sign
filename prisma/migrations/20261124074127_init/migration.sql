-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL DEFAULT 'SENDER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sessionEpoch" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginCode" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "userId" TEXT,
    "codeHash" TEXT NOT NULL DEFAULT '',
    "linkHash" TEXT NOT NULL DEFAULT '',
    "browserHash" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "ip" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "authAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "absoluteAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AirtableConnection" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "tokenEnc" TEXT NOT NULL DEFAULT '',
    "baseId" TEXT NOT NULL DEFAULT '',
    "baseName" TEXT NOT NULL DEFAULT '',
    "tableId" TEXT NOT NULL DEFAULT '',
    "tableName" TEXT NOT NULL DEFAULT '',
    "searchFields" TEXT NOT NULL DEFAULT '[]',
    "writeBack" BOOLEAN NOT NULL DEFAULT false,
    "writeBackMap" TEXT NOT NULL DEFAULT '{}',
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AirtableConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AirtableWrite" (
    "id" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "fields" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "lastError" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AirtableWrite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "scan" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "signingOrder" TEXT NOT NULL DEFAULT 'SEQUENTIAL',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "TemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateField" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'TEXT',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "help" TEXT NOT NULL DEFAULT '',
    "defaultVal" TEXT NOT NULL DEFAULT '',
    "min" DOUBLE PRECISION,
    "max" DOUBLE PRECISION,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'ASK',
    "airtableId" TEXT NOT NULL DEFAULT '',
    "isSwitch" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TemplateField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateParty" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "signer" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'LEAD',
    "nameField" TEXT NOT NULL DEFAULT '',
    "emailField" TEXT NOT NULL DEFAULT '',
    "companyField" TEXT NOT NULL DEFAULT '',
    "userId" TEXT,

    CONSTRAINT "TemplateParty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agreement" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "templateVersionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "recordId" TEXT NOT NULL DEFAULT '',
    "leadLabel" TEXT NOT NULL DEFAULT '',
    "values" TEXT NOT NULL DEFAULT '{}',
    "switches" TEXT NOT NULL DEFAULT '{}',
    "parties" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "ownerId" TEXT NOT NULL,
    "envelopeId" TEXT,
    "docxKey" TEXT NOT NULL DEFAULT '',
    "docxHash" TEXT NOT NULL DEFAULT '',
    "frozenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgreementCounter" (
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AgreementCounter_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "SignEnvelope" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'UPLOAD',
    "sourceRef" TEXT NOT NULL DEFAULT '',
    "ownerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "signingOrder" TEXT NOT NULL DEFAULT 'PARALLEL',
    "expiresAt" TIMESTAMP(3),
    "message" TEXT NOT NULL DEFAULT '',
    "viewers" TEXT NOT NULL DEFAULT '[]',
    "confidential" BOOLEAN NOT NULL DEFAULT false,
    "fileName" TEXT NOT NULL DEFAULT 'document.pdf',
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "originalHash" TEXT NOT NULL DEFAULT '',
    "finalHash" TEXT NOT NULL DEFAULT '',
    "certified" BOOLEAN NOT NULL DEFAULT false,
    "certNote" TEXT NOT NULL DEFAULT '',
    "completionMethod" TEXT NOT NULL DEFAULT 'ELECTRONIC',
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "lastReminderAt" TIMESTAMP(3),

    CONSTRAINT "SignEnvelope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignSigner" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL DEFAULT '',
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "viewedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "ip" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',
    "typedName" TEXT NOT NULL DEFAULT '',
    "signatureImage" TEXT NOT NULL DEFAULT '',
    "initialsImage" TEXT NOT NULL DEFAULT '',
    "consentText" TEXT NOT NULL DEFAULT '',
    "consentVersion" INTEGER NOT NULL DEFAULT 0,
    "declineReason" TEXT NOT NULL DEFAULT '',
    "linkNonce" TEXT NOT NULL DEFAULT '',
    "sessionNonce" TEXT NOT NULL DEFAULT '',
    "codeHash" TEXT NOT NULL DEFAULT '',
    "codeExpiresAt" TIMESTAMP(3),
    "codeAttempts" INTEGER NOT NULL DEFAULT 0,
    "codeLockedUntil" TIMESTAMP(3),

    CONSTRAINT "SignSigner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignaturePreference" (
    "userId" TEXT NOT NULL,
    "signatureImage" TEXT NOT NULL,
    "initialsImage" TEXT NOT NULL DEFAULT '',
    "method" TEXT NOT NULL DEFAULT 'TYPED',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignaturePreference_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "SignField" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "signerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "label" TEXT NOT NULL DEFAULT '',
    "value" TEXT NOT NULL DEFAULT '',
    "placedBy" TEXT NOT NULL DEFAULT 'DRAG',

    CONSTRAINT "SignField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignFieldTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "signerCount" INTEGER NOT NULL,
    "fields" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignFieldTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignEvent" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "signerId" TEXT,
    "actorId" TEXT,
    "type" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "ip" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',
    "details" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "SignEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignDocVersion" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "signerId" TEXT,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignDocVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthClient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthCode" (
    "hash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT '',
    "resource" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "OAuthCode_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "McpToken" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL DEFAULT '',
    "sessionEpoch" INTEGER NOT NULL DEFAULT 0,
    "family" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'write',
    "status" TEXT NOT NULL DEFAULT '',
    "clientName" TEXT NOT NULL DEFAULT '',
    "input" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "results" INTEGER,
    "ms" INTEGER,
    "ok" BOOLEAN NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "LoginCode_email_createdAt_idx" ON "LoginCode"("email", "createdAt");

-- CreateIndex
CREATE INDEX "LoginCode_ip_createdAt_idx" ON "LoginCode"("ip", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "AirtableWrite_doneAt_nextAt_idx" ON "AirtableWrite"("doneAt", "nextAt");

-- CreateIndex
CREATE INDEX "AirtableWrite_agreementId_idx" ON "AirtableWrite"("agreementId");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateVersion_templateId_version_key" ON "TemplateVersion"("templateId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateField_versionId_tag_key" ON "TemplateField"("versionId", "tag");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateParty_versionId_signer_key" ON "TemplateParty"("versionId", "signer");

-- CreateIndex
CREATE UNIQUE INDEX "Agreement_reference_key" ON "Agreement"("reference");

-- CreateIndex
CREATE INDEX "Agreement_ownerId_status_idx" ON "Agreement"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Agreement_recordId_idx" ON "Agreement"("recordId");

-- CreateIndex
CREATE INDEX "SignEnvelope_ownerId_status_idx" ON "SignEnvelope"("ownerId", "status");

-- CreateIndex
CREATE INDEX "SignEnvelope_finalHash_idx" ON "SignEnvelope"("finalHash");

-- CreateIndex
CREATE INDEX "SignSigner_envelopeId_order_idx" ON "SignSigner"("envelopeId", "order");

-- CreateIndex
CREATE INDEX "SignSigner_email_idx" ON "SignSigner"("email");

-- CreateIndex
CREATE INDEX "SignField_envelopeId_idx" ON "SignField"("envelopeId");

-- CreateIndex
CREATE INDEX "SignEvent_envelopeId_at_idx" ON "SignEvent"("envelopeId", "at");

-- CreateIndex
CREATE INDEX "SignEvent_signerId_type_at_idx" ON "SignEvent"("signerId", "type", "at");

-- CreateIndex
CREATE INDEX "SignDocVersion_sha256_idx" ON "SignDocVersion"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "SignDocVersion_envelopeId_seq_key" ON "SignDocVersion"("envelopeId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "McpToken_hash_key" ON "McpToken"("hash");

-- CreateIndex
CREATE INDEX "McpToken_userId_kind_idx" ON "McpToken"("userId", "kind");

-- CreateIndex
CREATE INDEX "McpToken_family_idx" ON "McpToken"("family");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_hash_key" ON "ApiKey"("hash");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- CreateIndex
CREATE INDEX "McpAudit_userId_at_idx" ON "McpAudit"("userId", "at");

-- CreateIndex
CREATE INDEX "McpAudit_at_idx" ON "McpAudit"("at");

-- AddForeignKey
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
