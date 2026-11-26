import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { Page, PageHeader, Card, Button, Badge } from "../components/ui";
import { errorOf, fieldArray, rowsOf } from "../safeData";


export default function Templates() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const local = useQuery({ queryKey: ["templates"], queryFn: () => api("/api/templates") });

  const remote = useQuery({ queryKey: ["smtp2go-templates"], queryFn: () => api("/api/smtp2go/templates") });
  const localRows = rowsOf(local.data);
  const remoteTemplates = fieldArray(remote.data, "templates");
  const remoteError = errorOf(remote.data);
  const blankSmtp2goCount = localRows.filter(
    (t: any) => t.source === "smtp2go" && !(t.subject && t.subject.length),
  ).length;

  const cleanupBlanks = useMutation({
    mutationFn: () => api(`/api/smtp2go/templates/cleanup-blank-imports`, { method: "POST" }),
    onSuccess: (r: any) => {
      toast.success(`Removed ${r.deleted ?? 0} blank SMTP2GO rows`);
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (e) => toast.error(String(e)),
  });

  const duplicate = useMutation({
    mutationFn: (tid: number) => api(`/api/templates/${tid}/duplicate`, { method: "POST" }),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ["templates"] });
      toast.success("Template duplicated");
      nav(`/templates/${r.id}`);
    },
    onError: (e) => toast.error(String(e)),
  });

  const copyId = (id: string) => {
    navigator.clipboard?.writeText(id).then(
      () => toast.success("Template ID copied"),
      () => toast.error("Copy failed"),
    );
  };


  return (
    <>
      <PageHeader
        title="Templates"
        actions={<Link to="/templates/new"><Button>New local template</Button></Link>}
      />
      <Page>
        <Card>
          <div className="px-5 py-4 border-b border-[var(--border)] font-medium flex items-center justify-between">
            <span>Local templates</span>
            {blankSmtp2goCount > 0 && (
              <Button variant="outline" onClick={() => cleanupBlanks.mutate()} disabled={cleanupBlanks.isPending}>
                Remove {blankSmtp2goCount} blank SMTP2GO import{blankSmtp2goCount === 1 ? "" : "s"}
              </Button>
            )}
          </div>
          <table className="w-full text-sm">
            <tbody>
              {localRows.map((t: any) => (
                <tr key={t.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-5 py-3">
                    <Link to={`/templates/${t.id}`} className="font-medium hover:text-[var(--primary)]">{t.name}</Link>
                    <div className="text-xs text-[var(--muted)]">{t.subject || <em>no subject</em>}</div>
                  </td>
                  <td className="px-5 py-3"><Badge tone={t.source === "smtp2go" ? "blue" : "default"}>{t.source}</Badge></td>
                  <td className="px-5 py-3 text-right text-[var(--muted)] text-xs">{new Date(t.updated_at * 1000).toLocaleDateString()}</td>
                  <td className="px-5 py-3 text-right">
                    <Button
                      variant="outline"
                      onClick={() => duplicate.mutate(t.id)}
                      disabled={duplicate.isPending}
                    >
                      Duplicate
                    </Button>
                  </td>

                </tr>
              ))}
              {!local.isLoading && localRows.length === 0 && !local.isError && (
                <tr><td colSpan={4} className="px-5 py-10 text-center text-[var(--muted)]">No local templates yet.</td></tr>
              )}
              {local.isError && (
                <tr><td colSpan={4} className="px-5 py-4 text-sm text-red-400">Templates API unavailable.</td></tr>
              )}

            </tbody>
          </table>
        </Card>

        <Card>
          <div className="px-5 py-4 border-b border-[var(--border)] font-medium flex items-center justify-between">
            <span>SMTP2GO templates (rendered by SMTP2GO)</span>
            <span className="text-xs text-[var(--muted)]">Pick directly in a campaign — no import needed</span>
          </div>
          {remote.isError && (
            <div className="px-5 py-4 text-sm text-red-400">SMTP2GO API not reachable — check SMTP2GO_API_KEY secret.</div>
          )}
          <table className="w-full text-sm">
            <tbody>
              {remoteTemplates.map((t: any) => (
                <tr key={t.template_id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-5 py-3">
                    <div className="font-medium">{t.templatename || t.name || "(untitled)"}</div>
                    <div className="text-xs text-[var(--muted)]">{t.subject || <em>no subject</em>}</div>
                    <div className="text-xs text-[var(--muted)] font-mono">{t.template_id}</div>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Button variant="outline" onClick={() => copyId(t.template_id)}>Copy ID</Button>
                  </td>
                </tr>
              ))}
              {remoteError && (
                <tr><td colSpan={2} className="px-5 py-4 text-sm text-red-400">SMTP2GO: {remoteError}</td></tr>
              )}
              {!remote.isLoading && !remoteError && remoteTemplates.length === 0 && (
                <tr><td className="px-5 py-10 text-center text-[var(--muted)]">No SMTP2GO templates.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </Page>
    </>
  );
}
