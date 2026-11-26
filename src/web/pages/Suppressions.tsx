import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { Page, PageHeader, Card, Input, Button, Badge } from "../components/ui";

export default function Suppressions() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [email, setEmail] = useState("");
  const { data } = useQuery({ queryKey: ["suppressions", q], queryFn: () => api(`/api/suppressions?q=${encodeURIComponent(q)}`) });

  const add = useMutation({
    mutationFn: (e: string) => api("/api/suppressions", { method: "POST", body: JSON.stringify({ email: e }) }),
    onSuccess: () => { toast.success("Suppressed"); setEmail(""); qc.invalidateQueries({ queryKey: ["suppressions"] }); },
    onError: (e) => toast.error(String(e)),
  });
  const remove = useMutation({
    mutationFn: (e: string) => api(`/api/suppressions/${encodeURIComponent(e)}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("Removed"); qc.invalidateQueries({ queryKey: ["suppressions"] }); },
  });

  return (
    <>
      <PageHeader title="Suppressions" subtitle={data ? `${data.total} suppressed addresses` : ""} />
      <Page>
        <Card className="p-4 flex gap-2">
          <Input placeholder="Add email to suppress…" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button onClick={() => add.mutate(email)} disabled={!email || add.isPending}>Suppress</Button>
        </Card>
        <Input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Card>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-[var(--muted)] border-b border-[var(--border)]">
              <tr>
                <th className="px-5 py-3">Email</th>
                <th className="px-5 py-3">Reason</th>
                <th className="px-5 py-3">Source</th>
                <th className="px-5 py-3">When</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).map((r: any) => (
                <tr key={r.email} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-5 py-3 font-mono">{r.email}</td>
                  <td className="px-5 py-3"><Badge tone="red">{r.reason}</Badge></td>
                  <td className="px-5 py-3 text-[var(--muted)]">{r.source}</td>
                  <td className="px-5 py-3 text-[var(--muted)]">{new Date(r.created_at * 1000).toLocaleString()}</td>
                  <td className="px-5 py-3 text-right">
                    <Button variant="ghost" onClick={() => remove.mutate(r.email)}>Remove</Button>
                  </td>
                </tr>
              ))}
              {data?.rows && data.rows.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-10 text-center text-[var(--muted)]">No suppressions.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </Page>
    </>
  );
}
