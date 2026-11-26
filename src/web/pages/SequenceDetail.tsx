import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { Page, PageHeader, Card, Input, Button, Badge, Select, Label, statusTone } from "../components/ui";

export default function SequenceDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["sequence", id], queryFn: () => api(`/api/sequences/${id}`) });
  const metrics = useQuery({ queryKey: ["sequence-metrics", id], queryFn: () => api(`/api/sequences/${id}/metrics`) });
  const [statusFilter, setStatusFilter] = useState("all");
  const enrolments = useQuery({
    queryKey: ["sequence-enrollments", id, statusFilter],
    queryFn: () => api(`/api/sequences/${id}/enrollments?limit=100&status=${statusFilter}`),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["sequence", id] });
    qc.invalidateQueries({ queryKey: ["sequence-metrics", id] });
    qc.invalidateQueries({ queryKey: ["sequence-enrollments", id] });
  };

  const seq = detail.data?.sequence;
  const preview = detail.data?.release_preview;

  const setStatus = useMutation({
    mutationFn: (status: string) =>
      api(`/api/sequences/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }),
    onSuccess: () => {
      toast.success("Status updated");
      invalidate();
    },
    onError: (e) => toast.error(String(e)),
  });

  const enrol = useMutation({
    mutationFn: (mode: string) =>
      api(`/api/sequences/${id}/enroll`, { method: "POST", body: JSON.stringify({ mode }) }),
    onSuccess: (r: any) => {
      toast.success(`Enrolled ${r.enrolled}, re-enrolled ${r.reenrolled}`);
      invalidate();
    },
    onError: (e) => toast.error(String(e)),
  });

  const confirm = useMutation({
    mutationFn: () => api(`/api/sequences/${id}/release`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (r: any) => {
      toast.success(`Released ${r.released_steps} step(s), re-activated ${r.reactivated}`);
      invalidate();
    },
    onError: (e) => toast.error(String(e)),
  });

  const reenrol = useMutation({
    mutationFn: ({ eid, mode }: any) =>
      api(`/api/sequences/${id}/enrollments/${eid}/reenroll`, {
        method: "POST",
        body: JSON.stringify({ mode }),
      }),
    onSuccess: () => {
      toast.success("Re-enrolled");
      invalidate();
    },
    onError: (e) => toast.error(String(e)),
  });

  const remove = useMutation({
    mutationFn: (eid: number) => api(`/api/sequences/${id}/enrollments/${eid}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Removed");
      invalidate();
    },
  });

  const formSlugs = useQuery({
    queryKey: ["form-slugs"],
    queryFn: () => api("/api/sequences/form-slugs"),
  });
  const [formSlug, setFormSlug] = useState("");
  const [formPreview, setFormPreview] = useState<any>(null);
  const previewForm = useMutation({
    mutationFn: () =>
      api(`/api/sequences/${id}/form-enroll/preview?form_slug=${encodeURIComponent(formSlug)}`),
    onSuccess: (r: any) => setFormPreview(r),
    onError: (e) => toast.error(String(e)),
  });
  const enrolForm = useMutation({
    mutationFn: () =>
      api(`/api/sequences/${id}/form-enroll`, {
        method: "POST",
        body: JSON.stringify({ form_slug: formSlug }),
      }),
    onSuccess: (r: any) => {
      toast.success(
        `Enrolled ${r.enrolled}${r.held ? " (held until activation)" : ""}, skipped ${Object.values(r.skipped_reasons ?? {}).reduce((s: number, n: any) => s + Number(n), 0)}`,
      );
      setFormPreview(null);
      invalidate();
    },
    onError: (e) => toast.error(String(e)),
  });

  const [testEmail, setTestEmail] = useState("");
  const [testMinutes, setTestMinutes] = useState("1");
  const test = useMutation({
    mutationFn: () =>
      api(`/api/sequences/${id}/test`, {
        method: "POST",
        body: JSON.stringify({ email: testEmail, compress_minutes: Number(testMinutes || 1) }),
      }),
    onSuccess: (r: any) => toast.success(`Test queued: ${r.queued} step(s)`),
    onError: (e) => toast.error(String(e)),
  });

  if (!seq) return <Page>{detail.isLoading ? "Loading…" : "Not found."}</Page>;
  const progress = detail.data?.progress;

  return (
    <>
      <PageHeader
        title={seq.name}
        subtitle={`${seq.status} · ${progress?.step_count ?? 0} step(s) · ${progress?.enrollments?.total ?? 0} enrolled`}
        actions={
          <>
            {seq.status !== "active" ? (
              <Button onClick={() => setStatus.mutate("active")}>Activate</Button>
            ) : (
              <Button variant="outline" onClick={() => setStatus.mutate("paused")}>
                Pause
              </Button>
            )}
            <Link to={`/sequences/${id}/edit`}>
              <Button variant="ghost">Edit</Button>
            </Link>
          </>
        }
      />
      <Page>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Active" value={progress?.enrollments?.active} />
          <Stat label="Completed" value={progress?.enrollments?.completed} />
          <Stat label="Stopped" value={progress?.enrollments?.stopped} />
          <Stat label="Due now" value={progress?.due_now} />
          <Stat label="Released today" value={progress?.released_today} />
          <Stat label="Daily cap" value={progress?.daily_cap ?? "—"} />
          <Stat label="Timezone" value={progress?.timezone} />
          <Stat label="Window" value={progress?.send_time ?? "any time"} />
        </div>

        <Card className="p-4 flex flex-wrap items-end gap-3">
          <div>
            <Label>Enrol audience (configured on the edit page)</Label>
            <div className="flex gap-2">
              <Button onClick={() => enrol.mutate("restart")}>Enrol (restart mode)</Button>
              <Button variant="outline" onClick={() => enrol.mutate("resume")}>
                Enrol (resume mode)
              </Button>
            </div>
          </div>
          <div className="grow" />
          <div className="text-sm">
            {preview && preview.pending_steps.length > 0 ? (
              <div className="flex items-center gap-3">
                <span className="text-[var(--muted)]">
                  {preview.would_qualify} completed contact(s) would newly qualify ·{" "}
                  {preview.remain_active} remain active
                </span>
                <Button onClick={() => confirm.mutate()} disabled={confirm.isPending}>
                  Confirm release
                </Button>
              </div>
            ) : (
              <span className="text-[var(--muted)]">No steps awaiting release.</span>
            )}
          </div>
        </Card>

        <Card className="p-4 space-y-3">
          <div>
            <div className="text-sm font-medium">Enrol a form's existing submissions</div>
            <div className="text-[var(--muted)] text-xs mt-1">
              Enrols the submissions already recorded for a form slug — only consent-accepted, non-suppressed,
              sendable addresses that are <b>not yet enrolled</b>. A draft sequence captures and holds them.
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label>Form slug</Label>
              <Select value={formSlug} onChange={(e) => { setFormSlug(e.target.value); setFormPreview(null); }} className="max-w-[18rem]">
                <option value="">Choose a form…</option>
                {(formSlugs.data?.slugs ?? []).map((s: any) => (
                  <option key={s.slug} value={s.slug}>
                    {s.slug} ({s.submission_count} submission{s.submission_count === 1 ? "" : "s"})
                  </option>
                ))}
              </Select>
            </div>
            <Button variant="outline" disabled={!formSlug || previewForm.isPending} onClick={() => previewForm.mutate()}>
              Preview
            </Button>
            {formPreview && (
              <Button disabled={enrolForm.isPending || formPreview.would_enroll === 0} onClick={() => enrolForm.mutate()}>
                Confirm enrol {formPreview.would_enroll}
              </Button>
            )}
          </div>
          {formPreview && (
            <div className="text-sm">
              <div>
                <b>{formPreview.would_enroll}</b> would enrol
                {formPreview.held ? " and be held until activation" : ""} · {formPreview.submissions_total} submission(s)
                · {formPreview.distinct_contacts} unique address(es)
              </div>
              {formPreview.skipped_total > 0 && (
                <ul className="text-xs text-[var(--muted)] mt-1 list-disc list-inside">
                  {Object.entries(formPreview.skipped ?? {}).map(([reason, n]) => (
                    <li key={reason}>
                      {Number(n)} skipped — {reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Card>

        <Card className="p-4 space-y-3">
          <div className="text-sm font-medium">Test mode — run the whole sequence to one address</div>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label>Address</Label>
              <Input
                placeholder="you@example.com"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
              />
            </div>
            <div>
              <Label>Compress waits to (minutes)</Label>
              <Input
                type="number"
                value={testMinutes}
                onChange={(e) => setTestMinutes(e.target.value)}
                className="w-28"
              />
            </div>
            <Button
              variant="outline"
              onClick={() => test.mutate()}
              disabled={!testEmail || test.isPending}
            >
              Send test run
            </Button>
          </div>
          <p className="text-xs text-[var(--muted)]">
            Test sends create no enrolments and never touch the metrics — they are recorded separately.
          </p>
        </Card>

        <Card>
          <div className="px-5 py-3 text-sm font-medium border-b border-[var(--border)]">
            Per-step funnel
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-[var(--muted)] border-b border-[var(--border)]">
              <tr>
                <th className="px-5 py-3">Step</th>
                <th className="px-5 py-3">Released</th>
                <th className="px-5 py-3">Sent</th>
                <th className="px-5 py-3">Delivered</th>
                <th className="px-5 py-3">Opened</th>
                <th className="px-5 py-3">Clicked</th>
                <th className="px-5 py-3">Bounced</th>
                <th className="px-5 py-3">Unsub</th>
              </tr>
            </thead>
            <tbody>
              {(metrics.data?.steps ?? []).map((m: any) => {
                const reach = metrics.data?.funnel?.find((f: any) => f.position === m.position)?.reached ?? 0;
                return (
                  <tr key={m.position} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-5 py-3">
                      {m.name ?? `Step ${m.position}`}{" "}
                      <span className="text-[var(--muted)] font-mono">#{m.position}</span>
                    </td>
                    <td className="px-5 py-3">{reach}</td>
                    <td className="px-5 py-3">{m.sent}</td>
                    <td className="px-5 py-3">{m.delivered}</td>
                    <td className="px-5 py-3">{m.opened}</td>
                    <td className="px-5 py-3">{m.clicked}</td>
                    <td className="px-5 py-3">{m.bounced}</td>
                    <td className="px-5 py-3">{m.unsubscribed}</td>
                  </tr>
                );
              })}
              {(metrics.data?.steps ?? []).length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-8 text-center text-[var(--muted)]">
                    No steps.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>

        <Card>
          <div className="px-5 py-3 text-sm font-medium border-b border-[var(--border)] flex items-center justify-between">
            <span>Enrolments</span>
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-40">
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="stopped">Stopped</option>
              <option value="removed">Removed</option>
            </Select>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-[var(--muted)] border-b border-[var(--border)]">
              <tr>
                <th className="px-5 py-3">Contact</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Last sent</th>
                <th className="px-5 py-3">Next step</th>
                <th className="px-5 py-3">Next due</th>
                <th className="px-5 py-3">History</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {(enrolments.data?.rows ?? []).map((r: any) => (
                <tr key={r.id} className="border-b border-[var(--border)] last:border-0 align-top">
                  <td className="px-5 py-3">
                    <div>{r.name ?? r.email}</div>
                    <div className="text-xs text-[var(--muted)] font-mono">{r.email}</div>
                  </td>
                  <td className="px-5 py-3">
                    <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                    {r.stop_reason && (
                      <div className="text-xs text-[var(--muted)] mt-1">{r.stop_reason}</div>
                    )}
                  </td>
                  <td className="px-5 py-3 text-[var(--muted)]">
                    {r.last_sent_position ? `#${r.last_sent_position}` : "—"}
                  </td>
                  <td className="px-5 py-3 text-[var(--muted)]">
                    {r.next_step_position != null ? `#${r.next_step_position}` : "—"}
                  </td>
                  <td className="px-5 py-3 text-[var(--muted)]">
                    {r.next_due_at ? new Date(r.next_due_at * 1000).toLocaleString() : "—"}
                  </td>
                  <td className="px-5 py-3 text-xs text-[var(--muted)]">
                    {r.history.slice(0, 4).map((h: any, i: number) => (
                      <div key={i}>
                        {h.type}
                        {h.detail ? ` · ${h.detail}` : ""}
                      </div>
                    ))}
                  </td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    <Button variant="ghost" onClick={() => reenrol.mutate({ eid: r.id, mode: "resume" })}>
                      Resume
                    </Button>
                    <Button variant="ghost" onClick={() => reenrol.mutate({ eid: r.id, mode: "restart" })}>
                      Restart
                    </Button>
                    <Button variant="ghost" onClick={() => remove.mutate(r.id)}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
              {(enrolments.data?.rows ?? []).length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-[var(--muted)]">
                    No enrolments.
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

function Stat({ label, value }: { label: string; value: any }) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="text-lg font-semibold mt-1">{value ?? "—"}</div>
    </Card>
  );
}
