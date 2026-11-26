import { ReactNode, Ref, ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes, HTMLAttributes } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-8 py-6 border-b border-[var(--border)]">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-[var(--muted)] mt-0.5">{subtitle}</p>}
      </div>
      <div className="flex gap-2">{actions}</div>
    </div>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return <div className="p-8 space-y-6">{children}</div>;
}

export function Card({ children, className = "", ...rest }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={`bg-[var(--card)] border border-[var(--border)] rounded-lg ${className}`}>{children}</div>;
}

export function Button({ variant = "primary", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "outline" }) {
  const v = {
    primary: "bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90",
    ghost: "text-[var(--muted)] hover:text-white hover:bg-[var(--accent)]",
    outline: "border border-[var(--border)] text-white hover:bg-[var(--accent)]",
    danger: "bg-[var(--destructive)] text-white hover:opacity-90",
  }[variant];
  return <button {...p} className={`px-3 py-1.5 text-sm rounded-md font-medium transition ${v} disabled:opacity-50 disabled:cursor-not-allowed ${className}`} />;
}

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={`w-full px-3 py-2 text-sm rounded-md bg-[var(--background)] border border-[var(--border)] focus:outline-none focus:border-[var(--primary)] ${p.className ?? ""}`} />;
}
export function Textarea({ ref, className = "", ...p }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} {...p} className={`w-full px-3 py-2 text-sm rounded-md bg-[var(--background)] border border-[var(--border)] focus:outline-none focus:border-[var(--primary)] font-mono ${className}`} />;
}
export function Select(p: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={`max-w-full px-3 py-2 text-sm rounded-md bg-[var(--background)] border border-[var(--border)] focus:outline-none focus:border-[var(--primary)] ${p.className ?? ""}`} />;
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="block text-xs text-[var(--muted)] mb-1.5 uppercase tracking-wide">{children}</label>;
}

export function Badge({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "green" | "red" | "amber" | "blue" }) {
  const t = {
    default: "bg-[var(--accent)] text-[var(--muted)]",
    green: "bg-emerald-500/10 text-emerald-400",
    red: "bg-red-500/10 text-red-400",
    amber: "bg-amber-500/10 text-amber-400",
    blue: "bg-blue-500/10 text-blue-400",
  }[tone];
  return <span className={`px-2 py-0.5 text-xs rounded ${t}`}>{children}</span>;
}

export function statusTone(s: string): "green" | "red" | "amber" | "blue" | "default" {
  if (["active", "sent", "delivered"].includes(s)) return "green";
  if (["bounced", "failed", "complained"].includes(s)) return "red";
  if (["sending", "scheduled", "queued"].includes(s)) return "blue";
  if (["paused", "draft", "unsubscribed"].includes(s)) return "amber";
  return "default";
}

/** Tone for the email-verification status shown on Contacts (null = never checked). */
export function emailStatusTone(s: string | null | undefined): "green" | "red" | "amber" | "blue" | "default" {
  if (s === "valid") return "green";
  if (s === "invalid") return "red";
  if (s === "risky") return "amber";
  if (s === "pending") return "blue";
  return "default";
}
