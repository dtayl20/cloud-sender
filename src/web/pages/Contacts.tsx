import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Page, PageHeader, Card, Input, Select, Badge, statusTone, emailStatusTone, Button } from "../components/ui";
import { Link } from "react-router-dom";

/** "3d ago" / "just now" - the relative half of the last-verified cell. */
function relativeTime(ts: number | null | undefined): string {
  if (!ts) return "never";
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 0) return "just now";
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** The absolute half: "5 Oct 2026, 2:22 pm". */
function absoluteTime(ts: number | null | undefined): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type VerifyScope = "pending" | "stale" | "filter" | "selected";

type ColumnDef = { key: string; label: string };

// Fixed columns. "name" is a composite so the default table keeps the single
// Name column it has always shown; import columns are added as attr.<key>.
const BUILTIN_COLUMNS: ColumnDef[] = [
  { key: "email", label: "Email" },
  { key: "name", label: "Name" },
  { key: "practice_name", label: "Practice" },
  { key: "tags", label: "Tags" },
  { key: "status", label: "Status" },
  { key: "verification", label: "Verification" },
  { key: "last_verified", label: "Last verified" },
  { key: "source", label: "Source" },
  { key: "source_table", label: "Source table" },
  { key: "updated_at", label: "Updated" },
];
const DEFAULT_COLUMNS = ["email", "name", "practice_name", "tags", "status", "verification", "last_verified", "source"];
const COLUMNS_KEY = "emailer.contacts.columns";

function loadColumns(): string[] {
  if (typeof window === "undefined") return DEFAULT_COLUMNS;
  try {
    const raw = window.localStorage.getItem(COLUMNS_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr) && arr.length && arr.every((k) => typeof k === "string")) return arr;
  } catch {}
  return DEFAULT_COLUMNS;
}

function columnLabel(key: string): string {
  const builtin = BUILTIN_COLUMNS.find((c) => c.key === key);
  if (builtin) return builtin.label;
  return key.startsWith("attr.") ? key.slice("attr.".length) : key;
}

function formatDay(unix: unknown): string {
  const n = Number(unix);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n * 1000).toLocaleDateString();
}

/** 1 / 0 / true / false in any spelling, or null when the value says nothing. */
function flag(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes"].includes(s)) return true;
  if (["0", "false", "no"].includes(s)) return false;
  return null;
}

export default function Contacts() {
  const [sp, setSp] = useSearchParams();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [emailStatus, setEmailStatus] = useState("");
  const [sort, setSort] = useState("");
  const [listFilter, setListFilter] = useState(sp.get("list") ?? "");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number[]>([]);
  const [columns, setColumns] = useState<string[]>(loadColumns);
  const [showColumns, setShowColumns] = useState(false);

  useEffect(() => {
    try { window.localStorage.setItem(COLUMNS_KEY, JSON.stringify(columns)); } catch {}
  }, [columns]);

  const [verifyScope, setVerifyScope] = useState<VerifyScope>("pending");
  const [verifyPreview, setVerifyPreview] = useState<any>(null);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);

  const params = new URLSearchParams({ q, status, page: String(page), pageSize: "50" });
  if (emailStatus) params.set("email_status", emailStatus);
  if (sort) params.set("sort", sort);
  if (listFilter) params.set("list", listFilter);
  for (const t of tagFilter) params.append("tag", t);

  // The bulk-verify "current filter" scope uses the same params, minus paging.
  const filterParams = new URLSearchParams();
  if (q) filterParams.set("q", q);
  if (status) filterParams.set("status", status);
  if (emailStatus) filterParams.set("email_status", emailStatus);
  if (listFilter) filterParams.set("list", listFilter);
  for (const t of tagFilter) filterParams.append("tag", t);

  const { data, isLoading } = useQuery({
    queryKey: ["contacts", q, status, emailStatus, sort, listFilter, tagFilter, page],
    queryFn: () => api(`/api/contacts?${params}`),
  });
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => api("/api/tags") });
  const lists = useQuery({ queryKey: ["lists"], queryFn: () => api("/api/lists") });
  const stats = useQuery({ queryKey: ["contact-stats"], queryFn: () => api("/api/contacts/stats") });
  // Import fields offered as columns follow the selected list, so the picker
  // does not list every column ever imported from every list.
  const fields = useQuery({
    queryKey: ["contact-fields", listFilter ? `list_id=${listFilter}` : ""],
    queryFn: () => api(`/api/contacts/fields${listFilter ? `?list_id=${encodeURIComponent(listFilter)}` : ""}`),
  });

  const attrKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const a of fields.data?.attributes ?? []) keys.add(String(a.label));
    for (const r of data?.rows ?? []) for (const k of Object.keys(r.attributes ?? {})) keys.add(k);
    return [...keys].sort((a, b) => a.localeCompare(b));
  }, [fields.data, data]);

  const toggleColumn = (key: string) =>
    setColumns((current) => {
      const has = current.includes(key);
      // Never leave the table with no columns at all.
      if (has && current.length === 1) return current;
      return has ? current.filter((k) => k !== key) : [...current, key];
    });

  const staleDays: number = stats.data?.stale_days ?? 180;
  const staleCutoff = Math.floor(Date.now() / 1000) - staleDays * 86400;

  const rows: any[] = data?.rows ?? [];
  const pageIds = rows.map((r) => r.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));

  const toggleTag = (name: string) => {
    setPage(1);
    setTagFilter((t) => (t.includes(name) ? t.filter((x) => x !== name) : [...t, name]));
  };

  const toggleRow = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const toggleAllPage = () =>
    setSelected((s) =>
      allPageSelected ? s.filter((id) => !pageIds.includes(id)) : [...new Set([...s, ...pageIds])],
    );

  const isStale = (r: any) =>
    r.email_status === "valid" && r.email_verified_at != null && r.email_verified_at < staleCutoff;

  /** One cell for any configured column, including attr.* import fields. */
  const renderCell = (r: any, key: string) => {
    switch (key) {
      case "email":
        return <span className="font-mono">{r.email}</span>;
      case "name":
        return <>{[r.first_name, r.last_name].filter(Boolean).join(" ") || "—"}</>;
      case "practice_name":
        return <>{r.practice_name || "—"}</>;
      case "tags":
        return (
          <div className="flex flex-wrap gap-1">
            {(r.tags ?? []).map((t: string) => (
              <span key={t} className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--accent)] text-[var(--muted)]">{t}</span>
            ))}
          </div>
        );
      case "status":
        return <Badge tone={statusTone(r.status)}>{r.status}</Badge>;
      case "verification":
        return (
          <div className="flex items-center gap-1">
            {r.email_status
              ? <Badge tone={emailStatusTone(r.email_status)}>{r.email_status}</Badge>
              : <span className="text-[var(--muted)]">—</span>}
            {isStale(r) && <Badge tone="amber">stale</Badge>}
            {Number(r.email_verify_queued) === 1 && <Badge tone="blue">queued</Badge>}
          </div>
        );
      case "last_verified":
        return (
          <span className="text-[var(--muted)]" title={absoluteTime(r.email_verified_at)}>
            {r.email_verified_at ? relativeTime(r.email_verified_at) : "never"}
          </span>
        );
      case "source":
      case "source_table":
        return <span className="text-[var(--muted)]">{r[key] || "—"}</span>;
      case "updated_at":
        return <span className="text-[var(--muted)]">{formatDay(r.updated_at)}</span>;
    }
    if (key.startsWith("attr.")) {
      const name = key.slice("attr.".length);
      const value = r.attributes?.[name];
      if (value === null || value === undefined || value === "") return <span className="text-[var(--muted)]">—</span>;
      const asFlag = flag(value);
      if (asFlag !== null && (name.startsWith("is_") || name.startsWith("has_"))) {
        return <Badge tone={asFlag ? "green" : "default"}>{asFlag ? "yes" : "no"}</Badge>;
      }
      if (typeof value === "object") return <span className="font-mono text-xs">{JSON.stringify(value)}</span>;
      return <span className="break-words">{String(value)}</span>;
    }
    return <>—</>;
  };

  const statusCounts: Record<string, number> = Object.fromEntries(
    (stats.data?.verification ?? []).map((v: any) => [
      v.email_status,
      Number(v.n),
    ]),
  );
  const pendingCount = (statusCounts.pending ?? 0) + (statusCounts.none ?? 0);
  const validCount = statusCounts.valid ?? 0;
  const invalidCount = statusCounts.invalid ?? 0;
  const staleCount: number = stats.data?.stale ?? 0;
  const queuedCount: number = stats.data?.queued ?? 0;
  const creditsRemaining: number | null = stats.data?.credits_remaining ?? null;

  async function runVerify(dryRun: boolean) {
    setVerifyBusy(true);
    setVerifyMsg(null);
    try {
      const scope = verifyScope === "selected" ? "ids" : verifyScope;
      const body: any = { scope, dry_run: dryRun };
      if (scope === "ids") body.ids = selected;
      if (scope === "filter") body.filter_query = filterParams.toString();
      const res = await api("/api/contacts/verify", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (dryRun) {
        setVerifyPreview(res);
      } else {
        setVerifyPreview(res);
        setVerifyMsg(
          `Queued ${Number(res.queued).toLocaleString()} address${res.queued === 1 ? "" : "es"} for verification. The 25/min pass will check them; ${res.eligible === 0 ? "nothing else was eligible." : `${Number(res.eligible).toLocaleString()} were eligible.`}`,
        );
        setSelected([]);
        qc.invalidateQueries({ queryKey: ["contacts"] });
        qc.invalidateQueries({ queryKey: ["contact-stats"] });
      }
    } catch (e: any) {
      setVerifyMsg(String(e?.message ?? e));
    } finally {
      setVerifyBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Contacts"
        subtitle={data?.total != null ? `${Number(data.total).toLocaleString()} total` : ""}
        actions={
          <div className="flex gap-2">
            <Link to="/lists"><Button variant="outline">Lists & tags</Button></Link>
            <Link to="/imports"><Button>Import</Button></Link>
          </div>
        }
      />
      <Page>
        <div className="flex flex-wrap gap-2">
          <Input placeholder="Search email, name, practice…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="unsubscribed">Unsubscribed</option>
            <option value="bounced">Bounced</option>
            <option value="complained">Complained</option>
            <option value="disabled">Disabled</option>
          </Select>
          <Select value={emailStatus} onChange={(e) => { setEmailStatus(e.target.value); setPage(1); }}>
            <option value="">All verification</option>
            <option value="pending">Verification: pending</option>
            <option value="valid">Verification: valid</option>
            <option value="risky">Verification: risky</option>
            <option value="invalid">Verification: invalid</option>
            <option value="unknown">Verification: unknown</option>
            <option value="stale">Verification: stale (needs re-check)</option>
            <option value="queued">Verification: queued</option>
            <option value="none">Verification: never checked</option>
          </Select>
          <Select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}>
            <option value="">Sort: newest added</option>
            <option value="verified_desc">Sort: last verified (newest)</option>
            <option value="verified_asc">Sort: last verified (oldest)</option>
          </Select>
          <Select value={listFilter} onChange={(e) => { setListFilter(e.target.value); setPage(1); setSp(e.target.value ? { list: e.target.value } : {}); }}>
            <option value="">All lists</option>
            {(lists.data?.rows ?? []).map((l: any) => (
              <option key={l.id} value={l.id}>{l.name}{l.kind === "segment" ? " (segment)" : ""}</option>
            ))}
          </Select>
          <Button variant="outline" className="ml-auto" onClick={() => setShowColumns((v) => !v)}>
            Columns · {columns.length}
          </Button>
        </div>

        {showColumns && (
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-medium">Visible columns</div>
              <Button variant="ghost" onClick={() => setColumns(DEFAULT_COLUMNS)}>Reset to default</Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-[var(--muted)] mb-1.5">Contact</div>
                <div className="space-y-1">
                  {BUILTIN_COLUMNS.map((c) => (
                    <label key={c.key} className="flex items-center gap-2 text-xs">
                      <input type="checkbox" checked={columns.includes(c.key)} onChange={() => toggleColumn(c.key)} />
                      {c.label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="md:col-span-3">
                <div className="text-xs uppercase tracking-wide text-[var(--muted)] mb-1.5">
                  Import fields{listFilter ? ` — ${lists.data?.rows?.find((l: any) => String(l.id) === listFilter)?.name ?? "selected list"}` : ""}
                </div>
                {attrKeys.length ? (
                  <div className="flex flex-wrap gap-x-5 gap-y-1.5 max-h-44 overflow-auto">
                    {attrKeys.map((k) => (
                      <label key={k} className="flex items-center gap-2 text-xs">
                        <input type="checkbox" checked={columns.includes(`attr.${k}`)} onChange={() => toggleColumn(`attr.${k}`)} />
                        <span className="font-mono">{k}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-[var(--muted)]">
                    No import fields found{listFilter ? " for this list" : ""} yet.
                  </div>
                )}
              </div>
            </div>
          </Card>
        )}

        <Card className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <span className="font-medium text-white">Verification</span>
            <Badge tone="blue">pending: {Number(pendingCount).toLocaleString()}</Badge>
            <Badge tone="green">valid: {Number(validCount).toLocaleString()}</Badge>
            <Badge tone="red">invalid: {Number(invalidCount).toLocaleString()}</Badge>
            <Badge tone="amber">stale: {Number(staleCount).toLocaleString()}</Badge>
            {queuedCount > 0 && <Badge tone="blue">queued: {Number(queuedCount).toLocaleString()}</Badge>}
            {(statusCounts.risky ?? 0) > 0 && <Badge tone="amber">risky: {Number(statusCounts.risky).toLocaleString()}</Badge>}
            {(statusCounts.unknown ?? 0) > 0 && <Badge>unknown: {Number(statusCounts.unknown).toLocaleString()}</Badge>}
            <span className="ml-auto">
              re-check after {staleDays} days
              {creditsRemaining != null ? ` · ${creditsRemaining.toLocaleString()} credits left` : ""}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">Queue verification for</span>
            <Select value={verifyScope} onChange={(e) => { setVerifyScope(e.target.value as VerifyScope); setVerifyPreview(null); setVerifyMsg(null); }} className="w-auto">
              <option value="pending">all pending / never-checked ({Number(pendingCount).toLocaleString()})</option>
              <option value="stale">all stale ({Number(staleCount).toLocaleString()})</option>
              <option value="filter">all matching the current filter</option>
              <option value="selected">the selection ({selected.length.toLocaleString()})</option>
            </Select>
            <Button
              variant="outline"
              disabled={verifyBusy || (verifyScope === "selected" && selected.length === 0)}
              onClick={() => runVerify(true)}
            >
              Preview
            </Button>
            <Button
              disabled={verifyBusy || !verifyPreview || (verifyScope === "selected" && selected.length === 0)}
              onClick={() => runVerify(false)}
            >
              Queue
            </Button>
          </div>

          {verifyPreview && (
            <div className="text-xs rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 px-3 py-2">
              {verifyPreview.eligible > 0
                ? <>Will queue <b>{Number(verifyPreview.eligible).toLocaleString()}</b> address{verifyPreview.eligible === 1 ? "" : "es"} for re-check. Each check costs 1 credit{creditsRemaining != null ? <> (~{creditsRemaining.toLocaleString()} left)</> : ""}. Nothing is sent to the provider now — the 25/min cron pass does the work.</>
                : <>Nothing eligible to queue.</>}
              {verifyPreview.skipped > 0 && <> {Number(verifyPreview.skipped).toLocaleString()} fresh/valid address{verifyPreview.skipped === 1 ? " was" : "es were"} skipped (still fresh).</>}
              {verifyPreview.already_queued > 0 && <> {Number(verifyPreview.already_queued).toLocaleString()} already queued.</>}
              {verifyPreview.warnings?.length ? <> {verifyPreview.warnings.join(" · ")}</> : null}
            </div>
          )}
          {verifyMsg && <div className="text-xs text-[var(--muted)]">{verifyMsg}</div>}
        </Card>

        {!!(data?.warnings?.length) && (
          <div className="text-xs px-3 py-2 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200">
            {data.warnings.join(" · ")}
          </div>
        )}
        {!!tags.data?.rows?.length && (
          <div className="flex flex-wrap gap-2">
            <span className="text-xs text-[var(--muted)] py-1">Filter by tag:</span>
            {tags.data.rows.map((t: any) => (
              <button
                key={t.id}
                onClick={() => toggleTag(t.name)}
                className={`px-2 py-1 text-xs rounded border ${tagFilter.includes(t.name) ? "bg-[var(--primary)] border-[var(--primary)]" : "border-[var(--border)] text-[var(--muted)]"}`}
              >{t.name}</button>
            ))}
            {tagFilter.length > 0 && (
              <button onClick={() => setTagFilter([])} className="text-xs text-[var(--muted)] underline">clear</button>
            )}
          </div>
        )}
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-[var(--muted)] border-b border-[var(--border)]">
                <tr>
                  <th className="px-3 py-3 w-8">
                    <input type="checkbox" checked={allPageSelected} onChange={toggleAllPage} aria-label="Select page" />
                  </th>
                  {columns.map((key) => (
                    <th key={key} className="px-3 py-3 whitespace-nowrap">{columnLabel(key)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr><td colSpan={columns.length + 1} className="px-5 py-10 text-center text-[var(--muted)]">Loading…</td></tr>
                )}
                {rows.map((r: any) => (
                  <tr key={r.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--accent)]/30">
                    <td className="px-3 py-3">
                      <input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggleRow(r.id)} aria-label={`Select ${r.email}`} />
                    </td>
                    {columns.map((key) => (
                      <td key={key} className="px-3 py-3 align-top">
                        {renderCell(r, key)}
                      </td>
                    ))}
                  </tr>
                ))}
                {data && !rows.length && (
                  <tr><td colSpan={columns.length + 1} className="px-5 py-10 text-center text-[var(--muted)]">No contacts match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
        <div className="flex justify-between items-center text-sm">
          <div className="text-[var(--muted)]">
            Page {page}
            {selected.length > 0 && <> · {selected.length} selected</>}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Prev</Button>
            <Button variant="outline" disabled={!data || (rows.length ?? 0) < 50} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      </Page>
    </>
  );
}
