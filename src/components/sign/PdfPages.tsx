"use client";

// Renders a PDF's pages to canvases (pdfjs-dist, worker served from /api/sign/pdf-worker) at the container's width,
// with an overlay per page for fields. Field geometry is in fractions of the page, so overlays scale with it.
import { useEffect, useRef, useState, type ReactNode } from "react";

export type PageSize = { width: number; height: number }; // points

type Props = {
  url: string;
  overlay?: (page: number, css: { width: number; height: number }) => ReactNode;
  onPages?: (sizes: PageSize[]) => void;
  onLastPageSeen?: () => void;
  /** Called with a page wrapper's element, to scroll to fields. */
  pageRef?: (page: number, el: HTMLDivElement | null) => void;
};

export function PdfPages({ url, overlay, onPages, onLastPageSeen, pageRef }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [error, setError] = useState("");
  const docRef = useRef<{ getPage(n: number): Promise<unknown>; numPages: number } | null>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const last = useRef<HTMLDivElement | null>(null);

  // Container width (re-render pages when it changes noticeably).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth((w) => (Math.abs(w - e.contentRect.width) > 8 ? Math.floor(e.contentRect.width) : w)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Load the document.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/api/sign/pdf-worker";
        const doc = await pdfjs.getDocument({ url, withCredentials: true }).promise;
        if (cancelled) return;
        docRef.current = doc as never;
        const out: PageSize[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const p = await doc.getPage(n);
          const [x0, y0, x1, y1] = p.view;
          out.push({ width: x1 - x0, height: y1 - y0 });
        }
        if (!cancelled) {
          setSizes(out);
          onPages?.(out);
        }
      } catch {
        if (!cancelled) setError("The document couldn't be loaded. Refresh the page; if it keeps happening, open the link from your email again.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Draw pages at the current width.
  useEffect(() => {
    const doc = docRef.current;
    if (!doc || !width || !sizes.length) return;
    let cancelled = false;
    (async () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      for (let n = 1; n <= sizes.length && !cancelled; n++) {
        const page = (await doc.getPage(n)) as { getViewport(o: { scale: number }): { width: number; height: number }; render(o: unknown): { promise: Promise<void> } };
        const scale = (width / sizes[n - 1].width) * ratio;
        const vp = page.getViewport({ scale });
        const c = canvases.current[n - 1];
        if (!c) continue;
        c.width = Math.floor(vp.width);
        c.height = Math.floor(vp.height);
        await page.render({ canvasContext: c.getContext("2d"), viewport: vp, canvas: c }).promise.catch(() => undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [width, sizes]);

  // Reaching the last page.
  useEffect(() => {
    if (!onLastPageSeen || !last.current) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && onLastPageSeen(), { threshold: 0.35 });
    io.observe(last.current);
    return () => io.disconnect();
  }, [sizes, onLastPageSeen]);

  return (
    <div ref={box} className="w-full">
      {error && <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-900">{error}</p>}
      {!sizes.length && !error && <p className="py-10 text-center text-sm text-gra-muted">Loading the document…</p>}
      <div className="space-y-4">
        {sizes.map((s, i) => {
          const css = { width, height: width ? Math.round((width * s.height) / s.width) : 0 };
          return (
            <div
              key={i}
              ref={(el) => {
                if (i === sizes.length - 1) last.current = el;
                pageRef?.(i + 1, el);
              }}
              data-page={i + 1}
              className="relative overflow-hidden rounded-md bg-white shadow-[0_1px_3px_rgba(0,0,0,.15)]"
              style={{ width: css.width || "100%", height: css.height || 400 }}
            >
              <canvas ref={(el) => void (canvases.current[i] = el)} className="absolute inset-0 h-full w-full" />
              {width > 0 && overlay?.(i + 1, css)}
              <span className="pointer-events-none absolute right-2 bottom-1 text-[10px] text-gra-muted">
                Page {i + 1} of {sizes.length}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const SIGNER_COLORS = ["#39ade3", "#17a34a", "#e09b00", "#e5484d", "#8e4ec6", "#0d9488", "#f97316", "#64748b", "#db2777", "#2563eb"];
