import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { Page, PageHeader, Card, Input, Button, Badge, Select, statusTone } from "../components/ui";

export default function Sequences() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ["sequences"], queryFn: () => api("/api/sequences") });
  const lists = useQuery({ queryKey: ["lists"], queryFn: () => api("/api/lists") });

  const [name, setName] = useState("");
  const [listId, setListId] = useState("");
  const [fromEmail, setFromEmail] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api("/api/sequences", {
        method: "POST",
        body: JSON.stringify({
          name,
          list_id: listId ? Number(listId) : null,
          segment_id: null,
          from_email: fromEmail || null,
        }),
      }),
    onSuccess: (r: any) => {
      toast.success("Sequence created");
      qc.invalidateQueries({ queryKey: ["sequences"] });
      nav(`/sequences/${r.id}/edit`);
    },
    onError: (e) => toast.error(String(e)),
  });

  const rows = data?.rows ?? [];

  return (
    <>
      <PageHeader
        title="Sequences"
        subtitle="Multi-step campaigns with waits, caps and local-time windows"
      />
      <Page>
        <Card className="p-4">
          <div className="text-sm font-medium mb-3">New sequence</div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <Select value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">All active contacts</option>
              {(lists.data?.rows ?? []).map((l: any) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.kind === "segment" ? " (segment)" : ""}
                </option>
              ))}
            </Select>
            <Input
              placeholder="From email (default: worker default)"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
            />
            <Button onClick={() => create.mutate()} disabled={!name || create.isPending}>
              Create
            </Button>
          </div>
        </Card>

        <Card>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-[var(--muted)] border-b border-[var(--border)]">
              <tr>
                <th className="px-5 py-3">Name</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Steps</th>
                <th className="px-5 py-3">Active</th>
                <th className="px-5 py-3">Enrolled</th>
                <th className="px-5 py-3">Timezone</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-5 py-3">
                    <Link className="text-[var(--primary)] hover:underline" to={`/sequences/${r.id}`}>
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-5 py-3">
                    <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                  </td>
                  <td className="px-5 py-3 text-[var(--muted)]">{r.step_count}</td>
                  <td className="px-5 py-3 text-[var(--muted)]">{r.active_count}</td>
                  <td className="px-5 py-3 text-[var(--muted)]">{r.enrolled_count}</td>
                  <td className="px-5 py-3 text-[var(--muted)]">{r.timezone}</td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    <Link to={`/sequences/${r.id}`}>
                      <Button variant="ghost">Open</Button>
                    </Link>
                    <Link to={`/sequences/${r.id}/edit`}>
                      <Button variant="ghost">Edit</Button>
                    </Link>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-[var(--muted)]">
                    No sequences yet.
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
