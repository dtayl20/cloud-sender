import { useState } from "react";
import Papa from "papaparse";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { Page, PageHeader, Card, Button, Label, Select, Input } from "../components/ui";
import { CollapsibleSection } from "../components/Collapsible";

export default function Imports() {
  const qc = useQueryClient();
  const [sp] = useSearchParams();
  const initialList = sp.get("list") ?? "";

  const jobs = useQuery({ queryKey: ["import-jobs"], queryFn: () => api("/api/imports"), refetchInterval: 4000 });
  const lists = useQuery({ queryKey: ["lists"], queryFn: () => api("/api/lists") });
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => api("/api/tags") });

  const [rows, setRows] = useState<any[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [map, setMap] = useState<Record<string, string>>({ email: "", first_name: "", last_name: "", practice_name: "" });
  const [targetList, setTargetList] = useState(initialList);
  const [tagInput, setTagInput] = useState("");
  const [tagList, setTagList] = useState<string[]>([]);

  function onFile(f: File) {
    Papa.parse(f, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        setRows(res.data as any[]);
        setHeaders(res.meta.fields ?? []);
        const guess = (cands: string[]) => res.meta.fields?.find((h) => cands.some((c) => h.toLowerCase().includes(c))) ?? "";
        setMap({
          email: guess(["email"]),
          first_name: guess(["first", "fname", "given"]),
          last_name: guess(["last", "lname", "surname", "family"]),
          practice_name: guess(["practice", "company", "clinic", "org"]),
        });
        toast.success(`Parsed ${res.data.length} rows`);
      },
      error: (e) => toast.error(e.message),
    });
  }

  const tagsBody = () => tagList;

  const upload = useMutation({
    mutationFn: () =>
      api("/api/imports/csv", {
        method: "POST",
        body: JSON.stringify({
          rows,
          source: "csv",
          map: Object.fromEntries(Object.entries(map).filter(([_, v]) => v)),
          target_list_id: targetList ? Number(targetList) : null,
          tags: tagsBody(),
        }),
      }),
    onSuccess: (r: any) => {
      toast.success(`Imported ${r.inserted} (${r.skipped} skipped)`);
      setRows([]); setHeaders([]);
      qc.invalidateQueries({ queryKey: ["import-jobs"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["lists"] });
    },
    onError: (e) => toast.error(String(e)),
  });

  // ---- Source table mirrors ----
  const mirrors = useQuery({ queryKey: ["mirrors"], queryFn: () => api("/api/source-db/mirrors"), refetchInterval: 5000 });
  const srcTables = useQuery({ queryKey: ["src-tables"], queryFn: () => api("/api/source-db/tables") });
  const [newMirror, setNewMirror] = useState({ table_name: "", email_column: "" });
  const srcCols = useQuery({
    queryKey: ["src-cols", newMirror.table_name],
    queryFn: () => api(`/api/source-db/columns?table=${encodeURIComponent(newMirror.table_name)}`),
    enabled: !!newMirror.table_name,
  });
  const addMirror = useMutation({
    mutationFn: () => api("/api/source-db/mirrors", { method: "POST", body: JSON.stringify(newMirror) }),
    onSuccess: () => {
      toast.success("Source table added");
      setNewMirror({ table_name: "", email_column: "" });
      qc.invalidateQueries({ queryKey: ["mirrors"] });
    },
    onError: (e) => toast.error(String(e)),
  });
  const syncMirror = useMutation({
    mutationFn: (id: number) => api(`/api/source-db/mirrors/${id}/sync`, { method: "POST" }),
    onSuccess: (r: any) => {
      toast.success(`Synced ${r.result?.upserted ?? 0} rows (${r.result?.disabled ?? 0} disabled)`);
      qc.invalidateQueries({ queryKey: ["mirrors"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
    onError: (e) => toast.error(String(e)),
  });
  const removeMirror = useMutation({
    mutationFn: (id: number) => api(`/api/source-db/mirrors/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mirrors"] }),
  });

  const addTag = () => {
    const v = tagInput.trim();
    if (!v) return;
    if (!tagList.includes(v)) setTagList([...tagList, v]);
    setTagInput("");
  };

  return (
    <>
      <PageHeader title="Import contacts" subtitle="CSV upload or copy from a bound D1 source" />
      <Page>
        <Card className="p-5 space-y-3">
          <div className="text-sm font-medium">Apply to every imported contact</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Add to list (optional)</Label>
              <Select value={targetList} onChange={(e) => setTargetList(e.target.value)}>
                <option value="">— none —</option>
                {(lists.data?.rows ?? []).filter((l: any) => l.kind === "static").map((l: any) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Apply tags</Label>
              <div className="flex gap-2">
                <Input placeholder="add tag and press Enter" value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }} />
                <Button variant="outline" onClick={addTag}>Add</Button>
              </div>
              <div className="flex flex-wrap gap-1 mt-2">
                {tagList.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-[var(--accent)]">
                    {t}
                    <button onClick={() => setTagList(tagList.filter((x) => x !== t))} className="text-[var(--muted)]">×</button>
                  </span>
                ))}
                {!!tags.data?.rows?.length && (
                  <div className="text-xs text-[var(--muted)] w-full mt-1">
                    Quick add:&nbsp;
                    {tags.data.rows.map((t: any) => (
                      <button key={t.id} onClick={() => !tagList.includes(t.name) && setTagList([...tagList, t.name])}
                        className="mr-2 underline">{t.name}</button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-5 space-y-4">
          <div className="text-sm font-medium">CSV upload</div>
          <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          <CollapsibleSection
            id="imports.columns"
            title="How columns work"
            summary="Map the four built-ins; every other column is kept as an attribute"
            defaultOpen={false}
          >
            <ul className="list-disc pl-4 space-y-1 text-xs text-[var(--muted)]">
              <li>
                Columns you map to <code>email</code>, <code>first_name</code>, <code>last_name</code> or{" "}
                <code>practice_name</code> become those contact fields.
              </li>
              <li>Every column you don't map is kept on the contact as an attribute — nothing is thrown away.</li>
              <li>
                Use one in an email with <code>{"{{attributes.<column>}}"}</code>, written with the CSV header name
                exactly as it appears.
              </li>
              <li>
                Keep header names free of spaces and punctuation (<code>agency_name</code>, not{" "}
                <code>Agency Name</code>), and one line per value — a multi-line cell keeps its embedded newlines in
                the attribute.
              </li>
              <li>
                Want a friendlier name? Give the column one in the campaign's <b>Variables</b> section instead of
                typing <code>attributes.…</code> everywhere.
              </li>
            </ul>
          </CollapsibleSection>
          {!!headers.length && (
            <>
              <div className="grid grid-cols-4 gap-3">
                {(["email", "first_name", "last_name", "practice_name"] as const).map((k) => (
                  <div key={k}>
                    <Label>{k}</Label>
                    <Select value={map[k] ?? ""} onChange={(e) => setMap({ ...map, [k]: e.target.value })}>
                      <option value="">—</option>
                      {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </Select>
                  </div>
                ))}
              </div>
              <div className="flex justify-between items-center">
                <div className="text-xs text-[var(--muted)]">{rows.length} rows ready · unmapped columns saved as attributes</div>
                <Button onClick={() => upload.mutate()} disabled={!map.email || upload.isPending}>Import {rows.length} rows</Button>
              </div>
            </>
          )}
        </Card>

        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Source DB mirrors</div>
              <p className="text-xs text-[var(--muted)] mt-1">
                Mirror tables from the bound <code>SOURCE_DB</code> into Contacts. Runs hourly automatically, or use “Sync now”.
                Deleted source rows are marked <code>disabled</code>. Segments filter over the mirrored contacts.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-12 gap-3 items-end">
            <div className="col-span-4">
              <Label>Table</Label>
              <Select value={newMirror.table_name} onChange={(e) => setNewMirror({ table_name: e.target.value, email_column: "" })}>
                <option value="">— pick a table —</option>
                {(srcTables.data?.rows ?? []).map((t: any) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </Select>
            </div>
            <div className="col-span-4">
              <Label>Email column</Label>
              <Select value={newMirror.email_column} onChange={(e) => setNewMirror({ ...newMirror, email_column: e.target.value })} disabled={!newMirror.table_name}>
                <option value="">—</option>
                {(srcCols.data?.rows ?? []).map((c: any) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </Select>
            </div>
            <div className="col-span-4">
              <Button onClick={() => addMirror.mutate()} disabled={!newMirror.table_name || !newMirror.email_column || addMirror.isPending}>
                Add mirror
              </Button>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-[var(--muted)] border-b border-[var(--border)]">
              <tr>
                <th className="px-2 py-2">Table</th>
                <th className="px-2 py-2">Email col</th>
                <th className="px-2 py-2">Last sync</th>
                <th className="px-2 py-2">Rows</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {(mirrors.data?.rows ?? []).map((m: any) => (
                <tr key={m.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-2 py-2 font-mono">{m.table_name}</td>
                  <td className="px-2 py-2 font-mono">{m.email_column}</td>
                  <td className="px-2 py-2 text-[var(--muted)] text-xs">
                    {m.last_synced_at ? new Date(m.last_synced_at * 1000).toLocaleString() : "never"}
                    {m.last_error && <div className="text-red-400">⚠ {m.last_error}</div>}
                  </td>
                  <td className="px-2 py-2 font-mono">{m.last_row_count ?? "—"}</td>
                  <td className="px-2 py-2 text-right space-x-3">
                    <button onClick={() => syncMirror.mutate(m.id)} className="text-xs text-[var(--primary)]">Sync now</button>
                    <button onClick={() => confirm("Remove mirror? Existing contacts stay.") && removeMirror.mutate(m.id)} className="text-xs text-red-400">Remove</button>
                  </td>
                </tr>
              ))}
              {mirrors.data && !mirrors.data.rows?.length && (
                <tr><td colSpan={5} className="px-2 py-6 text-center text-[var(--muted)] text-xs">No mirrors yet. Add one above to start pulling source rows into Contacts.</td></tr>
              )}
            </tbody>
          </table>
        </Card>

        <Card>
          <div className="px-5 py-4 border-b border-[var(--border)] font-medium">Recent jobs</div>
          <table className="w-full text-sm">
            <tbody>
              {(jobs.data?.rows ?? []).map((j: any) => (
                <tr key={j.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-5 py-3">#{j.id} <span className="text-xs text-[var(--muted)]">{j.type}</span></td>
                  <td className="px-5 py-3">{j.status}</td>
                  <td className="px-5 py-3 text-[var(--muted)]">{j.inserted}/{j.total} inserted · {j.skipped} skipped</td>
                  <td className="px-5 py-3 text-[var(--muted)] text-xs">{new Date(j.created_at * 1000).toLocaleString()}</td>
                </tr>
              ))}
              {jobs.data && !jobs.data.rows?.length && (
                <tr><td className="px-5 py-10 text-center text-[var(--muted)]">No jobs yet.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </Page>
    </>
  );
}
