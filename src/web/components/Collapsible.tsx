import { ReactNode, useState } from "react";

/**
 * A collapsible builder section.
 *
 * The header stays put and clickable — a chevron, the title, and (while closed)
 * a one-line summary of the state — and the body collapses away. Open/closed is
 * remembered per section in localStorage, so a builder the operator has trimmed
 * stays trimmed across reloads.
 *
 * The body stays MOUNTED while collapsed (hidden with CSS, not unmounted): the
 * deliverability panel fetches when it mounts and the pre-send warning reads its
 * last answer, so unmounting it would silently drop those checks.
 */
const STORAGE_PREFIX = "campaign.section.";

function readOpen(id: string): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(STORAGE_PREFIX + id);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {
    /* private mode / storage disabled — fall back to the default */
  }
  return null;
}

function writeOpen(id: string, open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + id, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function CollapsibleSection({
  id,
  title,
  summary,
  defaultOpen = true,
  actions,
  children,
  className = "",
}: {
  /** Stable key for the remembered state (localStorage). */
  id: string;
  /** Header title; may carry a small hint chip. */
  title: ReactNode;
  /** One-line state shown while collapsed. */
  summary?: ReactNode;
  /** Open on first visit; later visits use the remembered state. */
  defaultOpen?: boolean;
  /** Header controls that must stay reachable while collapsed (e.g. Check spam). */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState<boolean>(() => readOpen(id) ?? defaultOpen);
  const toggle = () =>
    setOpen((prev) => {
      const next = !prev;
      writeOpen(id, next);
      return next;
    });

  return (
    <section className={`rounded border border-[var(--border)] ${className}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Chevron open={open} />
          <span className="text-xs uppercase tracking-wide text-[var(--muted)]">{title}</span>
          {!open && summary !== undefined && summary !== null && summary !== "" && (
            <span className="truncate text-xs text-white">{summary}</span>
          )}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className={open ? "grid grid-cols-1 gap-2 border-t border-[var(--border)] p-3" : "hidden"}>
        {children}
      </div>
    </section>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-3.5 w-3.5 shrink-0 text-[var(--muted)] transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
