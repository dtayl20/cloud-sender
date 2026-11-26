import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Page, PageHeader, Card, Badge, Button, Input } from "../components/ui";
import { DeliverabilityPanel } from "../components/DeliverabilityPanel";
import { domainOfEmail } from "../../shared/deliverability";
import { api } from "../api";

type SettingsResponse = {
  db_configured?: boolean;
  settings_table_configured?: boolean;
  settings_error?: string;
  smtp2go_configured?: boolean;
  webhook_token_configured?: boolean;
  source_db_configured?: boolean;
  send_queue_configured?: boolean;
  env_default_from_email?: string;
  env_default_from_name?: string;
  expected_bindings?: Record<string, string>;
  expected_secrets?: Record<string, string>;
  /** Re-verify cadence in days (settings key email_verify_stale_days). */
  email_verify_stale_days?: number;
  /** Cron verification pause switch (settings key email_verify_paused). */
  email_verify_paused?: boolean;
  /** The VERIFY_PAUSED env override, if set. */
  env_verify_paused?: boolean;
  /** Last credits-remaining figure the verification API reported. */
  email_verify_credits_remaining?: number;
  /** Form slug -> sequence id map (settings key form_sequence_map). */
  form_sequence_map?: Record<string, number> | null;
};

async function fetchSettings(): Promise<SettingsResponse> {
  const res = await fetch("/api/settings", { headers: { Accept: "application/json" } });
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";

  if (!res.ok) {
    throw new Error(`Settings API returned HTTP ${res.status}`);
  }

  if (contentType.includes("text/html") || text.trimStart().startsWith("<!doctype html") || text.trimStart().startsWith("<html")) {
    throw new Error("Settings API returned the frontend app instead of Worker JSON. Deploy or preview the Cloudflare Worker runtime, then refresh.");
  }

  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("Settings API returned invalid JSON.");
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Settings API returned an unexpected response.");
  }

  return data as SettingsResponse;
}

export default function SettingsPage() {
  const { data, error, isLoading } = useQuery({ queryKey: ["settings"], queryFn: fetchSettings, retry: 1 });
  const apiReady = Boolean(data) && !error;
  const dbReady = apiReady && Boolean(data?.db_configured);
  const settingsReady = dbReady && Boolean(data?.settings_table_configured);
  // Deliverability checks are per-domain, so the panel owns a domain input.
  // It starts on the Worker's DEFAULT_FROM_EMAIL domain, which is the domain
  // mail actually goes out as when a campaign sets nothing else.
  const [checkDomain, setCheckDomain] = useState("");
  const [domainSeeded, setDomainSeeded] = useState(false);
  useEffect(() => {
    if (domainSeeded || !data) return;
    const d = domainOfEmail(data.env_default_from_email ?? null);
    if (d) setCheckDomain(d);
    setDomainSeeded(true);
  }, [data, domainSeeded]);

  return (
    <>
      <PageHeader title="Settings" subtitle="Worker configuration (read-only)" />
      <Page>
        <Card className="p-5 grid gap-3 text-sm">
          <Row
            label="Settings API"
            value={
              isLoading ? <Badge tone="blue">checking</Badge>
                : error ? <Badge tone="amber">runtime unavailable</Badge>
                  : <Badge tone="green">connected</Badge>
            }
          />
          {error && <div className="text-[var(--muted)] text-xs leading-5">{error instanceof Error ? error.message : "Unable to load Settings API."}</div>}
        </Card>

        <Card className="p-5 grid gap-3 text-sm">
          <Row label="Primary D1 binding" value={<ConfigBadge ready={apiReady} ok={data?.db_configured} okText="DB bound" missingText="DB not bound" />} />
          <Row label="D1 migrations" value={<ConfigBadge ready={dbReady} ok={data?.settings_table_configured} okText="applied" missingText="settings table missing" />} />
          {settingsReady || !data?.settings_error ? null : <div className="text-[var(--muted)] text-xs leading-5">{data.settings_error}</div>}
          <Row label="SMTP2GO API key" value={<ConfigBadge ready={apiReady} ok={data?.smtp2go_configured} okText="configured" missingText="missing" />} />
          <Row label="Webhook token" value={<ConfigBadge ready={apiReady} ok={data?.webhook_token_configured} okText="configured" missingText="missing" />} />
          <Row label="Source D1 binding" value={<ConfigBadge ready={apiReady} ok={data?.source_db_configured} okText="SOURCE_DB bound" missingText="SOURCE_DB not bound" />} />
          <Row label="Send queue binding" value={<ConfigBadge ready={apiReady} ok={data?.send_queue_configured} okText="SEND_QUEUE bound" missingText="missing" />} />
          <Row label="Default from email" value={<code>{data?.env_default_from_email || "—"}</code>} />
          <Row label="Default from name" value={<code>{data?.env_default_from_name || "—"}</code>} />
        </Card>

        <VerificationCadence settingsReady={settingsReady} data={data} />

        <VerifyPause settingsReady={settingsReady} data={data} />

        <FormSequenceMap settingsReady={settingsReady} data={data} />

        <SenderIdentities />

        <Card className="p-5 grid gap-3 text-sm">
          <div>
            <div className="font-medium">Deliverability checks</div>
            <div className="text-[var(--muted)] text-xs mt-1">
              SPF, DKIM, DMARC and MX for the domain mail is sent from, plus whether SMTP2GO has verified
              it. Only the domain name is looked up.
            </div>
          </div>
          <DeliverabilityPanel
            domain={checkDomain}
            onDomainChange={setCheckDomain}
            className="border-0 p-0"
          />
        </Card>

        <Card className="p-5 text-sm space-y-2">
          <div className="font-medium">Webhook URL for SMTP2GO</div>
          <div className="text-[var(--muted)]">Paste this in SMTP2GO → Settings → Webhooks (select bounce, spam, unsubscribe, delivered, opened, clicked events):</div>
          <code className="block bg-[var(--background)] p-3 rounded border border-[var(--border)] font-mono text-xs">
            https://&lt;your-worker-host&gt;/api/webhooks/smtp2go?token=&lt;WEBHOOK_TOKEN&gt;
          </code>
        </Card>

        <Card className="p-5 text-sm space-y-2">
          <div className="font-medium">Expected Cloudflare runtime config</div>
          <pre className="bg-[var(--background)] p-3 rounded border border-[var(--border)] font-mono text-xs whitespace-pre-wrap">{`wrangler secret put SMTP2GO_API_KEY
wrangler secret put WEBHOOK_TOKEN
wrangler.toml [vars]: DEFAULT_FROM_EMAIL, DEFAULT_FROM_NAME
wrangler.toml D1 bindings: DB, SOURCE_DB
wrangler.toml Queue binding: SEND_QUEUE`}</pre>
        </Card>
      </Page>
    </>
  );
}

/**
 * Editable re-verify cadence (settings key `email_verify_stale_days`, default
 * 180). Written through the generic settings PUT; the value is read fresh by
 * every cron pass, so no deploy is needed to change it.
 */
function VerificationCadence({ settingsReady, data }: { settingsReady: boolean; data?: SettingsResponse }) {
  const [days, setDays] = useState("180");
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (seeded || !data) return;
    setDays(String(data.email_verify_stale_days ?? 180));
    setSeeded(true);
  }, [data, seeded]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    setErr(null);
    try {
      const n = Number(days);
      if (!Number.isFinite(n) || n < 1) throw new Error("Enter a number of days (1 or more).");
      const res = await fetch("/api/settings/email_verify_stale_days", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: Math.floor(n) }),
      });
      if (!res.ok) throw new Error(`Settings API returned HTTP ${res.status}`);
      setMsg("Saved — the next verification pass uses this cadence.");
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5 text-sm space-y-3">
      <div>
        <div className="font-medium">Email re-verification cadence</div>
        <div className="text-[var(--muted)] text-xs mt-1">
          After this many days a verified (<b>valid</b>) address becomes <b>stale</b> and is
          eligible for a low-rate automatic re-check once the pending backlog is empty. A fresh
          valid is never re-checked, and queuing a re-check never takes a valid address out of the
          send audience.
          {data?.email_verify_credits_remaining != null && (
            <> Verification credits left (last API report): <b>{Number(data.email_verify_credits_remaining).toLocaleString()}</b>.</>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={1}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          className="max-w-[8rem]"
        />
        <span className="text-[var(--muted)]">days</span>
        <Button disabled={!settingsReady || saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {msg && <div className="text-emerald-400 text-xs">{msg}</div>}
      {err && <div className="text-red-400 text-xs">{err}</div>}
    </Card>
  );
}

/**
 * Pause switch (settings key `email_verify_paused`). When on, the 1-minute cron
 * verification pass is a no-op, so a manual run in the Bulk Email Checker
 * dashboard cannot collide with ours (the API allows one connection at a time).
 */
function VerifyPause({ settingsReady, data }: { settingsReady: boolean; data?: SettingsResponse }) {
  const [paused, setPaused] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (seeded || !data) return;
    setPaused(Boolean(data.email_verify_paused));
    setSeeded(true);
  }, [data, seeded]);

  const save = async (next: boolean) => {
    setSaving(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch("/api/settings/email_verify_paused", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: next }),
      });
      if (!res.ok) throw new Error(`Settings API returned HTTP ${res.status}`);
      setPaused(next);
      setMsg(next ? "Paused - the cron pass will skip until you resume." : "Resumed - the cron pass will run again.");
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5 text-sm space-y-3">
      <div>
        <div className="font-medium">Pause email verification</div>
        <div className="text-[var(--muted)] text-xs mt-1">
          Stop the 1-minute cron verification pass so you can run a manual check in the Bulk Email
          Checker dashboard without the two colliding (the API allows only one connection at a time).
          {data?.env_verify_paused && (
            <> The <code>VERIFY_PAUSED</code> env var is also set; the pass stays off until both are cleared.</>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={paused ? "amber" : "green"}>{paused ? "paused" : "running"}</Badge>
        <Button disabled={!settingsReady || saving} onClick={() => save(!paused)}>
          {saving ? "Saving…" : paused ? "Resume" : "Pause"}
        </Button>
      </div>
      {msg && <div className="text-emerald-400 text-xs">{msg}</div>}
      {err && <div className="text-red-400 text-xs">{err}</div>}
    </Card>
  );
}

/**
 * Form slug -> sequence mapping (settings key `form_sequence_map`). The
 * form-submission webhook looks a submission's form_slug up here to decide which
 * sequence to enrol into, so the forms side stays dumb. Written through the
 * generic settings PUT; read fresh by every submission.
 */
type MapRow = { slug: string; sequenceId: string };

function FormSequenceMap({ settingsReady, data }: { settingsReady: boolean; data?: SettingsResponse }) {
  const [rows, setRows] = useState<MapRow[]>([]);
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const seqQuery = useQuery({
    queryKey: ["sequences-lite"],
    queryFn: async () => {
      const res = await fetch("/api/sequences", { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j: any = await res.json();
      return Array.isArray(j?.rows) ? (j.rows as { id: number; name: string }[]) : [];
    },
    retry: 1,
  });
  const sequences = seqQuery.data ?? [];

  useEffect(() => {
    if (seeded || !data) return;
    const map = data.form_sequence_map;
    const list: MapRow[] = [];
    if (map && typeof map === "object") {
      for (const [slug, id] of Object.entries(map)) list.push({ slug, sequenceId: String(id) });
    }
    setRows(list.length ? list : [{ slug: "", sequenceId: "" }]);
    setSeeded(true);
  }, [data, seeded]);

  const update = (i: number, patch: Partial<MapRow>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setSaving(true);
    setMsg(null);
    setErr(null);
    try {
      const map: Record<string, number> = {};
      for (const r of rows) {
        const s = r.slug.trim();
        const n = Number(r.sequenceId);
        if (s && Number.isSafeInteger(n) && n > 0) map[s] = n;
      }
      const res = await fetch("/api/settings/form_sequence_map", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: map }),
      });
      if (!res.ok) throw new Error(`Settings API returned HTTP ${res.status}`);
      setMsg("Saved — new submissions use this mapping immediately.");
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5 text-sm space-y-3">
      <div>
        <div className="font-medium">Form → sequence mapping</div>
        <div className="text-[var(--muted)] text-xs mt-1">
          Which sequence a website form submission enrols into, keyed by the form's slug. A form with
          no mapping is recorded but not enrolled. Enrolment into a <b>draft</b> sequence captures
          and holds the contact until the sequence is activated.
        </div>
      </div>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              placeholder="form_slug"
              value={r.slug}
              onChange={(e) => update(i, { slug: e.target.value })}
              className="max-w-[14rem]"
            />
            <select
              className="bg-[var(--background)] border border-[var(--border)] rounded px-2 py-1.5 text-sm"
              value={r.sequenceId}
              onChange={(e) => update(i, { sequenceId: e.target.value })}
            >
              <option value="">— none —</option>
              {sequences.map((s) => (
                <option key={s.id} value={String(s.id)}>
                  {s.name} (#{s.id})
                </option>
              ))}
            </select>
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}>
              Remove
            </Button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" className="px-2 py-1 text-xs" onClick={() => setRows((rs) => [...rs, { slug: "", sequenceId: "" }])}>
          Add mapping
        </Button>
        <Button disabled={!settingsReady || saving} onClick={save}>
          {saving ? "Saving…" : "Save mapping"}
        </Button>
      </div>
      {msg && <div className="text-emerald-400 text-xs">{msg}</div>}
      {err && <div className="text-red-400 text-xs">{err}</div>}
    </Card>
  );
}

/**
 * Sender identities + the SMTP2Go sending domains behind them.
 *
 * The owner's hard rule: an identity's From address must be on a VERIFIED
 * SMTP2Go sending domain. The API refuses anything else, so the from-address
 * field only offers the verified domains; "Sync domains" reads the live list.
 */
type Identity = {
  id: number;
  name: string;
  from_name: string | null;
  from_email: string;
  reply_to: string | null;
  sending_domain: string;
  enabled: number;
  is_default: number;
};
type IdentityData = {
  rows: Identity[];
  verified_domains: string[];
  domains: { domain: string; verified: boolean; dkim_verified: boolean | null; rpath_verified: boolean | null; status: string | null }[];
  synced_at: number | null;
};

const BLANK_IDENTITY = { name: "", from_name: "", from_email: "", reply_to: "", is_default: false };

function SenderIdentities() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["sender-identities"], queryFn: () => api<IdentityData>("/api/sender-identities") });
  const data = q.data;
  const rows = data?.rows ?? [];
  const domains = data?.domains ?? [];

  const [draft, setDraft] = useState<any>(BLANK_IDENTITY);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["sender-identities"] });

  const sync = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r: any = await api("/api/sender-identities/sync-domains", { method: "POST" });
      setMsg(`Read ${r.records?.length ?? 0} sending domain(s) — ${r.domains?.length ?? 0} verified.`);
      refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const body = {
        name: String(draft.name ?? "").trim(),
        from_name: String(draft.from_name ?? "").trim() || null,
        from_email: String(draft.from_email ?? "").trim(),
        reply_to: String(draft.reply_to ?? "").trim() || null,
        is_default: !!draft.is_default,
      };
      if (!body.name || !body.from_email) throw new Error("Name and From email are required.");
      if (editingId) await api(`/api/sender-identities/${editingId}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/api/sender-identities", { method: "POST", body: JSON.stringify(body) });
      setDraft(BLANK_IDENTITY);
      setEditingId(null);
      setMsg("Saved.");
      refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (r: Identity) => {
    setEditingId(r.id);
    setErr(null);
    setMsg(null);
    setDraft({
      name: r.name,
      from_name: r.from_name ?? "",
      from_email: r.from_email,
      reply_to: r.reply_to ?? "",
      is_default: !!r.is_default,
    });
  };

  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  };

  return (
    <Card className="p-5 text-sm space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium">Sender identities</div>
          <div className="text-[var(--muted)] text-xs mt-1">
            A named from-identity bound to a <b>verified</b> SMTP2Go sending domain. The domain of the From
            address must be one of the verified domains below — a mismatch is refused on save and blocked at
            send time. Sequences pick an identity here; the default is the fallback.
            {data?.synced_at ? <> Last read {new Date(data.synced_at * 1000).toLocaleString()}.</> : null}
          </div>
        </div>
        <Button variant="outline" onClick={sync} disabled={busy}>
          Sync domains
        </Button>
      </div>

      {domains.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {domains.map((d) => (
            <span key={d.domain} className="text-xs">
              <Badge tone={d.verified ? "green" : "red"}>{d.domain}</Badge>
            </span>
          ))}
        </div>
      )}
      {domains.length === 0 && (
        <div className="text-xs text-[var(--muted)]">
          No sending domains read yet — click <b>Sync domains</b>.
        </div>
      )}

      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-[var(--muted)] border-b border-[var(--border)]">
          <tr>
            <th className="py-2">Name</th>
            <th className="py-2">From</th>
            <th className="py-2">Reply-To</th>
            <th className="py-2">Domain</th>
            <th className="py-2">State</th>
            <th className="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-[var(--border)] last:border-0">
              <td className="py-2">{r.name}{r.is_default ? <Badge tone="blue">default</Badge> : null}</td>
              <td className="py-2">{r.from_name ? `${r.from_name} <${r.from_email}>` : r.from_email}</td>
              <td className="py-2 text-[var(--muted)]">{r.reply_to ?? "—"}</td>
              <td className="py-2 font-mono text-xs">{r.sending_domain}</td>
              <td className="py-2">{r.enabled ? <Badge tone="green">enabled</Badge> : <Badge tone="amber">disabled</Badge>}</td>
              <td className="py-2 text-right whitespace-nowrap">
                <Button variant="ghost" className="!px-2.5 !py-1 text-xs" onClick={() => startEdit(r)}>Edit</Button>
                <Button variant="ghost" className="!px-2.5 !py-1 text-xs" onClick={() => act(() => api(`/api/sender-identities/${r.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !r.enabled }) }))}>
                  {r.enabled ? "Disable" : "Enable"}
                </Button>
                {!r.is_default && (
                  <Button variant="ghost" className="!px-2.5 !py-1 text-xs" onClick={() => act(() => api(`/api/sender-identities/${r.id}/default`, { method: "POST" }))}>
                    Make default
                  </Button>
                )}
                <Button variant="ghost" className="!px-2.5 !py-1 text-xs" onClick={() => { if (confirm(`Delete sender identity “${r.name}”?`)) act(() => api(`/api/sender-identities/${r.id}`, { method: "DELETE" })); }}>
                  Delete
                </Button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="py-4 text-[var(--muted)]">No sender identities yet.</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="border-t border-[var(--border)] pt-3 space-y-3">
        <div className="text-xs uppercase tracking-wide text-[var(--muted)]">
          {editingId ? `Edit identity #${editingId}` : "New identity"}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input placeholder="Name (e.g. LocalDentists main)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <Input placeholder="From name (e.g. LocalDentists.au)" value={draft.from_name} onChange={(e) => setDraft({ ...draft, from_name: e.target.value })} />
          <Input
            placeholder="From email — must be on a verified domain"
            value={draft.from_email}
            onChange={(e) => setDraft({ ...draft, from_email: e.target.value })}
          />
          <Input placeholder="Reply-To (optional)" value={draft.reply_to} onChange={(e) => setDraft({ ...draft, reply_to: e.target.value })} />
        </div>
        {(data?.verified_domains ?? []).length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <span>Verified domains:</span>
            {(data?.verified_domains ?? []).map((d) => (
              <button
                type="button"
                key={d}
                onClick={() => setDraft({ ...draft, from_email: `listing@${d}` })}
                className="px-1.5 py-0.5 rounded bg-[var(--background)] border border-[var(--border)] hover:border-[var(--primary)] font-mono"
              >
                {d}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <input type="checkbox" checked={!!draft.is_default} onChange={(e) => setDraft({ ...draft, is_default: e.target.checked })} />
            Make default
          </label>
          <Button onClick={submit} disabled={busy}>{editingId ? "Save identity" : "Add identity"}</Button>
          {editingId && (
            <Button variant="ghost" onClick={() => { setEditingId(null); setDraft(BLANK_IDENTITY); }}>Cancel</Button>
          )}
        </div>
        {msg && <div className="text-emerald-400 text-xs">{msg}</div>}
        {err && <div className="text-red-400 text-xs">{err}</div>}
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: any }) {
  return (
    <div className="flex justify-between items-center py-2 border-b border-[var(--border)] last:border-0">
      <span className="text-[var(--muted)]">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function ConfigBadge({ ready, ok, okText, missingText }: { ready: boolean; ok?: boolean; okText: string; missingText: string }) {
  if (!ready) return <Badge tone="blue">not checked</Badge>;
  return ok ? <Badge tone="green">{okText}</Badge> : <Badge tone="red">{missingText}</Badge>;
}
