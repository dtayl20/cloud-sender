import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, apiUrl } from "../api";
import { Page, PageHeader, Card, Button, Input, Label, Select, Badge } from "../components/ui";
import { Link } from "react-router-dom";

type RuleSource = "contact" | "attribute";
type TagScope = "contact" | "campaign";
type RuleOp = "eq" | "neq" | "contains" | "starts_with" | "in" | "not_in" | "empty" | "not_empty";
type Rule = {
  source: RuleSource;
  field: string;
  op: RuleOp;
  value?: string;
};

const CONTACT_FIELDS = ["email", "first_name", "last_name", "practice_name", "status", "source", "source_table"];
const OPS: { v: RuleOp; label: string }[] = [
  { v: "eq", label: "equals" },
  { v: "neq", label: "not equals" },
  { v: "contains", label: "contains" },
  { v: "starts_with", label: "starts with" },
  { v: "in", label: "in (comma list)" },
  { v: "not_in", label: "not in (comma list)" },
  { v: "empty", label: "is empty" },
  { v: "not_empty", label: "is not empty" },
];

function ruleToApi(r: Rule) {
  const needsValue = !["empty", "not_empty"].includes(r.op);
  const isMulti = r.op === "in" || r.op === "not_in";
  return {
    source: r.source,
    field: r.field,
    op: r.op,
    value: !needsValue
      ? undefined
      : isMulti
      ? (r.value ?? "").split(",").map((s) => s.trim()).filter(Boolean)
      : r.value ?? "",
  };
}

function emptyForm() {
  return { name: "", kind: "static" as const, statuses: ["active"], tagNames: [], tagMode: "any" as const, rules: [] as Rule[] };
}

function parseSegmentFilter(raw: unknown) {
  const f = raw && typeof raw === "object" ? raw as any : {};
  const rules = Array.isArray(f.rules)
    ? f.rules
        .filter((r: any) => r?.source === "contact" || r?.source === "attribute")
        .map((r: any) => ({
          source: r.source,
          field: String(r.field ?? ""),
          op: r.op ?? "eq",
          value: Array.isArray(r.value) ? r.value.join(", ") : String(r.value ?? ""),
        }))
    : [];
  return {
    statuses: Array.isArray(f.status) && f.status.length ? f.status : ["active"],
    tagNames: Array.isArray(f.tags) ? f.tags : [],
    tagMode: f.tag_mode === "all" ? "all" as const : "any" as const,
    rules,
  };
}

function hasLegacyFilter(raw: unknown) {
  const f = raw && typeof raw === "object" ? raw as any : {};
  if (["field", "column", "table", "source_db", "source_table", "email_column", "source_rules"].some((k) => k in f)) return true;
  return Array.isArray(f.rules) && f.rules.some((r: any) => !(r?.source === "contact" || r?.source === "attribute"));
}

export default function Lists() {
  const qc = useQueryClient();
  const lists = useQuery({ queryKey: ["lists"], queryFn: () => api("/api/lists") });
  const tags = useQuery({ queryKey: ["tags", "contact"], queryFn: () => api("/api/tags?scope=contact") });
  const campaignTags = useQuery({ queryKey: ["tags", "campaign"], queryFn: () => api("/api/tags?scope=campaign") });
  const fields = useQuery({ queryKey: ["contact-fields"], queryFn: () => api("/api/contacts/fields") });

  const [form, setForm] = useState<{
    name: string;
    kind: "static" | "segment";
    statuses: string[];
    tagNames: string[];
    tagMode: "any" | "all";
    rules: Rule[];
  }>(emptyForm());
  const [editingListId, setEditingListId] = useState<number | null>(null);

  const buildFilter = () => ({
    status: form.statuses,
    tags: form.tagNames,
    tag_mode: form.tagMode,
    rules: form.rules.filter((r) => r.field).map(ruleToApi),
  });

  const previewCount = useQuery({
    queryKey: ["segment-preview", form],
    queryFn: () => api("/api/lists/preview", { method: "POST", body: JSON.stringify(buildFilter()) }),
    enabled: form.kind === "segment",
  });

  const createList = useMutation({
    mutationFn: () =>
      api("/api/lists", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          kind: form.kind,
          filter: form.kind === "segment" ? buildFilter() : undefined,
        }),
      }),
    onSuccess: () => {
      toast.success("List created");
      setForm(emptyForm());
      qc.invalidateQueries({ queryKey: ["lists"] });
    },
    onError: (e) => toast.error(String(e)),
  });

  const updateList = useMutation({
    mutationFn: () =>
      api(`/api/lists/${editingListId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name,
          kind: form.kind,
          filter: form.kind === "segment" ? buildFilter() : undefined,
        }),
      }),
    onSuccess: () => {
      toast.success("Segment updated");
      setEditingListId(null);
      setForm(emptyForm());
      qc.invalidateQueries({ queryKey: ["lists"] });
    },
    onError: (e) => toast.error(String(e)),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/lists/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lists"] }),
  });

  const [newTag, setNewTag] = useState("");
  const [newCampaignTag, setNewCampaignTag] = useState("");
  const createTag = useMutation({
    mutationFn: (scope: TagScope) =>
      api(`/api/tags?scope=${scope}`, {
        method: "POST",
        body: JSON.stringify({ name: scope === "campaign" ? newCampaignTag : newTag }),
      }),
    onSuccess: (_r, scope) => {
      if (scope === "campaign") setNewCampaignTag("");
      else setNewTag("");
      qc.invalidateQueries({ queryKey: ["tags"] });
    },
    onError: (e) => toast.error(String(e)),
  });
  const deleteTag = useMutation({
    mutationFn: ({ id, scope }: { id: number; scope: TagScope }) =>
      api(`/api/tags/${id}?scope=${scope}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tags"] }),
  });

  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const updateRule = (i: number, patch: Partial<Rule>) => {
    setForm({ ...form, rules: form.rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });
  };
  const removeRule = (i: number) => setForm({ ...form, rules: form.rules.filter((_, idx) => idx !== i) });
  const addRule = () =>
    setForm({ ...form, rules: [...form.rules, { source: "contact", field: "email", op: "contains", value: "" }] });

  const attrKeys: string[] = (fields.data?.attributes ?? []).map((a: any) => a.label);

  return (
    <>
      <PageHeader title="Lists & segments" subtitle="Group contacts into static lists or dynamic segments" />
      <Page>
        <div className="grid grid-cols-2 gap-4">
          <Card className="p-5 space-y-4">
            <div className="text-sm font-medium">{editingListId ? "Edit segment" : "Create list / segment"}</div>
            <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div>
              <Label>Type</Label>
              <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as any })}>
                <option value="static">Static list (manual or import)</option>
                <option value="segment">Segment (auto-rules)</option>
              </Select>
            </div>
            {form.kind === "segment" && (
              <>
                <div className="text-xs text-[var(--muted)] px-3 py-2 rounded border border-[var(--border)] bg-[var(--accent)]/40">
                  Segments filter your imported contacts. Mirrored source-DB tables sync hourly, so new rows automatically flow into matching segments.
                </div>
                <div>
                  <Label>Statuses</Label>
                  <div className="flex flex-wrap gap-2">
                    {["active", "unsubscribed", "bounced", "complained", "disabled"].map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setForm({ ...form, statuses: toggle(form.statuses, s) })}
                        className={`px-2 py-1 text-xs rounded border ${form.statuses.includes(s) ? "bg-[var(--primary)] border-[var(--primary)]" : "border-[var(--border)] text-[var(--muted)]"}`}
                      >{s}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <Label>Contact tags ({form.tagMode === "any" ? "match any" : "match all"})</Label>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {(tags.data?.rows ?? []).map((t: any) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setForm({ ...form, tagNames: toggle(form.tagNames, t.name) })}
                        className={`px-2 py-1 text-xs rounded border ${form.tagNames.includes(t.name) ? "bg-[var(--primary)] border-[var(--primary)]" : "border-[var(--border)] text-[var(--muted)]"}`}
                      >{t.name} <span className="opacity-60">{t.contact_count}</span></button>
                    ))}
                    {!tags.data?.rows?.length && <span className="text-xs text-[var(--muted)]">No contact tags yet — create one on the right.</span>}
                  </div>
                  <Select value={form.tagMode} onChange={(e) => setForm({ ...form, tagMode: e.target.value as any })}>
                    <option value="any">Match any tag</option>
                    <option value="all">Match all tags</option>
                  </Select>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Column rules (all must match)</Label>
                    <Button onClick={addRule}>+ Add rule</Button>
                  </div>
                  {form.rules.length === 0 && (
                    <div className="text-xs text-[var(--muted)]">No column rules yet. Add one to filter by a contact column or attribute (e.g. <code>state = TAS</code>).</div>
                  )}
                  {form.rules.map((r, i) => (
                    <RuleRow
                      key={i}
                      rule={r}
                      attrKeys={attrKeys}
                      onChange={(patch) => updateRule(i, patch)}
                      onRemove={() => removeRule(i)}
                    />
                  ))}
                </div>

                <div className="text-xs text-[var(--muted)]">
                  Live count: <span className="font-mono text-white">{previewCount.data?.count ?? "…"}</span>
                </div>
                {(previewCount.data?.warnings ?? []).map((w: string, i: number) => (
                  <div key={i} className="text-xs text-amber-400">⚠ {w}</div>
                ))}
              </>
            )}
            <div className="flex gap-2">
              <Button
                onClick={() => editingListId ? updateList.mutate() : createList.mutate()}
                disabled={!form.name || createList.isPending || updateList.isPending}
              >{editingListId ? "Save segment" : "Create"}</Button>
              {editingListId && (
                <Button variant="outline" onClick={() => { setEditingListId(null); setForm(emptyForm()); }}>Cancel</Button>
              )}
            </div>
          </Card>

          <Card className="p-5 space-y-4">
            <div className="text-sm font-medium">Tags</div>
            <p className="text-xs text-[var(--muted)]">
              Contact tags and campaign tags are separate lists. A “melbourne” contact tag and a “melbourne” campaign tag are unrelated.
            </p>

            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wide text-[var(--muted)]">Contact tags</div>
              <div className="flex gap-2">
                <Input placeholder="new contact tag" value={newTag} onChange={(e) => setNewTag(e.target.value)} />
                <Button onClick={() => createTag.mutate("contact")} disabled={!newTag}>Add</Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {(tags.data?.rows ?? []).map((t: any) => (
                  <span key={t.id} className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-[var(--accent)]">
                    {t.name}
                    <span className="text-[var(--muted)]">· {t.contact_count}</span>
                    <button onClick={() => deleteTag.mutate({ id: t.id, scope: "contact" })} className="ml-1 text-[var(--muted)] hover:text-red-400">×</button>
                  </span>
                ))}
                {!tags.data?.rows?.length && <span className="text-xs text-[var(--muted)]">No contact tags yet.</span>}
              </div>
            </div>

            <div className="space-y-2 border-t border-[var(--border)] pt-4">
              <div className="text-xs uppercase tracking-wide text-[var(--muted)]">Campaign tags</div>
              <div className="flex gap-2">
                <Input placeholder="new campaign tag" value={newCampaignTag} onChange={(e) => setNewCampaignTag(e.target.value)} />
                <Button onClick={() => createTag.mutate("campaign")} disabled={!newCampaignTag}>Add</Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {(campaignTags.data?.rows ?? []).map((t: any) => (
                  <span key={t.id} className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-[var(--accent)]">
                    {t.name}
                    <span className="text-[var(--muted)]">· {t.campaign_count}</span>
                    <button onClick={() => deleteTag.mutate({ id: t.id, scope: "campaign" })} className="ml-1 text-[var(--muted)] hover:text-red-400">×</button>
                  </span>
                ))}
                {!campaignTags.data?.rows?.length && <span className="text-xs text-[var(--muted)]">No campaign tags yet.</span>}
              </div>
            </div>
          </Card>
        </div>

        <Card>
          <div className="px-5 py-4 border-b border-[var(--border)] font-medium">Existing lists & segments</div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-[var(--muted)] border-b border-[var(--border)]">
              <tr><th className="px-5 py-3">Name</th><th className="px-5 py-3">Type</th><th className="px-5 py-3">Members</th><th className="px-5 py-3"></th></tr>
            </thead>
            <tbody>
              {(lists.data?.rows ?? []).map((l: any) => {
                let rawFilter: unknown = {};
                try { rawFilter = l.filter_json ? JSON.parse(l.filter_json) : {}; } catch {}
                const legacy = l.kind === "segment" && hasLegacyFilter(rawFilter);
                return (
                <tr key={l.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-5 py-3">
                    <div>{l.name}</div>
                    {legacy && <div className="text-xs text-amber-400 mt-1">Needs repair: edit and save current rules</div>}
                  </td>
                  <td className="px-5 py-3"><Badge tone={l.kind === "segment" ? "blue" : "default"}>{l.kind}</Badge></td>
                  <td className="px-5 py-3 font-mono"><MemberCount list={l} /></td>
                  <td className="px-5 py-3 text-right">
                    {l.kind !== "segment" && (
                      <Link to={`/imports?list=${l.id}`} className="text-xs text-[var(--primary)] mr-3">Import CSV →</Link>
                    )}
                    {l.kind === "segment" && (
                      <button
                        onClick={() => {
                          const parsed = parseSegmentFilter(rawFilter);
                          setEditingListId(l.id);
                          setForm({
                            name: l.name,
                            kind: "segment",
                            statuses: parsed.statuses,
                            tagNames: parsed.tagNames,
                            tagMode: parsed.tagMode,
                            rules: parsed.rules,
                          });
                        }}
                        className="text-xs text-[var(--primary)] mr-3"
                      >Edit</button>
                    )}
                    <Link to={`/contacts?list=${l.id}`} className="text-xs text-[var(--primary)] mr-3">View</Link>
                    {/* Direct link, not fetch(): the browser handles the download
                        and Cloudflare Access sends the existing session cookie. */}
                    <a
                      href={apiUrl(`/api/lists/${l.id}/export`)}
                      className="text-xs text-[var(--primary)] mr-3"
                      title="Download this list as CSV, including the verification columns"
                    >Export CSV ↓</a>
                    <button onClick={() => confirm("Delete list?") && remove.mutate(l.id)} className="text-xs text-red-400">Delete</button>
                  </td>
                </tr>
                );
              })}
              {lists.data?.rows && lists.data.rows.length === 0 && (
                <tr><td colSpan={4} className="px-5 py-10 text-center text-[var(--muted)]">No lists yet.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </Page>
    </>
  );
}

function RuleRow({
  rule, attrKeys, onChange, onRemove,
}: {
  rule: Rule;
  attrKeys: string[];
  onChange: (p: Partial<Rule>) => void;
  onRemove: () => void;
}) {
  const needsValue = !["empty", "not_empty"].includes(rule.op);
  return (
    <div className="rounded border border-[var(--border)] p-2 space-y-2">
      <div className="grid grid-cols-12 gap-2">
        <Select
          className="col-span-3"
          value={rule.source}
          onChange={(e) => onChange({ source: e.target.value as RuleSource, field: "" })}
        >
          <option value="contact">Contact column</option>
          <option value="attribute">Attribute (source column)</option>
        </Select>

        {rule.source === "contact" ? (
          <Select className="col-span-3" value={rule.field} onChange={(e) => onChange({ field: e.target.value })}>
            {CONTACT_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
          </Select>
        ) : attrKeys.length ? (
          <Select className="col-span-3" value={rule.field} onChange={(e) => onChange({ field: e.target.value })}>
            <option value="">— attribute —</option>
            {attrKeys.map((k) => <option key={k} value={k}>{k}</option>)}
          </Select>
        ) : (
          <Input className="col-span-3" placeholder="attribute key (e.g. state)" value={rule.field} onChange={(e) => onChange({ field: e.target.value })} />
        )}

        <Select className="col-span-3" value={rule.op} onChange={(e) => onChange({ op: e.target.value as RuleOp })}>
          {OPS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
        </Select>

        {needsValue && (
          <Input
            className="col-span-2"
            placeholder={rule.op === "in" || rule.op === "not_in" ? "a, b, c" : "value"}
            value={rule.value ?? ""}
            onChange={(e) => onChange({ value: e.target.value })}
          />
        )}

        <button onClick={onRemove} className="col-span-1 text-xs text-red-400 hover:text-red-300">remove</button>
      </div>
    </div>
  );
}

function MemberCount({ list }: { list: any }) {
  const { data } = useQuery({
    queryKey: ["list-count", list.id, list.kind, list.filter_json],
    queryFn: () => api(`/api/lists/${list.id}/count`),
  });
  return <>{data?.count ?? list.member_count ?? 0}</>;
}
