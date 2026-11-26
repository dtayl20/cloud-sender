import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { Page, PageHeader, Card, Input, Button, Label } from "../components/ui";
import { EmailEditor, type EmailEditorValue } from "../components/EmailEditor";

export default function TemplateEdit() {
  const { id } = useParams();
  const nav = useNavigate();
  const editing = id && id !== "new";
  const { data } = useQuery({
    queryKey: ["template", id],
    queryFn: () => api(`/api/templates/${id}`),
    enabled: !!editing,
  });

  const [form, setForm] = useState<EmailEditorValue & { name: string }>({
    name: "",
    subject: "",
    html: "",
    text: "",
    isBase: 0,
  });
  const loaded = useRef(false);

  useEffect(() => {
    if (!data?.row || loaded.current) return;
    loaded.current = true;
    const row = data.row;
    setForm({
      name: row.name,
      subject: row.subject,
      html: row.html ?? "",
      text: row.text ?? "",
      isBase: row.is_base ? 1 : 0,
    });
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api(`/api/templates/${id}`, {
            method: "PATCH",
            body: JSON.stringify({
              name: form.name,
              subject: form.subject,
              html: form.html,
              text: form.text,
              is_base: form.isBase ?? 0,
            }),
          })
        : api(`/api/templates`, {
            method: "POST",
            body: JSON.stringify({
              name: form.name,
              subject: form.subject,
              html: form.html,
              text: form.text,
              is_base: form.isBase ?? 0,
              source: "local",
            }),
          }),
    onSuccess: () => {
      toast.success("Saved");
      nav("/templates");
    },
    onError: (e) => toast.error(String(e)),
  });

  const duplicate = useMutation({
    mutationFn: () => api(`/api/templates/${id}/duplicate`, { method: "POST" }),
    onSuccess: (r: any) => {
      toast.success("Template duplicated");
      loaded.current = false;
      nav(`/templates/${r.id}`);
    },
    onError: (e) => toast.error(String(e)),
  });

  // Mount the editor only once the row is loaded (edit) so it seeds from the
  // stored body; `key` makes it remount per template.
  if (editing && !data?.row) {
    return <Page>{data === undefined ? "Loading…" : "Not found."}</Page>;
  }

  return (
    <>
      <PageHeader
        title={editing ? "Edit template" : "New template"}
        actions={
          <div className="flex gap-2">
            {editing && (
              <Button variant="outline" onClick={() => duplicate.mutate()} disabled={duplicate.isPending}>
                Duplicate
              </Button>
            )}
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              Save
            </Button>
          </div>
        }
      />
      <Page>
        <Card className="p-4">
          <Label>Name</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="max-w-md" />
        </Card>
        <EmailEditor
          key={editing ? `t${id}` : "new"}
          value={form}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          showBaseToggle
        />
      </Page>
    </>
  );
}
