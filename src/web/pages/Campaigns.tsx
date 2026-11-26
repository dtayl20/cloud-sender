import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { Page, PageHeader, Card, Button, Input, Badge, statusTone } from "../components/ui";

type CampaignRow = {
  id: number;
  name: string;
  from_email: string;
  status: string;
  scheduled_at?: number | null;
  created_at: number;
  tags?: string[];
};
type TagRow = { id: number; name: string };
type BulkResultRow = { id: number; ok: boolean; tags?: string[]; error?: string };
type BulkResponse = {
  summary: { total: number; ok: number; failed: number };
  results: BulkResultRow[];
};
type BulkFailure = { id: number; name: string; error: string };
type BulkReport = { ok: number; failed: number; total: number; failures: BulkFailure[] };

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export default function Campaigns() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [bulkTag, setBulkTag] = useState("");
  const [bulkReport, setBulkReport] = useState<BulkReport | null>(null);

  // Multiple tags are ANDed: a campaign must carry every selected tag.
  const params = new URLSearchParams();
  for (const t of tagFilter) params.append("tag", t);
  const qs = params.toString();

  const { data } = useQuery<{ rows: CampaignRow[] }>({
    queryKey: ["campaigns", tagFilter],
    queryFn: () => api(`/api/campaigns${qs ? `?${qs}` : ""}`),
  });
  // Campaign-scope tags only — a contact tag can never appear here.
  const tags = useQuery<{ rows: TagRow[] }>({
    queryKey: ["tags", "campaign"],
    queryFn: () => api("/api/tags?scope=campaign"),
  });

  const toggleTag = (name: string) =>
    setTagFilter((t) => (t.includes(name) ? t.filter((x) => x !== name) : [...t, name]));

  const rows = useMemo<CampaignRow[]>(() => data?.rows ?? [], [data]);
  const tagNames = useMemo<string[]>(
    () => (tags.data?.rows ?? []).map((t) => String(t.name)),
    [tags.data],
  );
  const nameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of rows) m.set(r.id, r.name);
    return m;
  }, [rows]);

  const selectedSet = new Set(selected);
  // Select-all covers every campaign matching the current filter (the whole
  // loaded result set, which the campaigns endpoint caps at 200).
  const allSelected = rows.length > 0 && rows.every((r) => selectedSet.has(r.id));
  const toggleAll = () => setSelected(allSelected ? [] : rows.map((r) => r.id));
  const toggleOne = (id: number) =>
    setSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  // One batched server call for the whole selection, so the browser never fires
  // hundreds of parallel requests. The response reports each campaign separately.
  const bulk = useMutation<
    BulkResponse,
    unknown,
    { ids: number[]; add?: string[]; remove?: string[] }
  >({
    mutationFn: (payload) =>
      api<BulkResponse>("/api/campaigns/bulk-tags", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (r, payload) => {
      const results = r.results ?? [];
      const failures: BulkFailure[] = results
        .filter((x) => !x.ok)
        .map((x) => ({
          id: x.id,
          name: nameById.get(x.id) ?? `#${x.id}`,
          error: x.error ?? "failed",
        }));
      const summary = r.summary ?? {
        total: results.length,
        ok: results.length - failures.length,
        failed: failures.length,
      };
      setBulkReport({ ...summary, failures });
      const verb = payload.remove?.length ? "Removed tag from" : "Tagged";
      if (!failures.length) {
        toast.success(`${verb} ${summary.ok} campaign${summary.ok === 1 ? "" : "s"}`);
      } else {
        toast.warning(`${verb} ${summary.ok} of ${summary.total}; ${summary.failed} failed`);
      }
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      qc.invalidateQueries({ queryKey: ["tags", "campaign"] });
    },
    onError: (err) => {
      toast.error(errorText(err, "Bulk tag update failed"));
    },
  });

  const applyBulk = (remove: boolean) => {
    const name = bulkTag.trim();
    if (!name || !selected.length) return;
    bulk.mutate(remove ? { ids: selected, remove: [name] } : { ids: selected, add: [name] });
  };

  const remove = useMutation<unknown, unknown, number>({
    mutationFn: (id) => api(`/api/campaigns/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      toast.success("Campaign deleted");
    },
    onError: (err) => {
      toast.error(errorText(err, "Failed to delete campaign"));
    },
  });

  // Duplicate: a fresh draft with the same settings and none of the history,
  // aimed at the clinics this campaign has not emailed yet. The original is
  // left running — pausing or stopping it is a separate action.
  const duplicate = useMutation<unknown, unknown, CampaignRow>({
    mutationFn: (c) =>
      api(`/api/campaigns/${c.id}/duplicate`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      qc.invalidateQueries({ queryKey: ["lists"] });
      const n = Number(r.remainder_count ?? 0).toLocaleString();
      toast.success(
        `Cloned as "${r.name}" \u2014 ${n} not yet emailed (list: "${r.list_name}")`,
        { duration: 12000 },
      );
      nav(`/campaigns/${r.id}`);
    },
    onError: (err) => {
      toast.error(errorText(err, "Failed to duplicate campaign"));
    },
  });
  return (
    <>
      <PageHeader
        title="Campaigns"
        actions={
          <Link to="/campaigns/new">
            <Button>New campaign</Button>
          </Link>
        }
      />
      <Page>
        {!!tags.data?.rows?.length && (
          <div className="flex flex-wrap gap-2">
            <span className="text-xs text-[var(--muted)] py-1">Filter by tag:</span>
            {tags.data.rows.map((t) => (
              <button
                key={t.id}
                onClick={() => toggleTag(t.name)}
                className={`px-2 py-1 text-xs rounded border ${tagFilter.includes(t.name) ? "bg-[var(--primary)] border-[var(--primary)]" : "border-[var(--border)] text-[var(--muted)]"}`}
              >
                {t.name}
              </button>
            ))}
            {tagFilter.length > 0 && (
              <button
                onClick={() => setTagFilter([])}
                className="text-xs text-[var(--muted)] underline"
              >
                clear
              </button>
            )}
          </div>
        )}
        {selected.length > 0 && (
          <Card className="p-3 flex flex-wrap items-center gap-2">
            <span className="text-sm">{selected.length} selected</span>
            <Button variant="ghost" onClick={() => setSelected([])}>
              Clear
            </Button>
            <div className="w-[200px]">
              <Input
                list="campaign-tag-options"
                placeholder="campaign tag"
                value={bulkTag}
                onChange={(e) => setBulkTag(e.target.value)}
              />
            </div>
            {/* Options come only from the campaign-scope tag list. */}
            <datalist id="campaign-tag-options">
              {tagNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <Button
              variant="outline"
              disabled={!bulkTag.trim() || bulk.isPending}
              onClick={() => applyBulk(false)}
            >
              Add tag
            </Button>
            <Button
              variant="outline"
              disabled={!bulkTag.trim() || bulk.isPending}
              onClick={() => applyBulk(true)}
            >
              Remove tag
            </Button>
          </Card>
        )}
        {bulkReport && (
          <Card className="p-3 text-sm space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span>
                Bulk result: {bulkReport.ok} succeeded, {bulkReport.failed} failed (of{" "}
                {bulkReport.total})
              </span>
              <button
                onClick={() => setBulkReport(null)}
                className="text-xs text-[var(--muted)] underline"
              >
                dismiss
              </button>
            </div>
            {bulkReport.failures.length > 0 && (
              <ul className="space-y-0.5">
                {bulkReport.failures.map((f) => (
                  <li key={f.id} className="text-red-400 text-xs">
                    {f.name} (#{f.id}): {f.error}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        <Card>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-[var(--muted)] border-b border-[var(--border)]">
              <tr>
                <th className="px-5 py-3 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all campaigns matching the current filter"
                    checked={allSelected}
                    onChange={toggleAll}
                  />
                </th>
                <th className="px-5 py-3">Name</th>
                <th className="px-5 py-3">Tags</th>
                <th className="px-5 py-3">From</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Created</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.id}
                  className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--accent)]/30"
                >
                  <td className="px-5 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${c.name}`}
                      checked={selectedSet.has(c.id)}
                      onChange={() => toggleOne(c.id)}
                    />
                  </td>
                  <td className="px-5 py-3">
                    <Link
                      className="font-medium hover:text-[var(--primary)]"
                      to={`/campaigns/${c.id}`}
                    >
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(c.tags ?? []).map((t) => (
                        <span
                          key={t}
                          className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--accent)] text-[var(--muted)]"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-[var(--muted)] font-mono">{c.from_email}</td>
                  <td className="px-5 py-3">
                    <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                    {c.status === "scheduled" && c.scheduled_at && (
                      <div className="text-xs text-[var(--muted)] mt-1 font-mono">
                        {new Date(c.scheduled_at * 1000).toLocaleString()}
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-3 text-[var(--muted)]">
                    {new Date(c.created_at * 1000).toLocaleString()}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Button
                      variant="ghost"
                      disabled={duplicate.isPending}
                      onClick={() => {
                        if (
                          !confirm(
                            `Duplicate "${c.name}"?\n\n` +
                              "A new DRAFT campaign is created with the same settings and empty stats. " +
                              `It targets a new list of the clinics "${c.name}" has NOT emailed yet, so nobody is emailed twice.\n\n` +
                              "The original campaign is untouched — pausing or stopping it is a separate action.",
                          )
                        )
                          return;
                        duplicate.mutate(c);
                      }}
                    >
                      Duplicate
                    </Button>
                    <Button
                      variant="ghost"
                      className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                      disabled={c.status === "sending" || remove.variables === c.id}
                      onClick={() => {
                        if (
                          !confirm(
                            `Delete campaign "${c.name}"? This will also remove its send history. This cannot be undone.`,
                          )
                        )
                          return;
                        remove.mutate(c.id);
                      }}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
              {data && !rows.length && (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-[var(--muted)]">
                    {tagFilter.length ? "No campaigns match those tags." : "No campaigns yet."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </Page>
    </>
  );
}
