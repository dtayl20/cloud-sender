import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { Page, PageHeader, Card, Input, Button, Badge, Select, Label, statusTone } from "../components/ui";
import { EmailEditor } from "../components/EmailEditor";
import { htmlToText, mergeBody, plainTextToHtml } from "../../shared/body";
import { CollapsibleSection } from "../components/Collapsible";

const WEEKDAYS = [
  { v: 1, l: "Mon" },
  { v: 2, l: "Tue" },
  { v: 3, l: "Wed" },
  { v: 4, l: "Thu" },
  { v: 5, l: "Fri" },
  { v: 6, l: "Sat" },
  { v: 7, l: "Sun" },
];

interface EditorState {
  subject: string;
  html: string;
  text: string;
}

/**
 * The three step columns the editor owns. The content is plain text; `content_html`
 * holds it as paragraph HTML (what the send merges at the template's
 * {{content}}) and is NULL when the box is blank.
 */
const stepBody = (e: EditorState) => ({
  subject: e.subject,
  content_html: e.html.trim() ? e.html : null,
  content_text: e.text.trim() ? e.text : null,
});

const editorOf = (step: any): EditorState => {
  // The step body is edited as plain text. A step saved before that (or seeded
  // from a template) may hold HTML: read it back as text, and re-wrap it as
  // <p> paragraphs so nothing shows raw markup in the box.
  const text = (step?.content_text ?? "").trim()
    ? step.content_text
    : step?.content_html
      ? htmlToText(step.content_html)
      : "";
  return { subject: step?.subject ?? "", html: plainTextToHtml(text), text };
};

export default function SequenceEdit() {
  const { id } = useParams();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["sequence", id], queryFn: () => api(`/api/sequences/${id}`) });
  const lists = useQuery({ queryKey: ["lists"], queryFn: () => api("/api/lists") });
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api("/api/templates") });
  const identities = useQuery({
    queryKey: ["sender-identities"],
    queryFn: () => api("/api/sender-identities"),
  });

  const seq = detail.data?.sequence;
  const steps: any[] = detail.data?.steps ?? [];
  const identityRows: any[] = identities.data?.rows ?? [];

  const [form, setForm] = useState<any>({});
  useEffect(() => {
    if (seq) {
      setForm({
        name: seq.name,
        audience: seq.segment_id ? `seg:${seq.segment_id}` : seq.list_id ? `list:${seq.list_id}` : "",
        sender_identity_id: seq.sender_identity_id != null ? String(seq.sender_identity_id) : "",
        from_email: seq.from_email ?? "",
        from_name: seq.from_name ?? "",
        reply_to: seq.reply_to ?? "",
        daily_cap: seq.daily_cap ?? "",
        send_days: seq.send_days ?? "",
        send_time: seq.send_time ?? "",
        send_timezone: seq.send_timezone ?? "",
        ramp_start: seq.ramp_start ?? "",
        ramp_days: seq.ramp_days ?? "",
        spread_minutes: seq.spread_minutes ?? "",
      });
    }
  }, [seq?.id]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["sequence", id] });

  const save = useMutation({
    mutationFn: () => {
      const aud = String(form.audience ?? "");
      const num = (v: any) => (v === "" || v == null ? null : Number(v));
      return api(`/api/sequences/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name,
          list_id: aud.startsWith("list:") ? Number(aud.slice(5)) : null,
          segment_id: aud.startsWith("seg:") ? Number(aud.slice(4)) : null,
          sender_identity_id: form.sender_identity_id ? Number(form.sender_identity_id) : null,
          from_email: form.from_email || null,
          from_name: form.from_name || null,
          reply_to: form.reply_to || null,
          daily_cap: num(form.daily_cap),
          send_days: form.send_days || null,
          send_time: form.send_time || null,
          send_timezone: form.send_timezone || null,
          ramp_start: num(form.ramp_start),
          ramp_days: num(form.ramp_days),
          spread_minutes: num(form.spread_minutes),
        }),
      });
    },
    onSuccess: () => {
      toast.success("Saved");
      invalidate();
      qc.invalidateQueries({ queryKey: ["sequences"] });
    },
    onError: (e) => toast.error(String(e)),
  });

  const setStatus = useMutation({
    mutationFn: (status: string) =>
      api(`/api/sequences/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }),
    onSuccess: () => {
      toast.success("Status updated");
      invalidate();
    },
    onError: (e) => toast.error(String(e)),
  });

  const [step, setStep] = useState<any>({ name: "", wait_hours: "0", after: "" });
  const addStep = useMutation({
    mutationFn: () =>
      api(`/api/sequences/${id}/steps`, {
        method: "POST",
        body: JSON.stringify({
          name: step.name || null,
          wait_minutes: Math.round(Number(step.wait_hours || 0) * 60),
          after_position: step.after ? Number(step.after) : null,
        }),
      }),
    onSuccess: (r: any) => {
      toast.success("Step added");
      setStep({ name: "", wait_hours: "0", after: "" });
      invalidate();
      if (r?.id) setSelectedStepId(Number(r.id));
    },
    onError: (e) => toast.error(String(e)),
  });

  const patchStep = useMutation({
    mutationFn: ({ stepId, body }: any) =>
      api(`/api/sequences/${id}/steps/${stepId}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(String(e)),
  });

  const delStep = useMutation({
    mutationFn: (stepId: number) => api(`/api/sequences/${id}/steps/${stepId}`, { method: "DELETE" }),
    onSuccess: (_r, stepId) => {
      toast.success("Step removed");
      if (selectedStepId === stepId) setSelectedStepId(null);
      invalidate();
    },
  });

  const testStep = useMutation({
    mutationFn: ({ stepId, email }: any) =>
      api(`/api/sequences/${id}/steps/${stepId}/test`, { method: "POST", body: JSON.stringify({ email }) }),
    onSuccess: () => toast.success("Test queued — check the inbox shortly."),
    onError: (e) => toast.error(String(e)),
  });

  // The step whose email is open in the full-screen editor; null = closed.
  const [selectedStepId, setSelectedStepId] = useState<number | null>(null);
  const [editor, setEditor] = useState<EditorState>({ subject: "", html: "", text: "" });
  const [insertTemplateId, setInsertTemplateId] = useState("");
  const [panelTab, setPanelTab] = useState<"body" | "preview" | "variables">("body");
  const [templateName, setTemplateName] = useState("");
  // The step the editor state was last seeded from, so reopening the SAME step
  // keeps unsaved edits instead of reloading the saved copy.
  const seededStepRef = useRef<number | null>(null);

  const selectedStep = steps.find((s) => s.id === selectedStepId) ?? null;
  const emailOpen = selectedStepId != null;

  // The template attached to this step (the campaign model): the step's typed
  // content goes into its {{content}} slot. With no template the content IS the
  // whole email body. The name is for the UI so a blank box does not read as
  // "nothing selected".
  const attachedTemplateId = selectedStep?.template_id ?? null;
  const attachedTemplate = useQuery({
    queryKey: ["template", attachedTemplateId],
    queryFn: () => api(`/api/templates/${attachedTemplateId}`),
    enabled: attachedTemplateId != null,
  });
  const attachedTemplateName =
    (templates.data?.rows ?? []).find((t: any) => t.id === attachedTemplateId)?.name ??
    (attachedTemplateId != null ? `#${attachedTemplateId}` : null);
  // Preview = the attached template with this step's content in it, so the blank
  // box plus a filled preview stay coherent.
  const stepPreviewHtml = attachedTemplateId
    ? mergeBody(String(attachedTemplate.data?.row?.html ?? ""), plainTextToHtml(editor.text))
    : plainTextToHtml(editor.text);

  // Opening a step drops into the full-screen editor: Escape or a scrim click
  // closes it, and the page behind stays locked while it is open.
  useEffect(() => {
    if (!emailOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedStepId(null);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [emailOpen]);

  useEffect(() => {
    if (selectedStepId == null) return;
    // Reopening the step already in the editor keeps its unsaved edits; a
    // different step (or the first open) seeds from the stored copy.
    if (seededStepRef.current === selectedStepId) return;
    const s = steps.find((x) => x.id === selectedStepId);
    if (s) {
      setEditor(editorOf(s));
      setTemplateName((s.name ?? "Step") + " template");
      seededStepRef.current = selectedStepId;
    }
    // Reseed only when the selected step changes, not on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStepId]);

  const saveStepCopy = useMutation({
    mutationFn: () =>
      patchStep.mutateAsync({ stepId: selectedStepId, body: stepBody(editor) }),
    onSuccess: () => toast.success("Step saved"),
    onError: (e) => toast.error(String(e)),
  });

  // Attach a template to the step — a selector, exactly like a campaign picking
  // its base template. Nothing is copied into the content box: it stays blank so
  // the operator types this step's own email. At send the content merges into the
  // template at {{content}} (see consumer.ts).
  const attachTemplate = async () => {
    if (!insertTemplateId || selectedStepId == null) return;
    try {
      setEditor((e) => ({ ...e, html: "", text: "" }));
      await patchStep.mutateAsync({
        stepId: selectedStepId,
        body: { template_id: Number(insertTemplateId), content_html: null, content_text: null },
      });
      toast.success("Template attached — type this step's content");
    } catch (e) {
      toast.error(String(e));
    }
  };

  const saveAsTemplate = useMutation({
    mutationFn: () =>
      api("/api/templates", {
        method: "POST",
        body: JSON.stringify({
          name: templateName || "Sequence step template",
          subject: editor.subject,
          html: editor.html,
          text: editor.text,
          source: "local",
        }),
      }),
    onSuccess: () => {
      toast.success("Saved as a template");
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (e) => toast.error(String(e)),
  });

  if (!seq) return <Page>{detail.isLoading ? "Loading…" : "Not found."}</Page>;

  const releaseTo = (s: any) =>
    s.released_to_completed_at ? new Date(s.released_to_completed_at * 1000).toLocaleDateString() : null;

  const planSummary = `${form.sender_identity_id ? identityRows.find((i) => String(i.id) === String(form.sender_identity_id))?.name ?? "identity" : "default sender"} · ${
    form.daily_cap ? `${form.daily_cap}/day` : "no cap"
  }`;
  const stepsSummary = `${steps.length} step(s)`;

  return (
    <>
      <PageHeader
        title={`Edit: ${seq.name}`}
        subtitle={`${steps.length} step(s) · audience ${detail.data?.audience_count ?? "—"}`}
        actions={
          <>
            <Badge tone={statusTone(seq.status)}>{seq.status}</Badge>
            {seq.status !== "active" ? (
              <Button onClick={() => setStatus.mutate("active")}>Activate</Button>
            ) : (
              <Button variant="outline" onClick={() => setStatus.mutate("paused")}>
                Pause
              </Button>
            )}
            <Link to={`/sequences/${id}`}>
              <Button variant="ghost">Detail</Button>
            </Link>
          </>
        }
      />
      <Page>
        {/* ---------------- builder (single column) ---------------- */}
        <div className="space-y-6 min-w-0">
            <CollapsibleSection id={`sequence.plan.${id}`} title="Sequence" summary={planSummary}>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <Label>Name</Label>
                  <Input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div>
                  <Label>Audience</Label>
                  <Select
                    value={form.audience ?? ""}
                    onChange={(e) => setForm({ ...form, audience: e.target.value })}
                  >
                    <option value="">All active contacts</option>
                    {(lists.data?.rows ?? []).map((l: any) => (
                      <option key={l.id} value={`${l.kind === "segment" ? "seg" : "list"}:${l.id}`}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label>Sender identity</Label>
                  <Select
                    value={form.sender_identity_id ?? ""}
                    onChange={(e) => setForm({ ...form, sender_identity_id: e.target.value })}
                  >
                    <option value="">Default identity (fallback)</option>
                    {identityRows.map((i: any) => (
                      <option key={i.id} value={i.id}>
                        {i.name} — {i.from_email}
                        {i.is_default ? " (default)" : ""}
                        {i.enabled ? "" : " (disabled)"}
                      </option>
                    ))}
                  </Select>
                  {identityRows.length === 0 && (
                    <p className="text-xs text-[var(--muted)] mt-1">
                      No sender identities yet — add one in Settings.
                    </p>
                  )}
                </div>
              </div>

              <details className="mt-1">
                <summary className="cursor-pointer text-xs uppercase tracking-wide text-[var(--muted)]">
                  Legacy sender fallback (used only when no identity resolves)
                </summary>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
                  <div>
                    <Label>From email</Label>
                    <Input
                      value={form.from_email ?? ""}
                      onChange={(e) => setForm({ ...form, from_email: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>From name</Label>
                    <Input
                      value={form.from_name ?? ""}
                      onChange={(e) => setForm({ ...form, from_name: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Reply-To</Label>
                    <Input
                      value={form.reply_to ?? ""}
                      onChange={(e) => setForm({ ...form, reply_to: e.target.value })}
                    />
                  </div>
                </div>
              </details>

              <div className="text-xs uppercase tracking-wide text-[var(--muted)] pt-2">
                Sending plan (per sequence — same ramp/spread settings as campaigns)
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <Label>Daily cap</Label>
                  <Input
                    type="number"
                    value={form.daily_cap ?? ""}
                    onChange={(e) => setForm({ ...form, daily_cap: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Send days (1=Mon…7=Sun)</Label>
                  <Input
                    placeholder="1,2,3,4,5"
                    value={form.send_days ?? ""}
                    onChange={(e) => setForm({ ...form, send_days: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Send time (local, HH:MM)</Label>
                  <Input
                    placeholder="09:00"
                    value={form.send_time ?? ""}
                    onChange={(e) => setForm({ ...form, send_time: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Fallback timezone</Label>
                  <Input
                    placeholder="Australia/Brisbane"
                    value={form.send_timezone ?? ""}
                    onChange={(e) => setForm({ ...form, send_timezone: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Ramp start</Label>
                  <Input
                    type="number"
                    value={form.ramp_start ?? ""}
                    onChange={(e) => setForm({ ...form, ramp_start: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Ramp days</Label>
                  <Input
                    type="number"
                    value={form.ramp_days ?? ""}
                    onChange={(e) => setForm({ ...form, ramp_days: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Spread (minutes)</Label>
                  <Input
                    type="number"
                    value={form.spread_minutes ?? ""}
                    onChange={(e) => setForm({ ...form, spread_minutes: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <Button onClick={() => save.mutate()} disabled={save.isPending}>
                  Save sequence
                </Button>
              </div>
            </CollapsibleSection>

            <CollapsibleSection id={`sequence.steps.${id}`} title="Steps" summary={stepsSummary}>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-[var(--muted)] border-b border-[var(--border)]">
                  <tr>
                    <th className="px-3 py-2">Position</th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Wait (hours)</th>
                    <th className="px-3 py-2">Subject</th>
                    <th className="px-3 py-2">Released</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {steps.map((s: any) => (
                    <StepRow
                      key={s.id}
                      step={s}
                      selected={s.id === selectedStepId}
                      onSelect={() => setSelectedStepId(s.id)}
                      onSave={(body: any) => patchStep.mutate({ stepId: s.id, body })}
                      onDelete={() => delStep.mutate(s.id)}
                      released={releaseTo(s)}
                    />
                  ))}
                  {steps.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-[var(--muted)]">
                        No steps yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              </div>

              <div className="text-sm font-medium pt-2">Add step</div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                <div>
                  <Label>Name</Label>
                  <Input value={step.name} onChange={(e) => setStep({ ...step, name: e.target.value })} />
                </div>
                <div>
                  <Label>Wait (hours after previous)</Label>
                  <Input
                    type="number"
                    value={step.wait_hours}
                    onChange={(e) => setStep({ ...step, wait_hours: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Insert after position</Label>
                  <Input
                    placeholder="(append)"
                    value={step.after}
                    onChange={(e) => setStep({ ...step, after: e.target.value })}
                  />
                </div>
                <Button onClick={() => addStep.mutate()} disabled={addStep.isPending}>
                  Add step
                </Button>
              </div>
              <p className="text-xs text-[var(--muted)]">
                Waits are relative to the previous step's send (step 1 is measured from enrolment). Inserting a step
                mid-sequence is skipped by anyone who already passed that position. Edit each step's email in the panel
                on the right.
              </p>
            </CollapsibleSection>
        </div>
      </Page>
      {emailOpen && selectedStep && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex p-3 md:p-6 overflow-auto"
          role="dialog"
          aria-modal="true"
          onMouseDown={() => setSelectedStepId(null)}
        >
          <Card
            className="m-auto w-full h-full max-w-[1500px] flex flex-col gap-3 min-h-0"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 shrink-0">
              <div className="text-sm font-medium">
                Step email · #{selectedStep.position}
                {selectedStep.name ? ` · ${selectedStep.name}` : ""}
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={selectedStep.content_html ? "green" : "default"}>
                  {selectedStep.content_html ? "has content" : "no content yet"}
                </Badge>
                <Button variant="outline" onClick={() => setSelectedStepId(null)}>
                  Close
                </Button>
              </div>
            </div>

            <div className="flex gap-1 p-0.5 rounded-md bg-[var(--background)] border border-[var(--border)] w-fit shrink-0">
              {([["body", "Body"], ["preview", "Preview"], ["variables", "Variables"]] as const).map(([t, label]) => (
                <Button
                  key={t}
                  variant={panelTab === t ? "primary" : "ghost"}
                  className="!px-3 !py-1 text-xs"
                  onClick={() => setPanelTab(t)}
                >
                  {label}
                </Button>
              ))}
            </div>

            {panelTab === "body" && (
              <div className="shrink-0">
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <Label>Template</Label>
                    <Select value={insertTemplateId} onChange={(e) => setInsertTemplateId(e.target.value)} className="max-w-[16rem]">
                      <option value="">Choose a template…</option>
                      {(templates.data?.rows ?? []).map((t: any) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button variant="outline" onClick={attachTemplate} disabled={!insertTemplateId}>
                    Attach
                  </Button>
                </div>
                <p className="text-xs text-[var(--muted)] mt-1">
                  Attaching only links the template — the content box stays blank for you to type this step's email. At
                  send, your text goes into the template at <code>{"{{"}{"content"}{"}}"}</code>.
                </p>
                <p className="text-xs text-[var(--muted)] mt-1">
                  {attachedTemplateId ? (
                    <>
                      Attached template: <span className="text-white">{attachedTemplateName}</span> — your content goes
                      into its <code>{"{{"}{"content"}{"}}"}</code> slot.
                    </>
                  ) : (
                    <>No template attached — the content is the whole email body.</>
                  )}
                </p>
              </div>
            )}

            <div className="flex-1 min-h-0">
              <EmailEditor
                key={selectedStepId}
                layout={panelTab === "body" ? "editor" : panelTab === "preview" ? "preview" : "variables"}
                plainTextOnly
                previewHtml={stepPreviewHtml}
                value={{ subject: editor.subject, html: editor.html, text: editor.text, isBase: 0 }}
                onChange={(patch) => setEditor((e) => ({ ...e, ...patch }))}
                testSend={
                  panelTab === "body"
                    ? {
                        onSend: (email) => testStep.mutate({ stepId: selectedStepId, email }),
                        pending: testStep.isPending,
                        hint: "Test sends render this step only; they create no enrolment and touch no metric.",
                      }
                    : undefined
                }
              />
            </div>

            <div className="flex flex-wrap items-end gap-2 border-t border-[var(--border)] pt-3 shrink-0">
              <div>
                <Label>Template name</Label>
                <Input
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  className="max-w-[16rem]"
                />
              </div>
              <Button variant="outline" onClick={() => saveAsTemplate.mutate()} disabled={saveAsTemplate.isPending}>
                Save as template
              </Button>
              <div className="grow" />
              <Button onClick={() => saveStepCopy.mutate()} disabled={saveStepCopy.isPending}>
                Save step
              </Button>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

function StepRow({ step, selected, onSelect, onSave, onDelete, released }: any) {
  const [name, setName] = useState(step.name ?? "");
  const [hours, setHours] = useState((step.wait_minutes / 60).toString());
  return (
    <tr
      className={`border-b border-[var(--border)] last:border-0 ${
        selected ? "bg-[var(--accent)]/40" : ""
      }`}
    >
      <td className="px-3 py-2 font-mono text-[var(--muted)]">{step.position}</td>
      <td className="px-3 py-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </td>
      <td className="px-3 py-2 w-24">
        <Input type="number" value={hours} onChange={(e) => setHours(e.target.value)} />
      </td>
      <td className="px-3 py-2 text-[var(--muted)]">
        {step.content_html ? (
          step.subject || <em>no subject</em>
        ) : (
          <span className="text-amber-400 text-xs">no email content</span>
        )}
      </td>
      <td className="px-3 py-2 text-[var(--muted)]">{released ?? "—"}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        <Button variant={selected ? "primary" : "outline"} className="!px-2.5 !py-1 text-xs" onClick={onSelect}>
          Edit email
        </Button>
        <Button
          variant="ghost"
          className="!px-2.5 !py-1 text-xs"
          onClick={() =>
            onSave({ name: name || null, wait_minutes: Math.round(Number(hours || 0) * 60) })
          }
        >
          Save
        </Button>
        <Button variant="ghost" className="!px-2.5 !py-1 text-xs" onClick={onDelete}>
          Delete
        </Button>
      </td>
    </tr>
  );
}
