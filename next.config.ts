import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "pdf-lib", "mammoth", "unpdf", "@signpdf/signpdf", "@signpdf/signer-p12", "@signpdf/placeholder-pdf-lib", "node-forge"],
  // Employee File uploads (resumes, documents), SOP PDFs (up to 20 MB) and Sign PDFs (up to 25 MB) go through server actions.
  experimental: { serverActions: { bodySizeLimit: "27mb" } },
};

export default nextConfig;
