"use client";

// Adopting a signature and initials: type the name in a signature font, draw them (finger, pen or mouse), or upload a
// photo or scan of a handwritten signature. All become PNG images, adopted once and applied to all the signer's fields.
// Staff can keep what they adopt for their next documents ("Saved" tab); external signers can't (no account to keep it).
import { useEffect, useRef, useState } from "react";
import { forgetMySignature } from "@/lib/sign/actions";
import type { SignatureMethod } from "@/lib/sign/core";

export type Saved = { signature: string; initials: string; method: SignatureMethod };
/** How the signature was adopted, and whether to keep it for next time. */
export type AdoptMeta = { method: SignatureMethod; remember: boolean };

type Tab = "saved" | "type" | "draw" | "upload";
const METHOD: Record<Exclude<Tab, "saved">, SignatureMethod> = { type: "TYPED", draw: "DRAWN", upload: "UPLOADED" };
const TAB_LABEL: Record<Tab, string> = { saved: "My saved signature", type: "Use my typed name", draw: "Draw it", upload: "Upload it" };

const FONT = "GraSignature";
let fontReady: Promise<void> | null = null;
function loadFont() {
  fontReady ??= (async () => {
    const f = new FontFace(FONT, "url(/fonts/DancingScript.ttf)");
    document.fonts.add(await f.load());
  })().catch(() => undefined);
  return fontReady;
}

/** The typed text rendered in the signature font, trimmed, as a PNG data URL. */
async function typed(text: string, px: number) {
  await loadFont();
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  ctx.font = `${px}px ${FONT}, cursive`;
  const w = Math.ceil(ctx.measureText(text).width) + px;
  c.width = Math.max(w, px * 2);
  c.height = Math.ceil(px * 1.6);
  ctx.font = `${px}px ${FONT}, cursive`;
  ctx.fillStyle = "#13215a";
  ctx.textBaseline = "middle";
  ctx.fillText(text, px / 2, c.height / 2);
  return c.toDataURL("image/png");
}

/**
 * An uploaded photo or scan of a signature, cleaned up: light paper becomes transparent, the ink is kept, the image is
 * trimmed to the ink and scaled to at most 600 px wide. Returns a PNG data URL, or null if no ink was found.
 */
async function fromUpload(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, 1200 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const px = data.data;
    let [x0, y0, x1, y1] = [c.width, c.height, -1, -1];
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const light = (px[i] + px[i + 1] + px[i + 2]) / 3;
        // Paper (light) fades out; ink keeps its colour and becomes fully opaque as it darkens.
        const a = px[i + 3] === 0 ? 0 : Math.max(0, Math.min(255, Math.round((200 - light) * 3)));
        px[i + 3] = a;
        if (a > 40) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
    if (x1 < 0) return null;
    ctx.putImageData(data, 0, 0);
    const pad = 6;
    const w = Math.min(c.width, x1 - x0 + pad * 2);
    const h = Math.min(c.height, y1 - y0 + pad * 2);
    const k = Math.min(1, 600 / w);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(w * k));
    out.height = Math.max(1, Math.round(h * k));
    out.getContext("2d")!.drawImage(c, Math.max(0, x0 - pad), Math.max(0, y0 - pad), w, h, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join("")
    .slice(0, 4);

function Pad({ label, onChange, height = 150 }: { label: string; onChange: (png: string | null) => void; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const inked = useRef(false);
  useEffect(() => {
    const c = ref.current!;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    c.width = c.clientWidth * ratio;
    c.height = height * ratio;
    const ctx = c.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#13215a";
  }, [height]);
  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-gra-ink-2">
        <span>{label}</span>
        <button
          type="button"
          className="underline"
          onClick={() => {
            const c = ref.current!;
            c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
            inked.current = false;
            onChange(null);
          }}
        >
          Clear
        </button>
      </div>
      <canvas
        ref={ref}
        aria-label={label}
        className="w-full touch-none rounded-xl border border-dashed border-gra-muted bg-white"
        style={{ height }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          const ctx = e.currentTarget.getContext("2d")!;
          const [x, y] = pos(e);
          ctx.beginPath();
          ctx.moveTo(x, y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = e.currentTarget.getContext("2d")!;
          const [x, y] = pos(e);
          ctx.lineTo(x, y);
          ctx.stroke();
          inked.current = true;
        }}
        onPointerUp={(e) => {
          drawing.current = false;
          if (inked.current) onChange(e.currentTarget.toDataURL("image/png"));
        }}
      />
    </div>
  );
}

export function Adopt({
  name,
  needsInitials,
  onAdopt,
  onCancel,
  saved: initialSaved = null,
  canRemember = false,
  onForget,
  mode = "sign",
}: {
  name: string;
  needsInitials: boolean;
  onAdopt: (sig: string, ini: string, meta: AdoptMeta) => void;
  onCancel: () => void;
  /** Staff: their saved signature, offered first. */
  saved?: Saved | null;
  /** Staff signing as themselves: show "Save for future documents". */
  canRemember?: boolean;
  onForget?: () => void;
  /** "save": create or replace the saved signature from My profile, not for a document. */
  mode?: "sign" | "save";
}) {
  const [saved, setSaved] = useState(initialSaved);
  const [tab, setTab] = useState<Tab>(initialSaved ? "saved" : "type");
  const [remember, setRemember] = useState(true);
  const [forgetting, setForgetting] = useState(false);
  const [forgetError, setForgetError] = useState("");
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [text, setText] = useState(name);
  const [ini, setIni] = useState(initialsOf(name));
  const [preview, setPreview] = useState<{ sig: string; ini: string } | null>(null);
  const [drawn, setDrawn] = useState<{ sig: string | null; ini: string | null }>({ sig: null, ini: null });

  useEffect(() => {
    if (tab === "draw") return;
    let live = true;
    (async () => {
      const [sig, i] = await Promise.all([typed(text.trim() || " ", 64), typed(ini.trim() || " ", 56)]);
      if (live) setPreview({ sig, ini: i });
    })();
    return () => {
      live = false;
    };
  }, [tab, text, ini]);

  // Saved initials if there are any; otherwise the typed ones (as for an upload).
  const savedIni = saved?.initials || preview?.ini || "";
  const ready =
    tab === "saved"
      ? !!saved && (!needsInitials || !!savedIni)
      : tab === "type"
        ? !!preview && text.trim().length > 1 && (!needsInitials || ini.trim().length > 0)
        : tab === "upload"
          ? !!uploaded && (!needsInitials || !!preview)
          : !!drawn.sig && (!needsInitials || !!drawn.ini);
  const tabs: Tab[] = saved ? ["saved", "type", "draw", "upload"] : ["type", "draw", "upload"];

  const adopt = () => {
    if (tab === "saved") return onAdopt(saved!.signature, needsInitials ? savedIni : "", { method: saved!.method, remember: canRemember });
    const meta = { method: METHOD[tab], remember: canRemember && remember };
    if (tab === "type") return onAdopt(preview!.sig, needsInitials ? preview!.ini : "", meta);
    if (tab === "upload") return onAdopt(uploaded!, needsInitials ? preview!.ini : "", meta);
    onAdopt(drawn.sig!, needsInitials ? drawn.ini! : "", meta);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={mode === "save" ? "Your signature" : "Adopt your signature"} className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div className="max-h-[100dvh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl">
        <h2 className="text-lg font-semibold text-gra-deep">{mode === "save" ? "Your signature" : "Adopt your signature"}</h2>
        <div className="flex flex-wrap gap-2 text-sm">
          {tabs.map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={`rounded-full px-3 py-1 ${tab === t ? "bg-gra-deep text-white" : "bg-gra-page text-gra-ink-2"}`}>
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        {tab === "saved" && saved ? (
          <div className="space-y-3">
            <div className="flex items-center gap-4 rounded-xl border border-gra-hair bg-white p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={saved.signature} alt="Your saved signature" className="h-14 max-w-[70%] object-contain" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {needsInitials && savedIni && <img src={savedIni} alt="Your initials" className="h-12 object-contain" />}
            </div>
            {needsInitials && !saved.initials && (
              <div className="space-y-1">
                <p className="text-xs text-gra-ink-2">You haven&apos;t saved initials yet; these are typed from your name.</p>
                <input className="input w-24" value={ini} onChange={(e) => setIni(e.target.value.slice(0, 4))} aria-label="Initials" />
              </div>
            )}
            <button
              type="button"
              className="text-xs text-rose-700 underline disabled:opacity-50"
              disabled={forgetting}
              onClick={async () => {
                setForgetting(true);
                setForgetError("");
                const r = await forgetMySignature();
                setForgetting(false);
                if (r.error) return setForgetError(r.error);
                setSaved(null);
                setTab("type");
                onForget?.();
              }}
            >
              {forgetting ? "Deleting…" : "Delete my saved signature"}
            </button>
            {forgetError && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-900">{forgetError}</p>}
          </div>
        ) : tab === "upload" ? (
          <div className="space-y-3">
            <input
              type="file"
              accept="image/png,image/jpeg"
              aria-label="Signature image"
              className="input py-1.5"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                setUploadError("");
                setUploaded(null);
                if (!f) return;
                if (f.size > 8 * 1024 * 1024) return setUploadError("Use an image under 8 MB.");
                const png = await fromUpload(f).catch(() => null);
                if (!png) return setUploadError("No signature found in that image. Sign on white paper, photograph it in good light, and try again.");
                setUploaded(png);
              }}
            />
            <p className="text-xs text-gra-ink-2">A photo or scan of your signature in dark ink on white paper. The background is removed. {needsInitials ? "Your initials use your typed initials." : ""}</p>
            {uploaded && (
              <div className="rounded-xl border border-gra-hair bg-white p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={uploaded} alt="Uploaded signature" className="h-14 max-w-full object-contain" />
              </div>
            )}
            {uploadError && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-900">{uploadError}</p>}
          </div>
        ) : tab === "type" ? (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-[1fr_6rem]">
              <input className="input" value={text} onChange={(e) => setText(e.target.value)} aria-label="Name for your signature" />
              {needsInitials && <input className="input" value={ini} onChange={(e) => setIni(e.target.value.slice(0, 4))} aria-label="Initials" />}
            </div>
            <div className="flex items-center gap-4 rounded-xl border border-gra-hair bg-white p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {preview && <img src={preview.sig} alt="Signature preview" className="h-14 max-w-[70%] object-contain" />}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {preview && needsInitials && <img src={preview.ini} alt="Initials preview" className="h-12 object-contain" />}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <Pad label="Draw your signature" onChange={(sig) => setDrawn((d) => ({ ...d, sig }))} />
            {needsInitials && <Pad label="Draw your initials" height={90} onChange={(i) => setDrawn((d) => ({ ...d, ini: i }))} />}
          </div>
        )}
        <p className="text-xs text-gra-ink-2">
          {mode === "save"
            ? "Kept encrypted with your account. It's offered when you sign a document, and only used when you choose it there."
            : `This is applied to every signature${needsInitials ? " and initials" : ""} field for you in this document.`}
        </p>
        {canRemember && tab !== "saved" && (
          <label className="flex items-start gap-2 text-sm text-gra-ink">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>
              Save for future documents{saved ? " (replaces your saved signature)" : ""}
              <span className="block text-xs text-gra-ink-2">Kept with your account when you finish signing. Only you can use it, and you choose it each time.</span>
            </span>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!ready} onClick={adopt}>
            {mode === "save" ? "Save signature" : "Adopt and apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
