"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent, type MouseEvent, type ReactNode } from "react";
import type { Result } from "@/lib/result";
import { callAction } from "@/lib/call-action";

/** A form bound to a server action that shows the action's error or success message inline. */
export function ActionForm({
  action,
  children,
  submitLabel,
  submitClass = "btn-primary",
  className = "",
  redirectTo,
  confirm,
  inline = false,
  keepValues = false,
  onResult,
}: {
  action: (fd: FormData) => Promise<Result>;
  children?: ReactNode;
  submitLabel?: string;
  submitClass?: string;
  className?: string;
  redirectTo?: string;
  confirm?: string;
  inline?: boolean;
  /** Don't clear the inputs after submitting (React resets action forms; edit forms want to keep what's shown). */
  keepValues?: boolean;
  /** Receive the result instead of showing it here (for forms that remount after saving). */
  onResult?: (r: Result) => void;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const submit = (fd: FormData) => {
    if (confirm && !window.confirm(confirm)) return;
    start(async () => {
      const r = await callAction(() => action(fd));
      if (onResult) onResult(r);
      else setResult(r);
      if (r.ok) {
        if (r.href ?? redirectTo) router.push((r.href ?? redirectTo)!);
        router.refresh();
      }
    });
  };
  // Upload forms: submitting with a required file not chosen yet opens the file picker (instead of the browser's
  // "Please select a file"), and choosing a file submits the form.
  const pickMissingFile = (e: MouseEvent<HTMLButtonElement>) => {
    const form = e.currentTarget.form;
    const empty = form && [...form.querySelectorAll<HTMLInputElement>('input[type="file"][required]')].find((i) => !i.disabled && !i.files?.length);
    if (!empty) return;
    e.preventDefault();
    empty.addEventListener("change", () => empty.files?.length && form.requestSubmit(), { once: true });
    empty.click();
  };
  return (
    <form
      className={className}
      {...(keepValues
        ? {
            onSubmit: (e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              submit(new FormData(e.currentTarget));
            },
          }
        : { action: submit })}
    >
      <div className={inline ? "flex flex-wrap items-end gap-2" : "space-y-3"}>
        {children}
        {submitLabel && (
          <button type="submit" className={submitClass} disabled={pending} onClick={pickMissingFile}>
            {pending ? "Working…" : submitLabel}
          </button>
        )}
      </div>
      {result?.error && <p className="mt-2 text-sm text-rose-700">{result.error}</p>}
      {result?.ok && result.message && <p className="mt-2 text-sm text-emerald-700">{result.message}</p>}
    </form>
  );
}
