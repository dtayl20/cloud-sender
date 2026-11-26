import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Badge, Button, Input, Label } from "./ui";
import type { CheckState, DeliverabilityCheck, DeliverabilityResult } from "../../shared/deliverability";

/**
 * The Deliverability panel: SPF, DKIM, DMARC, MX and From/DKIM alignment for one
 * sending domain, each shown as pass / fail / unknown with a one-line fix.
 *
 * Deliberately compact — this is a look-up-and-go surface, not a report. The
 * whole panel is one card: a status line, one row per check, and a Check again
 * button. Failing rows get their fix line; passing rows stay to a single line.
 *
 * `unknown` is not a euphemism for `fail` here: a lookup we could not make
 * (resolver down, SMTP2GO unreadable) reads as "could not be checked", so a
 * network blip never looks like a broken SPF record.
 */

const STATE_LABEL: Record<CheckState, string> = {
  pass: "pass",
  fail: "fail",
  unknown: "unknown",
};

const STATE_TONE: Record<CheckState, "green" | "red" | "default"> = {
  pass: "green",
  fail: "red",
  unknown: "default",
};

const STATE_TEXT: Record<CheckState, string> = {
  pass: "text-emerald-400",
  fail: "text-red-400",
  unknown: "text-[var(--muted)]",
};

function tally(result: DeliverabilityResult) {
  const count = (s: CheckState) => result.checks.filter((c) => c.state === s).length;
  return `${count("pass")} pass · ${count("fail")} fail · ${count("unknown")} unknown`;
}

/** Short headline for the panel and for the pre-send confirm. */
export function deliverabilityHeadline(result: DeliverabilityResult | null): string {
  if (!result) return "not checked";
  if (result.failures.length) {
    return `${result.failures.length} failed check${result.failures.length === 1 ? "" : "s"}`;
  }
  return result.complete ? "all checks passed" : "no failures, some checks unknown";
}

export function DeliverabilityPanel({
  domain,
  from,
  onResult,
  onDomainChange,
  className = "",
}: {
  /** The sending domain. A blank value disables the checks. */
  domain?: string | null;
  /** The campaign's From address, so alignment can be judged. */
  from?: string | null;
  /** Called whenever a fresh result arrives (or is cleared), for the caller's own use. */
  onResult?: (result: DeliverabilityResult | null) => void;
  /** Supplied only where the panel owns a domain input (Settings). */
  onDomainChange?: (domain: string) => void;
  className?: string;
}) {
  const q = new URLSearchParams();
  if (domain) q.set("domain", domain);
  if (from) q.set("from", from);
  const canCheck = Boolean(domain || from);

  // "Check again" must actually re-ask: the Worker caches DNS answers per
  // isolate for 5 minutes, so a manual click sends fresh=1 to skip that cache.
  // Ordinary loads (mount, navigating back) reuse it, which is what stops the
  // panel hammering the resolver.
  const freshRef = useRef(false);
  const [manual, setManual] = useState(0);

  const { data, error, isFetching } = useQuery<DeliverabilityResult>({
    queryKey: ["deliverability", domain ?? "", from ?? "", manual],
    queryFn: () => {
      const params = new URLSearchParams(q);
      if (freshRef.current) params.set("fresh", "1");
      freshRef.current = false;
      return api(`/api/deliverability?${params.toString()}`);
    },
    enabled: canCheck,
    // DNS changes slowly; the server caches too. Don't re-ask on every mount.
    staleTime: 5 * 60_000,
    retry: false,
  });

  const checkAgain = () => {
    // Bumping `manual` changes the query key, which makes react-query fetch
    // rather than serve its own cached entry; freshRef makes that fetch skip
    // the Worker's DNS cache too.
    freshRef.current = true;
    setManual((n) => n + 1);
  };

  useEffect(() => {
    onResult?.(data ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  return (
    <div className={`rounded border border-[var(--border)] p-3 grid gap-2 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label>Deliverability</Label>
          {data && (
            <Badge tone={data.failures.length ? "red" : data.complete ? "green" : "amber"}>
              {deliverabilityHeadline(data)}
            </Badge>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={checkAgain}
          disabled={!canCheck || isFetching}
        >
          {isFetching ? "Checking…" : "Check again"}
        </Button>
      </div>

      {onDomainChange && (
        <Input
          placeholder="sending domain, e.g. localdentists.au"
          value={domain ?? ""}
          onChange={(e) => onDomainChange(e.target.value)}
        />
      )}

      {!canCheck && (
        <p className="text-xs text-[var(--muted)]">
          Set a sending domain or a From address to check SPF, DKIM, DMARC and MX.
        </p>
      )}

      {canCheck && isFetching && !data && (
        <p className="text-xs text-[var(--muted)]">Looking up DNS and SMTP2GO…</p>
      )}

      {error && (
        <p className="text-xs text-red-400">
          Could not run the checks: {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {data && (
        <>
          <div className="flex items-center justify-between gap-2 text-xs text-[var(--muted)]">
            <span className="font-mono">{data.domain}</span>
            <span>{tally(data)}</span>
          </div>
          {data.ignoredDomain && (
            <p className="text-xs text-amber-400">
              The saved sending domain “{data.ignoredDomain}” is not a domain — it has no dot, so
              nothing could be looked up for it. Checked{" "}
              {data.domainSource === "from_email"
                ? "the From address's domain"
                : "the default From domain"}{" "}
              ({data.domain}) instead.
            </p>
          )}
          <div className="grid gap-1.5">
            {data.checks.map((c) => (
              <CheckRow key={c.id} check={c} />
            ))}
          </div>
          {data.notChecked.length > 0 && (
            <p className="text-xs text-amber-400">
              Not checked: {data.notChecked.join("; ")}.
            </p>
          )}
          <p className="text-xs text-[var(--muted)]">
            Only domain names are looked up — no campaign content leaves this app, and no third-party
            scanner is used. Failures are a warning, not a block.
          </p>
        </>
      )}
    </div>
  );
}

function CheckRow({ check }: { check: DeliverabilityCheck }) {
  return (
    <div className="text-xs">
      <div className="flex items-baseline gap-2">
        <span className={`w-16 shrink-0 uppercase tracking-wide ${STATE_TEXT[check.state]}`}>
          {STATE_LABEL[check.state]}
        </span>
        <span className="w-44 shrink-0 text-white">{check.title}</span>
        <span className="text-[var(--muted)]">{check.summary}</span>
      </div>
      {check.state !== "pass" && check.fix && (
        <div className="pl-[15rem] text-[var(--muted)]">Fix: {check.fix}</div>
      )}
      {check.state === "fail" && check.details.length > 0 && (
        <ul className="pl-[15rem] text-[var(--muted)]">
          {check.details.map((d, i) => (
            <li key={i} className="font-mono break-all">{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
