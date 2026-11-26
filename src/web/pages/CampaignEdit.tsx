import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { Page, PageHeader, Card, Input, Select, Textarea, Button, Label, Badge, statusTone } from "../components/ui";
import { errorOf, fieldArray, rowsOf } from "../safeData";
import { escapeHtml, hasContentSlot, htmlToText, mergeBody, plainTextToHtml } from "../../shared/body";
import { MAX_SUBJECT_LENGTH, previewSubjectLine, subjectTooLong } from "../../shared/subject";
import { bySeverity, checkSpam, type SpamCheckResult } from "../../shared/spamCheck";
import { failureLines, type DeliverabilityResult } from "../../shared/deliverability";
import { isSendingDomain, smtp2goRecordDomain } from "../../shared/domain";
import { DeliverabilityPanel, deliverabilityHeadline } from "../components/DeliverabilityPanel";
import {
  fromVarRow,
  isUnsafeStaticValue,
  toVarRow,
  type VarRow,
} from "../../shared/varMapping";
import {
  detectVarOrigins,
  formatVarMappingLine,
  originLabel,
  summarizeVarMapping,
  type DetectedVar,
} from "../../shared/varSources";
import { resolveSampleVars } from "../../shared/sampleValues";
import {
  DEFAULT_SEND_TIMEZONE,
  WEEKDAY_LABELS,
  evaluatePlanNow,
  formatSendDays,
  hasSendPlan,
  isValidTimeZone,
  normalizeDailyCap,
  normalizeRampDays,
  normalizeRampStart,
  normalizeSpreadMinutes,
  parseSendDays,
  parseSendTime,
  planCollapseSummary,
  planConfirmWords,
  planWords,
  projectFinish,
  rampScheduleWords,
  sendDaysLabel,
  sendRamp,
  spreadWords,
  todayRampAllowance,
} from "../../shared/sendPlan";
import {
  spamCollapseSummary,
  tagsCollapseSummary,
  varMappingCollapseSummary,
  type SpamVerdictSource,
} from "../../shared/collapseSummaries";
import { CollapsibleSection } from "../components/Collapsible";
import { extractTemplateVars } from "../../worker/smtp2go";

/**
 * Plain-language summary of the three variable sources, and of what the "Add row"
 * control is for. It lives in the tooltip on the section label and on the
 * static-value fields only — the same explanation is deliberately NOT echoed as
 * inline text below the fields. Keep it short and free of jargon — the attribute
 * path (attributes.api_key) is the detail people get wrong.
 */
const VAR_SOURCE_HINT =
  "Contact field — reads the value from the recipient.\n" +
  "Static value — the same for everyone.\n" +
  "Hybrid — a static value with a field in it, e.g. https://example.com/page?key={{api_key}} — the " +
  "fixed part stays, {{api_key}} changes per recipient (write attributes.api_key for a custom attribute).\n" +
  "Add row declares a variable your template does not list yet — e.g. {{button_label}} or {{button_url}}.";

function normKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Wording for the spam check panel and the pre-send warning. The band is only
 * shown when the whole campaign could actually be inspected — an incomplete
 * check never reads as a verdict.
 */
function spamBandLabel(r: SpamCheckResult): string {
  if (!r.complete || !r.band) return "Not fully checked";
  return r.band === "good" ? "Good" : r.band === "caution" ? "Caution" : "Likely spam";
}
function spamBandTone(r: SpamCheckResult): "green" | "amber" | "red" | "default" {
  if (!r.complete || !r.band) return "default";
  return r.band === "good" ? "green" : r.band === "caution" ? "amber" : "red";
}
/** One-line version for toasts and confirm() text. */
function spamSummaryText(r: SpamCheckResult): string {
  if (!r.complete || r.band === null) return "not fully checked";
  return `${spamBandLabel(r).toLowerCase()} (${r.score}/100)`;
}

/** Compact timestamp for the recipients table; null/0 renders as a dash. */
function fmtRecipientTime(sec: unknown): string {
  const n = Number(sec);
  if (!n || !Number.isFinite(n)) return "—";
  return new Date(n * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildFieldLookup(fieldsData: any, includeSource = true) {
  const lookup = new Map<string, string>();
  const add = (key: unknown, path: unknown) => {
    const k = String(key ?? "").trim();
    const p = String(path ?? "").trim();
    if (!k || !p) return;
    lookup.set(k.toLowerCase(), p);
    lookup.set(normKey(k), p);
  };
  const groups = includeSource ? ["fixed", "attributes", "source"] : ["fixed", "attributes"];
  for (const group of groups) {
    for (const f of fieldsData?.[group] ?? []) {
      add(f.path, f.path);
      add(f.label, f.path);
      if (String(f.path ?? "").startsWith("attributes.")) add(String(f.path).slice("attributes.".length), f.path);
    }
  }
  return lookup;
}

export default function CampaignEdit() {
  const { id } = useParams();
  const editing = !!id;
  const nav = useNavigate();
  const qc = useQueryClient();

  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api("/api/settings") });
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api("/api/templates") });
  const smtpTemplates = useQuery({ queryKey: ["smtp2go-templates"], queryFn: () => api("/api/smtp2go/templates") });
  const domains = useQuery({ queryKey: ["smtp2go-domains"], queryFn: () => api("/api/smtp2go/domains") });
  const lists = useQuery({ queryKey: ["lists"], queryFn: () => api("/api/lists") });
  const camp = useQuery({ queryKey: ["campaign", id], queryFn: () => api(`/api/campaigns/${id}`), enabled: editing });
  // Campaign-scope tags only, so this picker can never offer a contact tag.
  const campaignTags = useQuery({
    queryKey: ["tags", "campaign"],
    queryFn: () => api("/api/tags?scope=campaign"),
  });
  const stats = useQuery({
    queryKey: ["campaign-stats", id],
    queryFn: () => api(`/api/campaigns/${id}/stats`),
    enabled: editing,
    refetchInterval: 5000,
  });
  // Daily-batch plan progress: released today, what is left, and the projected
  // finish. Polled so a running drip moves without a reload.
  const progress = useQuery({
    queryKey: ["campaign-progress", id],
    queryFn: () => api(`/api/campaigns/${id}/progress`),
    enabled: editing,
    refetchInterval: 15000,
  });
  // Self-heal historical campaigns stuck in 'sending' when all sends completed.
  useEffect(() => {
    if (!editing) return;
    const s = camp.data?.row?.status;
    if (s !== "sending" && s !== "paused") return;
    api(`/api/campaigns/${id}/refresh-status`, { method: "POST" })
      .then(() => {
        qc.invalidateQueries({ queryKey: ["campaign", id] });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camp.data?.row?.status, editing, id]);
  // Campaign tag input (campaign scope only; tags are persisted on save).
  const [newTag, setNewTag] = useState("");
  const [form, setForm] = useState<any>({
    name: "",
    // Per-campaign subject. Blank = the template's subject (shown under the
    // field so it is obvious which one will send).
    subject: "",
    template_source: "local", // 'local' | 'smtp2go'
    template_id: "",
    external_template_id: "",
    audience_source: "all", // 'all' | 'list' | 'segment'
    list_id: "",
    segment_id: "",
    from_email: "",
    from_name: "",
    reply_to: "",
    sending_domain: "",
    // Campaign content for a base template's {{content}} slot: plain text,
    // escaped into <p> paragraphs on merge.
    body_text: "",
    // Array of { name, source, field, value } edited in the UI; serialized to
    // a var_mapping object on save (string = contact field, {value} = static).
    var_pairs: [] as VarRow[],
    // Campaign tags (campaign scope only); names that do not exist are created on save.
    tags: [] as string[],
    // Daily-batch ("drip") plan. plan_enabled is a UI-only switch; the four
    // fields below are what the API stores. No plan = send all at once.
    plan_enabled: false,
    daily_cap: "" as string | number,
    send_days: [1, 2, 3, 4, 5] as number[],
    send_time: "10:00",
    send_timezone: "",
    // The optional ramp on the daily cap. Blank ramp_start = no ramp (the cap
    // applies from day one); blank ramp_days = no ramp too.
    ramp_start: "" as string | number,
    ramp_days: "" as string | number,
    // Minutes to spread each day's batch across. Blank/0 = the whole day's batch
    // at the window (today's behaviour); the default is an hour.
    spread_minutes: "" as string | number,
  });
  const [sourceTable, setSourceTable] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem("campaign.var_source_table") ?? "";
  });
  const showSourceFields = form.audience_source !== "list";
  const effectiveSourceTable = showSourceFields ? sourceTable : "";
  // Scope the field picker to the chosen audience: attributes are stored per
  // contact, so unscoped they are the union of every list ever imported.
  const fieldsParams = new URLSearchParams();
  if (effectiveSourceTable) fieldsParams.set("source_table", effectiveSourceTable);
  if (form.audience_source === "list" && form.list_id) fieldsParams.set("list_id", String(form.list_id));
  if (form.audience_source === "segment" && form.segment_id) fieldsParams.set("segment_id", String(form.segment_id));
  const fieldsScope = fieldsParams.toString();
  const fields = useQuery({
    queryKey: ["contact-fields", fieldsScope],
    queryFn: () => api(`/api/contacts/fields${fieldsScope ? `?${fieldsScope}` : ""}`),
  });
  // Unscoped field list, used only to validate existing mappings. The picker is
  // scoped to the audience, but switching audience must never wipe a mapping
  // that is still valid elsewhere — only genuinely unknown fields get cleared.
  const allFields = useQuery({
    queryKey: ["contact-fields", "all"],
    queryFn: () => api("/api/contacts/fields"),
  });
  const [testTo, setTestTo] = useState("");
  // Which contact a test send renders as: "" = the audience default (filled once
  // the list loads), "sample" = no contact (sample data), otherwise a contact id.
  // The recipient box above stays free-text: who receives the message and whose
  // data it renders as are separate choices.
  const [testRenderId, setTestRenderId] = useState("");
  const [testRenderQuery, setTestRenderQuery] = useState("");

  // Per-recipient engagement table (read-only). All of this state is UI-only.
  const [recipientFilter, setRecipientFilter] = useState<
    "all" | "opened" | "clicked" | "delivered" | "bounced" | "not-opened"
  >("all");
  const [recipientSort, setRecipientSort] = useState<"recent" | "engagement">("recent");
  const [recipientSearchInput, setRecipientSearchInput] = useState("");
  const [recipientSearch, setRecipientSearch] = useState("");
  const [recipientOffset, setRecipientOffset] = useState(0);
  const RECIPIENT_PAGE = 25;
  // Debounce the search box so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setRecipientSearch(recipientSearchInput.trim());
      setRecipientOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [recipientSearchInput]);
  const recipients = useQuery({
    queryKey: [
      "campaign-recipients",
      id,
      recipientFilter,
      recipientSort,
      recipientSearch,
      recipientOffset,
    ],
    queryFn: () => {
      const p = new URLSearchParams({
        limit: String(RECIPIENT_PAGE),
        offset: String(recipientOffset),
        filter: recipientFilter,
        sort: recipientSort,
      });
      if (recipientSearch) p.set("q", recipientSearch);
      return api(`/api/campaigns/${id}/recipients?${p.toString()}`);
    },
    enabled: editing,
    refetchInterval: 15000,
  });

  const hasAudienceSelection =
    form.audience_source === "all" ||
    (form.audience_source === "list" && !!form.list_id) ||
    (form.audience_source === "segment" && !!form.segment_id);
  const audienceCount = useQuery({
    queryKey: ["campaign-audience-live", form.audience_source, form.list_id, form.segment_id],
    queryFn: () => {
      if (form.audience_source === "list") return api(`/api/lists/${form.list_id}/count`);
      if (form.audience_source === "segment") return api(`/api/lists/${form.segment_id}/count`);
      return api("/api/campaigns/audience-count");
    },
    enabled: hasAudienceSelection,
  });

  // Test-send render contact, picked from the campaign's OWN audience. Keyed on
  // the SAVED audience (list/segment ids), so it refreshes after a save rather
  // than following an unsaved dropdown.
  const savedAudienceKey = camp.data?.row
    ? `${camp.data.row.list_id ?? ""}:${camp.data.row.segment_id ?? ""}`
    : "";
  const testContacts = useQuery({
    queryKey: ["campaign-test-contacts", id, savedAudienceKey, testRenderQuery],
    queryFn: () =>
      api(
        `/api/campaigns/${id}/audience-contacts?limit=20${testRenderQuery ? `&q=${encodeURIComponent(testRenderQuery)}` : ""}`,
      ),
    enabled: editing,
  });
  // Default to one contact from the audience, so a one-click test just works.
  useEffect(() => {
    if (testRenderId) return;
    const first = testContacts.data?.rows?.[0];
    if (first) setTestRenderId(String(first.id));
  }, [testContacts.data, testRenderId]);
  // What the test will actually render (business name + resolved links) BEFORE
  // anything is sent. Re-resolved when the saved mapping/body/template change.
  const testRender = useQuery({
    queryKey: [
      "campaign-test-render",
      id,
      testRenderId,
      camp.data?.row?.var_mapping ?? "",
      camp.data?.row?.body_html ?? "",
      camp.data?.row?.template_id ?? "",
      camp.data?.row?.external_template_id ?? "",
    ],
    queryFn: () =>
      api(
        `/api/campaigns/${id}/test-render${
          testRenderId && testRenderId !== "sample"
            ? `?contact_id=${encodeURIComponent(testRenderId)}`
            : ""
        }`,
      ),
    enabled: editing && !!testRenderId,
  });

  // Fetch variables declared inside the selected template so we can
  // auto-populate the mapping rows. Works for both local and SMTP2GO templates.
  const varsTemplateId =
    form.template_source === "smtp2go" ? form.external_template_id : form.template_id;
  const varsEndpoint =
    form.template_source === "smtp2go"
      ? `/api/smtp2go/templates/${encodeURIComponent(varsTemplateId)}/vars`
      : `/api/templates/${encodeURIComponent(varsTemplateId)}/vars`;
  const templateVars = useQuery<{ vars: string[]; subject?: string; error?: string }>({
    queryKey: ["template-vars", form.template_source, varsTemplateId],
    queryFn: () => api(varsEndpoint),
    enabled: !!varsTemplateId,
  });

  // Full row of the selected in-app template: the editor needs its html to
  // preview the merged result and to warn about a base template that has no
  // {{content}} slot.
  const templateDetail = useQuery({
    queryKey: ["template-row", form.template_id],
    queryFn: () => api(`/api/templates/${form.template_id}`),
    enabled: form.template_source === "local" && !!form.template_id,
  });

  // Variables written in the campaign body are mapped exactly like variables in
  // the template, so detect them too (they only exist once merged).
  const bodyVars = useMemo<string[]>(
    () => extractTemplateVars(form.body_text ?? ""),
    [form.body_text],
  );
  // Both origins in one list: the template's own variables plus any the campaign
  // body introduces. Each entry keeps its origin so the warning below can say
  // where a name came from — a name that only lives in the template's markup is
  // not something the operator necessarily wrote in this campaign.
  const detectedVars = useMemo<DetectedVar[]>(
    () => detectVarOrigins(templateVars.data?.vars ?? [], bodyVars),
    [templateVars.data, bodyVars],
  );
  // Mapping state, computed once: the collapsed summary line and the shortfall
  // warning inside the section read the same thing.
  const varSummary = useMemo(
    () => summarizeVarMapping(detectedVars, form.var_pairs ?? []),
    [detectedVars, form.var_pairs],
  );

  // Base-template / campaign-body derived state.
  const localTemplates = rowsOf<{ id: number; name: string; is_base?: number }>(templates.data);
  const selectedTemplate = localTemplates.find((t) => String(t.id) === String(form.template_id));
  const isBaseSelected = form.template_source === "local" && !!selectedTemplate?.is_base;
  const templateHtml = String(templateDetail.data?.row?.html ?? "");
  // The template's text/plain half, when it has one. Used by the preview and by
  // the spam check's "missing plain-text alternative" rule.
  const templateText =
    form.template_source === "local" ? String(templateDetail.data?.row?.text ?? "") : "";
  // The subject that sends when the campaign's own Subject is blank. The
  // SMTP2GO vars endpoint returns the template's subject alongside its vars.
  const templateSubject =
    form.template_source === "smtp2go"
      ? String(templateVars.data?.subject ?? "")
      : String(templateDetail.data?.row?.subject ?? "");
  const templateHasSlot = hasContentSlot(templateHtml);
  // What gets persisted as campaigns.body_html; blank editor -> null (= no body).
  // The content is plain text and is escaped into <p> paragraphs on merge.
  const bodyHtml = isBaseSelected ? plainTextToHtml(form.body_text) || null : null;

  // When template vars arrive, add any missing rows and try to auto-map them
  // to a contact field whose name matches (case-insensitive).
  useEffect(() => {
    const vars = detectedVars;
    if (!vars.length) return;
    const lookup = buildFieldLookup(fields.data, showSourceFields);
    setForm((f: any) => {
      let changed = false;
      const nextPairs = [...(f.var_pairs ?? [])];
      for (const { name } of vars) {
        const mappedPath = lookup.get(name.toLowerCase()) ?? lookup.get(normKey(name)) ?? "";
        const existingIndex = nextPairs.findIndex((p: any) => p.name === name);
        if (existingIndex === -1) {
          nextPairs.push({ name, source: "field", field: mappedPath, value: "" } as VarRow);
          changed = true;
        } else if (!nextPairs[existingIndex].field && !nextPairs[existingIndex].path && mappedPath) {
          nextPairs[existingIndex] = { ...nextPairs[existingIndex], field: mappedPath };
          changed = true;
        }
      }
      return changed ? { ...f, var_pairs: nextPairs } : f;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectedVars, fields.data, showSourceFields]);

  useEffect(() => {
    if (!allFields.data) return;
    const validPaths = new Set<string>();
    let hasLoadedFields = false;
    for (const group of ["fixed", "attributes"]) {
      for (const field of allFields.data?.[group] ?? []) {
        hasLoadedFields = true;
        if (field?.path) validPaths.add(String(field.path));
      }
    }
    if (!hasLoadedFields) return;
    const pairs = form.var_pairs ?? [];
    if (!pairs.some((pair: any) => pair.source !== "static" && pair.field && !validPaths.has(pair.field))) return;
    setForm((f: any) => ({
      ...f,
      var_pairs: (f.var_pairs ?? []).map((pair: any) =>
        pair.source !== "static" && pair.field && !validPaths.has(pair.field)
          ? { ...pair, field: "" }
          : pair,
      ),
    }));
  }, [form.var_pairs, allFields.data]);


  useEffect(() => {
    if (camp.data?.row) {
      const row = camp.data.row;
      let pairs: VarRow[] = [];
      try {
        const m = row.var_mapping ? JSON.parse(row.var_mapping) : null;
        if (m && typeof m === "object") {
          pairs = Object.entries(m).map(([name, entry]) => toVarRow(name, entry as any));
        }
      } catch {}
      setForm({
        ...row,
        subject: row.subject ?? "",
        template_source: row.external_template_id ? "smtp2go" : "local",
        template_id: row.template_id ?? "",
        external_template_id: row.external_template_id ?? "",
        audience_source: row.segment_id ? "segment" : row.list_id ? "list" : "all",
        list_id: row.list_id ?? "",
        segment_id: row.segment_id ?? "",
        reply_to: row.reply_to ?? "",
        sending_domain: row.sending_domain ?? "",
        body_text: row.body_html ? htmlToText(row.body_html) : "",
        tags: Array.isArray(row.tags) ? row.tags : [],
        var_pairs: pairs,
        // A plan only "exists" when one of cap/days/time is set. A day list the
        // operator never touched comes back as the Mon-Fri default so the
        // toggles are ready when the plan is switched on.
        plan_enabled: hasSendPlan(row),
        daily_cap: row.daily_cap ?? "",
        send_days: parseSendDays(row.send_days) ?? [1, 2, 3, 4, 5],
        send_time: row.send_time ?? "10:00",
        send_timezone: row.send_timezone ?? "",
        ramp_start: row.ramp_start ?? "",
        ramp_days: row.ramp_days ?? "",
        spread_minutes: row.spread_minutes ?? "",
      });
    } else if (settings.data && typeof settings.data === "object" && "env_default_from_email" in settings.data) {
      setForm((f: any) => ({
        ...f,
        from_email: f.from_email || settings.data.env_default_from_email || "",
        from_name: f.from_name || settings.data.env_default_from_name || "",
        send_timezone: f.send_timezone || settings.data.env_default_send_timezone || "",
      }));
    }
  }, [camp.data, settings.data]);

  /** Patch one template-variable row (name / source / field / value). */
  const updateVarRow = (idx: number, patch: Partial<VarRow>) =>
    setForm((f: any) => {
      const next = [...(f.var_pairs ?? [])];
      next[idx] = { ...next[idx], ...patch };
      return { ...f, var_pairs: next };
    });

  // Zone the plan's window is measured in: this campaign's own, else the server
  // default from the SEND_TIMEZONE var. Shown in the editor and the confirm so
  // "10:00" is never ambiguous.
  const defaultSendTimezone = String(
    settings.data?.env_default_send_timezone || DEFAULT_SEND_TIMEZONE,
  );
  const planTimezone =
    form.send_timezone && isValidTimeZone(form.send_timezone) ? form.send_timezone : defaultSendTimezone;
  const planEnabled = !!form.plan_enabled;
  const planTimezoneInvalid = !!form.send_timezone && !isValidTimeZone(form.send_timezone);
  const toggleSendDay = (day: number) =>
    setForm((f: any) => {
      const cur: number[] = f.send_days ?? [];
      const next = cur.includes(day) ? cur.filter((d) => d !== day) : [...cur, day].sort((a, b) => a - b);
      return { ...f, send_days: next };
    });

  const save = useMutation({
    mutationFn: () => {
      const body: any = {
        name: form.name,
        from_email: form.from_email,
        from_name: form.from_name,
        reply_to: form.reply_to,
        sending_domain: form.sending_domain,
        template_id: form.template_source === "local" && form.template_id ? Number(form.template_id) : null,
        external_template_id: form.template_source === "smtp2go" ? form.external_template_id || null : null,
        list_id: form.audience_source === "list" && form.list_id ? Number(form.list_id) : null,
        segment_id: form.audience_source === "segment" && form.segment_id ? Number(form.segment_id) : null,
        body_html: bodyHtml,
        // Blank normalises to NULL server-side, so it means "use the template's".
        subject: form.subject ?? "",
        tags: form.tags ?? [],
        // Daily-batch plan. Switching the plan off writes NULLs, so "no plan"
        // stays exactly today's behaviour — send all at once.
        daily_cap: planEnabled ? normalizeDailyCap(form.daily_cap) : null,
        send_days: planEnabled ? (form.send_days ?? []) : null,
        send_time: planEnabled ? (parseSendTime(form.send_time)?.hhmm ?? null) : null,
        send_timezone: planEnabled ? planTimezone : null,
        ramp_start: planEnabled ? normalizeRampStart(form.ramp_start) : null,
        ramp_days: planEnabled ? normalizeRampDays(form.ramp_days) : null,
        spread_minutes: planEnabled ? normalizeSpreadMinutes(form.spread_minutes) : null,
        var_mapping: Object.fromEntries(
          (form.var_pairs ?? [])
            .filter((p: any) => {
              const name = String(p.name ?? "").trim();
              if (!name) return false;
              // A static row is valid on its name alone (a blank value resolves
              // to nothing, same as an unset variable); a field row needs a path.
              return p.source === "static" ? true : !!String(p.field ?? p.path ?? "").trim();
            })
            .map((p: any) => [
              String(p.name).trim(),
              fromVarRow({ ...p, field: p.field ?? p.path ?? "" } as VarRow),
            ]),
        ),
      };
      return editing
        ? api(`/api/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(body) })
        : api(`/api/campaigns`, { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: (r: any) => {
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["tags", "campaign"] });
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      if (!editing && r.id) nav(`/campaigns/${r.id}`);
      else {
        qc.invalidateQueries({ queryKey: ["campaign", id] });
        qc.invalidateQueries({ queryKey: ["campaign-audience", id] });
        qc.invalidateQueries({ queryKey: ["campaign-progress", id] });
      }
    },
    onError: (e) => toast.error(String(e)),
  });

  // Tags are the one field that stays editable after a campaign is sent: they
  // are metadata, not send-affecting content. PUT /:id/tags has no status
  // guard, so this works at any status while the main Save stays locked.
  const saveTags = useMutation({
    mutationFn: () =>
      api(`/api/campaigns/${id}/tags`, {
        method: "PUT",
        body: JSON.stringify({ tags: form.tags ?? [] }),
      }),
    onSuccess: () => {
      toast.success("Tags saved");
      qc.invalidateQueries({ queryKey: ["tags", "campaign"] });
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      qc.invalidateQueries({ queryKey: ["campaign", id] });
    },
    onError: (e) => toast.error(String(e)),
  });

  // "Pick another": a random contact from the campaign's own audience.
  const randomTestContact = useMutation({
    mutationFn: () => api(`/api/campaigns/${id}/audience-contacts?random=1`),
    onSuccess: (r: any) => {
      const c = r.rows?.[0];
      if (!c) {
        toast.error("No contacts in this campaign's audience");
        return;
      }
      setTestRenderId(String(c.id));
      toast.success(`Render as ${c.business_name}`);
    },
    onError: (e) => toast.error(String(e)),
  });

  const sendTest = useMutation({
    mutationFn: () =>
      api(`/api/campaigns/${id}/test`, {
        method: "POST",
        body: JSON.stringify({
          // The recipient list is only ever what was typed here. The render
          // contact is a separate choice: blank/"sample" lets the server try the
          // recipient address, then fall back to sample data.
          to: testTo.split(",").map((s) => s.trim()).filter(Boolean),
          ...(testRenderId && testRenderId !== "sample" ? { contact_id: Number(testRenderId) } : {}),
        }),
      }),
    onSuccess: (r: any) => {
      const ok = r.results.filter((x: any) => x.ok).length;
      // The test send runs the same spam check on the real rendered output, so
      // its verdict replaces the sample-data one in the panel and is labelled real.
      if (r.spam) {
        setSpam(r.spam as SpamCheckResult);
        setSpamSource("test");
      }
      const spamNote = r.spam ? ` · spam check ${spamSummaryText(r.spam)}` : "";
      const head = `Test sent: ${ok}/${r.results.length} ok`;
      // Say who the message was rendered with, and be explicit when it fell back
      // to sample data instead of a clinic's.
      if (r.render_source === "sample") {
        toast.warning(`${head} · rendered with sample data (no contact matched)${spamNote}`);
      } else if (r.render_source === "contact") {
        toast.success(`${head} · rendered with data from ${r.render_contact?.business_name ?? "the chosen contact"}${spamNote}`);
      } else {
        toast.success(`${head} · rendered from the recipient's own contact row${spamNote}`);
      }
    },
    onError: (e) => toast.error(String(e)),
  });

  const sendCampaign = useMutation({
    mutationFn: () => api(`/api/campaigns/${id}/send`, { method: "POST" }),
    onSuccess: (r: any) => { toast.success(`Enqueued ${r.enqueued} sends`); qc.invalidateQueries({ queryKey: ["campaign", id] }); },
    onError: (e) => toast.error(String(e)),
  });
  const [scheduleAt, setScheduleAt] = useState<string>("");
  const schedule = useMutation({
    mutationFn: (unix: number | null) =>
      api(`/api/campaigns/${id}/schedule`, {
        method: "POST",
        // With a plan the window decides, so no scheduled_at means "the next
        // window" — the server works that instant out from the plan.
        body: JSON.stringify(unix ? { scheduled_at: unix } : {}),
      }),
    onSuccess: (r: any) => {
      toast.success(
        `Scheduled for ${new Date(r.scheduled_at * 1000).toLocaleString()}${r.plan ? ` · ${r.plan}` : ""} · ${r.count} recipients`,
      );
      qc.invalidateQueries({ queryKey: ["campaign", id] });
      qc.invalidateQueries({ queryKey: ["campaign-progress", id] });
    },
    onError: (e) => toast.error(String(e)),
  });
  const unschedule = useMutation({
    mutationFn: () => api(`/api/campaigns/${id}/unschedule`, { method: "POST" }),
    onSuccess: () => { toast.success("Unscheduled"); qc.invalidateQueries({ queryKey: ["campaign", id] }); },
    onError: (e) => toast.error(String(e)),
  });
  const pause = useMutation({ mutationFn: () => api(`/api/campaigns/${id}/pause`, { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["campaign", id] }) });
  const resume = useMutation({ mutationFn: () => api(`/api/campaigns/${id}/resume`, { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["campaign", id] }) });
  const deleteCampaign = useMutation({
    mutationFn: () => api(`/api/campaigns/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Campaign deleted");
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      nav("/campaigns");
    },
    onError: (e) => toast.error(String(e)),
  });
  // Duplicate: settings only, never history. The default target is a new list of
  // the contacts this campaign has NOT emailed yet — copying the audience
  // verbatim would re-email everyone the original already reached. The original
  // is left alone; pausing or stopping it stays a separate, deliberate action.
  const duplicate = useMutation({
    mutationFn: () =>
      api(`/api/campaigns/${id}/duplicate`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      qc.invalidateQueries({ queryKey: ["lists"] });
      qc.invalidateQueries({ queryKey: ["tags", "campaign"] });
      const n = Number(r.remainder_count ?? 0).toLocaleString();
      toast.success(
        `Cloned as "${r.name}" \u2014 ${n} not yet emailed (list: "${r.list_name}")`,
        { duration: 12000 },
      );
      nav(`/campaigns/${r.id}`);
    },
    onError: (e) => toast.error(String(e)),
  });

  const status = camp.data?.row?.status ?? "draft";
  const isLocked = ["sending", "sent", "paused", "scheduled"].includes(status);
  const remoteTemplates = fieldArray(smtpTemplates.data, "templates");
  const sendingDomains = fieldArray(domains.data, "domains");
  const smtpTemplateError = errorOf(smtpTemplates.data);
  const domainsError = errorOf(domains.data);
  const segments = rowsOf(lists.data).filter((l: any) => l.kind === "segment");
  const staticLists = rowsOf(lists.data).filter((l: any) => l.kind === "static");
  const statsRows = fieldArray(stats.data, "stats");
  // Options shown by the picker: every campaign tag, plus any name selected on
  // this campaign that is not saved yet (so a tag can be created on the fly).
  const tagOptions = (() => {
    const out = rowsOf<{ name: string }>(campaignTags.data).map((t) => String(t.name));
    for (const t of form.tags ?? []) {
      if (!out.some((n) => n.toLowerCase() === String(t).toLowerCase())) out.push(String(t));
    }
    return out.sort((a, b) => a.localeCompare(b));
  })();
  const toggleCampaignTag = (name: string) =>
    setForm((f: any) => {
      const cur: string[] = f.tags ?? [];
      return { ...f, tags: cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name] };
    });
  const addCampaignTag = () => {
    const name = newTag.trim();
    if (!name) return;
    setForm((f: any) => {
      const cur: string[] = f.tags ?? [];
      return cur.some((x) => x.toLowerCase() === name.toLowerCase()) ? f : { ...f, tags: [...cur, name] };
    });
    setNewTag("");
  };

  // Preview of the merged result (base template + campaign body) with SAMPLE
  // data, so unmapped variables show up as {{name}} instead of vanishing. Every
  // variable is rendered against a deterministic sample, never a real contact —
  // see src/shared/sampleValues.ts. A static value is used as typed, a hybrid is
  // interpolated from the samples, a contact field resolves to a typed sample;
  // anything still unresolved stays visible and is named in the spam panel.
  const sampleResolution = useMemo(
    () => resolveSampleVars(form.var_pairs ?? []),
    [form.var_pairs],
  );
  const previewVars = sampleResolution.values;
  const unresolvedPreviewVars = sampleResolution.unresolved;
  const escapePreview = (s: string) =>
    escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  // One substitution helper for the three previews (subject, body, text), so
  // every preview leaves an unmapped variable visible as {{name}} — which is
  // also how the spam check spots a campaign that is not fully rendered.
  const fillPreviewVars = (s: string) =>
    s.replace(/\{\{\{?\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}?\}\}/g, (_m, name: string) =>
      name in previewVars ? escapePreview(previewVars[name]) : `{{${name}}}`,
    );
  const mergedPreview = fillPreviewVars(mergeBody(templateHtml, bodyHtml));

  // The subject preview runs the SAME resolution and the SAME rendered-length
  // cap the send path uses (src/shared/subject.ts), so the preview can never
  // disagree with what goes out. Like the body preview, a variable the mapping
  // never declared stays visible as {{name}} instead of vanishing.
  const previewSubject = previewSubjectLine(form.subject, templateSubject, previewVars);
  const subjectWillOverride = !!String(form.subject ?? "").trim();

  // The text/plain half the send path would build: the template's text body with
  // the campaign content reduced to text, then the same variables substituted
  // (Mustache escapes here too, exactly like the real render). No template text
  // means no text half — the check reports that rather than assuming one.
  const previewText = templateText
    ? fillPreviewVars(mergeBody(templateText, bodyHtml ? htmlToText(bodyHtml) : null))
    : "";

  // Pre-send spam check, run on the SAME rendered output the send path produces
  // (sample data in the editor, real data on a test send). Purely local: see
  // src/shared/spamCheck.ts — no content is ever sent to a scoring service.
  const [spam, setSpam] = useState<SpamCheckResult | null>(null);
  // Which render the current verdict came from. A test send replaces the
  // sample-data verdict with a real one, and the panel labels the two apart.
  const [spamSource, setSpamSource] = useState<SpamVerdictSource | null>(null);
  // Latest deliverability result for the pre-send confirm. The panel owns the
  // fetching; this is just its most recent answer so the confirm can list the
  // failures next to the spam findings.
  const [deliverability, setDeliverability] = useState<DeliverabilityResult | null>(null);
  const runSpamCheck = (): SpamCheckResult => {
    const result = checkSpam({
      subject: previewSubject,
      html: mergedPreview,
      text: previewText,
      from: form.from_email,
      replyTo: form.reply_to,
      // Variables with no sample are named in the "couldn't check" list rather
      // than quietly scoring a half-rendered email as clean.
      unresolvedVariables: unresolvedPreviewVars,
      bodyNote:
        form.template_source === "smtp2go"
          ? "the body content (SMTP2GO renders this template's body server-side — only the subject and the sender details could be checked)"
          : null,
    });
    setSpam(result);
    setSpamSource("sample");
    return result;
  };

  const liveCount = audienceCount.data?.count ?? 0;
  const degraded = !!audienceCount.data?.degraded;
  const audienceLabel =
    form.audience_source === "segment"
      ? `segment "${segments.find((s: any) => String(s.id) === String(form.segment_id))?.name ?? form.segment_id}"`
      : form.audience_source === "list"
        ? `list "${staticLists.find((l: any) => String(l.id) === String(form.list_id))?.name ?? form.list_id}"`
        : "all active contacts";
  const canSend = editing && status === "draft" && hasAudienceSelection && !degraded && liveCount > 0;
  // The plan as the confirm/summary read it, plus the live progress the API
  // reports for a saved campaign (projected days/finish).
  const formPlan = {
    daily_cap: normalizeDailyCap(form.daily_cap),
    send_days: formatSendDays(form.send_days ?? null),
    send_time: parseSendTime(form.send_time)?.hhmm ?? null,
    ramp_start: normalizeRampStart(form.ramp_start),
    ramp_days: normalizeRampDays(form.ramp_days),
    spread_minutes: normalizeSpreadMinutes(form.spread_minutes),
  };
  const planSummaryWords = planEnabled ? planWords(formPlan, planTimezone) : null;
  // A ramp that cannot apply is never silently ignored: the plan box says which
  // way it will go instead.
  const planRamp = sendRamp(formPlan);
  // The spread in words for the numbers as typed. A ramp moves the rate from
  // day to day, so the clause reads as the ceiling it can reach.
  const planSpreadWords = spreadWords(formPlan.spread_minutes, formPlan.daily_cap, !!planRamp);
  const planRampFallback =
    planEnabled && !planRamp && (formPlan.ramp_start != null || formPlan.ramp_days != null)
      ? "Not a ramp yet, so the full cap applies from day one: it needs a daily cap, a start below that cap, and 2 or more sending days."
      : null;
  const progressData: any = progress.data ?? null;
  // Format an instant in the plan's zone — the numbers are meaningless without
  // the zone attached.
  const fmtInPlanZone = (unix: number) =>
    new Date(unix * 1000).toLocaleString(undefined, {
      timeZone: planTimezone,
      dateStyle: "medium",
      timeStyle: "short",
    });
  // Just the day the last batch lands on - the year is noise for a drip that
  // finishes in weeks.
  const fmtInPlanZoneDate = (unix: number) =>
    new Date(unix * 1000).toLocaleDateString(undefined, {
      timeZone: planTimezone,
      month: "short",
      day: "numeric",
    });
  // A ramp makes the finish arithmetic non-uniform, so the projection walks the
  // real days through the same shared helper the dispatcher uses rather than
  // reusing a flat-cap estimate. A saved campaign's own progress (computed
  // server-side, already ramp-aware) wins; an edit that is not saved yet is
  // projected from the live audience count, with nothing released so far.
  const planDays = parseSendDays(formPlan.send_days);
  const planTime = parseSendTime(formPlan.send_time);
  const planProjection: { days: number; finishAt: number | null } | null = (() => {
    if (!planEnabled) return null;
    if (progressData?.planned && progressData.projected_days != null) {
      return {
        days: Number(progressData.projected_days),
        finishAt: progressData.projected_finish_at ?? null,
      };
    }
    const cap = normalizeDailyCap(formPlan.daily_cap);
    const remaining = Number(progressData?.remaining ?? liveCount ?? 0);
    if (cap == null || cap <= 0 || !(remaining > 0)) return null;
    const now = Math.floor(Date.now() / 1000);
    const windowOpen = evaluatePlanNow({
      nowSeconds: now,
      timezone: planTimezone,
      sendDays: planDays,
      sendTime: planTime,
    }).windowOpen;
    // Sending day 1, and nothing is out yet: today's step is the ramp's first.
    const dayAllowance = todayRampAllowance(formPlan, 0) ?? cap;
    const finish = projectFinish({
      remaining,
      dailyCap: cap,
      sendDays: planDays,
      sendTime: planTime,
      timezone: planTimezone,
      nowSeconds: now,
      todayAllowance: windowOpen ? dayAllowance : 0,
      rampStart: formPlan.ramp_start,
      rampDays: formPlan.ramp_days,
      spreadMinutes: formPlan.spread_minutes,
    });
    return finish ? { days: finish.days, finishAt: finish.finishAt } : null;
  })();
  const planProjectedDays = planProjection?.days ?? null;
  // "Day 1: 300, day 2 onward: 500, ... - about 8 sending days, finishing
  // around 6 Oct": the schedule in words, with a finish that accounts for the
  // ramp rather than the flat cap.
  const planTail = planProjection
    ? ` \u2014 about ${planProjection.days} sending day${planProjection.days === 1 ? "" : "s"}` +
      (planProjection.finishAt ? `, finishing around ${fmtInPlanZoneDate(planProjection.finishAt)}` : "")
    : "";
  const confirmSend = () => {
    // Always check before a real send: the warning below is advisory (it never
    // blocks - the operator decides), but it must be seen at least once.
    const result = spam ?? runSpamCheck();
    const lines = [
      planSummaryWords
        ? `Start sending "${form.name}" to ${liveCount} recipient${liveCount === 1 ? "" : "s"} from ${audienceLabel}?`
        : `Send campaign "${form.name}" to ${liveCount} recipient${liveCount === 1 ? "" : "s"} from ${audienceLabel}?`,
      "",
      "This cannot be undone.",
    ];
    // A planned campaign leaves the app in batches, so the confirm has to say so
    // in words: volume, days, time and zone, and roughly how long it takes.
    if (planSummaryWords) {
      lines.push(
        "",
        `Sending plan: ${planConfirmWords(formPlan, planTimezone, planProjectedDays)}.`,
        "Only the current day's batch is released now — the rest of the audience waits for the next window.",
      );
    }
    if (!result.complete || result.band !== "good") {
      lines.push("", `⚠ Spam check: ${spamSummaryText(result)}`);
      for (const f of bySeverity(result.findings).slice(0, 5)) {
        lines.push(`• ${f.message} → ${f.fix}`);
      }
      if (result.findings.length > 5) {
        lines.push(`…and ${result.findings.length - 5} more — see the spam check panel.`);
      }
      if (result.skipped.length) lines.push(`Not checked: ${result.skipped.join("; ")}.`);
      lines.push("", "Send anyway?");
    } else {
      lines.push("", "Spam check found nothing to flag. A good score is not a guarantee of inbox placement.");
    }
    // Authentication failures sit alongside the spam findings: the spam score can
    // only judge content, while SPF/DKIM/DMARC mostly decide placement. Advisory
    // only — like the spam check, this never blocks the send.
    if (deliverability?.failures.length) {
      lines.push(
        "",
        `⚠ Deliverability (${deliverability.domain}): ${deliverabilityHeadline(deliverability)} — these affect inbox placement, not just content.`,
      );
      lines.push(...failureLines(deliverability));
    } else if (deliverability && !deliverability.complete) {
      lines.push(
        "",
        `Deliverability (${deliverability.domain}): no failures, but some checks could not be made — see the panel.`,
      );
    }
    if (confirm(lines.join("\n"))) sendCampaign.mutate();
  };
  const doSchedule = () => {
    // With a plan, the window decides when it starts: a date/time here is an
    // optional "not before". Without a plan a date and time is still required.
    let unix: number | null = null;
    if (scheduleAt) {
      const parsed = Math.floor(new Date(scheduleAt).getTime() / 1000);
      if (!Number.isFinite(parsed)) { toast.error("Invalid date"); return; }
      unix = parsed;
    } else if (!planEnabled) {
      toast.error("Pick a date and time");
      return;
    }
    const when = unix ? new Date(unix * 1000).toLocaleString() : null;
    const msg =
      `Schedule "${form.name}" for ${when ?? "the next sending window"} — ${liveCount} recipient${liveCount === 1 ? "" : "s"} from ${audienceLabel}?` +
      (planSummaryWords
        ? `\n\nSending plan: ${planConfirmWords(formPlan, planTimezone, planProjectedDays)}.` +
          (unix ? "" : `\nFirst batch goes out at the next window (${progressData?.next_window_at ? fmtInPlanZone(progressData.next_window_at) : planTimezone}).`)
        : "");
    if (confirm(msg)) schedule.mutate(unix);
  };
  // Say the flow in words rather than implying it: a fresh draft with empty
  // stats, a remainder audience, and an untouched original.
  const doDuplicate = () => {
    const msg = [
      `Duplicate "${form.name}"?`,
      "",
      "• A NEW DRAFT is created with the same settings — template, subject, body, variables, tags, sender and sending plan.",
      "• Its stats start empty — no sends, opens or clicks carried over.",
      "• Its audience is a new list of the clinics this campaign has NOT emailed yet, so nobody is emailed twice.",
      "• The original campaign is untouched — it keeps doing whatever it is doing. Pausing or stopping it is a separate action.",
    ].join("\n");
    if (confirm(msg)) duplicate.mutate();
  };

  return (
    <>
      <PageHeader
        title={editing ? form.name || "Campaign" : "New campaign"}
        subtitle={editing ? <Badge tone={statusTone(status)}>{status}</Badge> : undefined}
        actions={
          <div className="flex gap-2 items-center">
            {editing && status === "sending" && <Button variant="outline" onClick={() => pause.mutate()}>Pause</Button>}
            {editing && status === "paused" && <Button variant="outline" onClick={() => resume.mutate()}>Resume</Button>}
            {editing && status === "scheduled" && (
              <Button variant="outline" onClick={() => unschedule.mutate()}>Unschedule</Button>
            )}
            <Button onClick={() => save.mutate()} disabled={save.isPending || isLocked}>Save</Button>
            {editing && (
              <Button variant="outline" onClick={doDuplicate} disabled={duplicate.isPending}>
                Duplicate
              </Button>
            )}
            {editing && status !== "sending" && (
              <Button
                variant="ghost"
                className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                disabled={deleteCampaign.isPending}
                onClick={() => {
                  if (!confirm(`Delete campaign "${form.name}"? This will also remove its send history. This cannot be undone.`)) return;
                  deleteCampaign.mutate();
                }}
              >
                Delete
              </Button>
            )}
          </div>
        }
      />
      {editing && status === "scheduled" && camp.data?.row?.scheduled_at && (
        <div className="mx-6 mt-4 rounded border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-200">
          Scheduled for <span className="font-mono">{new Date(camp.data.row.scheduled_at * 1000).toLocaleString()}</span>.
          {hasSendPlan(camp.data.row) ? (
            <>
              {" "}Plan: <span className="font-mono">{planWords(camp.data.row, camp.data.row.send_timezone || defaultSendTimezone)}</span>
              {" "}— the dispatcher releases one batch per allowed day and re-evaluates the audience each time.
            </>
          ) : (
            <> The dispatcher runs every minute and re-evaluates the audience at send time.</>
          )}
        </div>
      )}
      <Page>
        {editing && status === "draft" && (
          <Card className="p-5 grid grid-cols-1 gap-3">
            <div>
              <div className="text-sm font-medium">Send this campaign</div>
              <p className="text-xs text-[var(--muted)] mt-0.5">
                {planEnabled
                  ? "A sending plan is set — starting releases today's batch; the rest follows the plan."
                  : "Send immediately, or pick a date and time to schedule it."}
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label>Schedule for (optional)</Label>
                <Input
                  type="datetime-local"
                  value={scheduleAt}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  className="w-[220px]"
                  title={planEnabled ? "Optional with a plan — the first batch goes out at the next sending window" : "When to send"}
                />
              </div>
              <Button variant="outline" onClick={doSchedule} disabled={!canSend || (!scheduleAt && !planEnabled) || schedule.isPending}>
                Schedule
              </Button>
              <Button
                variant="outline"
                className="border-amber-500/60 text-amber-300 hover:bg-amber-500/10"
                onClick={confirmSend}
                disabled={!canSend || sendCampaign.isPending}
              >
                {planEnabled ? "Start sending" : "Send now"}
              </Button>
            </div>
            <p className="text-xs text-[var(--muted)]">
              {planEnabled
                ? "“Start sending” begins the plan now — it cannot be undone."
                : "“Send now” emails the whole audience immediately — it cannot be undone."}
            </p>
          </Card>
        )}
        <div className="grid grid-cols-2 gap-4">
          <Card className="p-5 grid grid-cols-1 gap-4">
            <div><Label>Name</Label><Input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={isLocked} /></div>

            <div>
              <Label>Subject (supports {`{{vars}}`})</Label>
              <Input
                value={form.subject ?? ""}
                placeholder={
                  templateSubject
                    ? "Leave blank to use the template's subject"
                    : "e.g. A quick update for {{practice_name}}"
                }
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
                disabled={isLocked}
              />
              {subjectTooLong(form.subject) && (
                <p className="text-xs text-amber-400 mt-1">
                  Too long — a subject is capped at {MAX_SUBJECT_LENGTH} characters, so this will be
                  rejected on save. Shorten it.
                </p>
              )}
              {subjectWillOverride ? (
                <p className="text-xs text-[var(--muted)] mt-1">
                  Campaign subject — overrides the template's for this campaign only. Preview:{" "}
                  <span className="text-white">{previewSubject || "…"}</span>
                </p>
              ) : templateSubject ? (
                <p className="text-xs text-[var(--muted)] mt-1">
                  Blank — this campaign sends the template's subject:{" "}
                  <span className="text-white">{previewSubject || templateSubject}</span>
                </p>
              ) : (
                <p className="text-xs text-[var(--muted)] mt-1">
                  Blank — the template's subject is used once a template is chosen.
                </p>
              )}
            </div>

            <CollapsibleSection
              id="spam"
              title="Spam check"
              defaultOpen={false}
              summary={spamCollapseSummary(spam, spamSource)}
              actions={
                <Button type="button" variant="outline" onClick={() => runSpamCheck()}>
                  Check spam score
                </Button>
              }
            >
              <div className="flex items-center gap-2">
                {spam ? (
                  <>
                    <Badge tone={spamBandTone(spam)}>{spamBandLabel(spam)}</Badge>
                    {spam.score !== null && spam.score !== undefined && (
                      <span className="text-xs text-[var(--muted)]">{spam.score}/100</span>
                    )}
                  </>
                ) : (
                  <span className="text-xs text-[var(--muted)]">Not checked yet.</span>
                )}
              </div>
              {spam && (
                <p className="text-xs text-[var(--muted)]">
                  {spamSource === "test"
                    ? "Checked against a real test send — this used a real recipient's data."
                    : "Checked with sample data — variables shown as their mapped shape."}
                </p>
              )}
              {!spam && (
                <p className="text-xs text-[var(--muted)]">
                  Checks the rendered subject and body against local heuristics. Nothing is sent anywhere —
                  the content never leaves this app. A good score is <span className="text-white">not</span> a
                  guarantee of inbox placement.
                </p>
              )}
              {spam && (
                <>
                  <p className="text-xs text-[var(--muted)]">
                    Sender-side hygiene only. A good score is <span className="text-white">not</span> a guarantee
                    of inbox placement — domain reputation, authentication (SPF/DKIM/DMARC) and recipient
                    engagement decide that too.
                  </p>
                  {!spam.complete && (
                    <p className="text-xs text-amber-400">
                      Not everything could be checked, so there is no score:{" "}
                      {spam.skipped.join("; ")}.
                    </p>
                  )}
                  {spam.complete && spam.findings.length === 0 && (
                    <p className="text-xs text-emerald-400">
                      No findings — score {spam.score}/100. Nothing here guarantees the inbox.
                    </p>
                  )}
                  {spam.findings.length > 0 && (
                    <div className="max-h-56 overflow-auto grid grid-cols-1 gap-2 pr-1">
                      {bySeverity(spam.findings).map((f) => (
                        <div
                          key={f.id}
                          className={`border-l-2 pl-2 ${f.severity === "high" ? "border-red-500/60" : f.severity === "medium" ? "border-amber-500/60" : "border-[var(--border)]"}`}
                        >
                          <div className="text-xs">
                            <span
                              className={
                                f.severity === "high"
                                  ? "text-red-400 uppercase tracking-wide"
                                  : f.severity === "medium"
                                    ? "text-amber-400 uppercase tracking-wide"
                                    : "text-[var(--muted)] uppercase tracking-wide"
                              }
                            >
                              {f.severity}
                            </span>{" "}
                            <span className="text-[var(--muted)]">
                              {f.area} · −{f.weight}
                            </span>
                          </div>
                          <div className="text-xs text-white">{f.message}</div>
                          <div className="text-xs text-[var(--muted)]">Fix: {f.fix}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {spam.findings.length > 0 && spam.score !== null && (
                    <p className="text-xs text-[var(--muted)]">
                      Score {spam.score}/100 — 100 minus {spam.penalty} points of findings.
                    </p>
                  )}
                </>
              )}

              <DeliverabilityPanel
                domain={form.sending_domain || ""}
                from={form.from_email || ""}
                onResult={setDeliverability}
              />
            </CollapsibleSection>

            <CollapsibleSection
              id="tags"
              title="Campaign tags"
              summary={tagsCollapseSummary(form.tags ?? [])}
            >
              <span className="text-xs text-[var(--muted)]">separate from contact tags</span>
              <div className="flex flex-wrap gap-2">
                {tagOptions.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => toggleCampaignTag(name)}
                    className={`px-2 py-1 text-xs rounded border ${(form.tags ?? []).includes(name) ? "bg-[var(--primary)] border-[var(--primary)]" : "border-[var(--border)] text-[var(--muted)]"}`}
                  >{name}</button>
                ))}
                {!tagOptions.length && (
                  <span className="text-xs text-[var(--muted)]">No campaign tags yet — add one below.</span>
                )}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="new campaign tag"
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                />
                <Button type="button" variant="outline" onClick={addCampaignTag} disabled={!newTag.trim()}>Add</Button>
              </div>
              {editing && (
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" onClick={() => saveTags.mutate()} disabled={saveTags.isPending}>
                    Save tags
                  </Button>
                  <span className="text-xs text-[var(--muted)]">Tags save on their own — editable at any status, including after sending.</span>
                </div>
              )}
              <p className="text-xs text-[var(--muted)]">
                Campaign tags are their own list — a contact tagged “melbourne” is unrelated to a campaign tagged “melbourne”.
              </p>
            </CollapsibleSection>

            {/* Daily-batch (drip) sending. Off = send all at once, exactly as
                before. The plan is only editable while the campaign is a draft —
                isLocked disables it once it is scheduled or running, so a plan
                can never be changed underneath a live drip. */}
            <CollapsibleSection
              id="schedule"
              title="Sending schedule"
              summary={planCollapseSummary(formPlan, planTimezone)}
            >
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={planEnabled}
                  disabled={isLocked}
                  onChange={(e) => setForm({ ...form, plan_enabled: e.target.checked })}
                />
                Send in daily batches
              </label>
              {!planEnabled ? (
                <p className="text-xs text-[var(--muted)]">
                  No plan — the whole audience is released at once.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Daily cap</Label>
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        placeholder="e.g. 200"
                        value={form.daily_cap ?? ""}
                        onChange={(e) => setForm({ ...form, daily_cap: e.target.value })}
                        disabled={isLocked}
                      />
                      <p className="text-xs text-[var(--muted)] mt-1">
                        Most recipients released per day. Blank = no cap (everything goes on the first day).
                      </p>
                    </div>
                    <div>
                      <Label>Time of day</Label>
                      <Input
                        type="time"
                        value={form.send_time ?? ""}
                        onChange={(e) => setForm({ ...form, send_time: e.target.value })}
                        disabled={isLocked}
                      />
                      <p className="text-xs text-[var(--muted)] mt-1">
                        The day's batch goes out at this local time — never before it.
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Start at</Label>
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        placeholder="e.g. 300"
                        value={form.ramp_start ?? ""}
                        onChange={(e) => setForm({ ...form, ramp_start: e.target.value })}
                        disabled={isLocked}
                      />
                      <p className="text-xs text-[var(--muted)] mt-1">
                        Allowance on the first sending day. Blank = no ramp (the cap applies from day one).
                      </p>
                    </div>
                    <div>
                      <Label>Reach full cap after</Label>
                      <Input
                        type="number"
                        min={2}
                        step={1}
                        placeholder="e.g. 2"
                        value={form.ramp_days ?? ""}
                        onChange={(e) => setForm({ ...form, ramp_days: e.target.value })}
                        disabled={isLocked}
                      />
                      <p className="text-xs text-[var(--muted)] mt-1">
                        Sending days until the full cap. 2 = day 1 at the start figure, day 2 onward at the cap.
                      </p>
                    </div>
                  </div>
                  <div>
                    <Label>Spread across (minutes)</Label>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      placeholder="e.g. 60"
                      value={form.spread_minutes ?? ""}
                      onChange={(e) => setForm({ ...form, spread_minutes: e.target.value })}
                      disabled={isLocked}
                    />
                    <p className="text-xs text-[var(--muted)] mt-1">
                      Release the day's batch evenly over this many minutes — a steady trickle instead of one
                      burst. Blank or 0 = the whole day's batch at the window. Each day's allowance is still met
                      in full by the end of the spread.
                    </p>
                    {planSpreadWords ? (
                      <p className="text-xs text-[var(--muted)] mt-1">
                        Currently: <span className="text-white">{planSpreadWords}</span>.
                      </p>
                    ) : null}
                  </div>
                  <div>
                    <Label>Days</Label>
                    <div className="flex flex-wrap gap-1">
                      {WEEKDAY_LABELS.map((w) => {
                        const on = (form.send_days ?? []).includes(w.value);
                        return (
                          <button
                            key={w.value}
                            type="button"
                            title={w.long}
                            onClick={() => toggleSendDay(w.value)}
                            disabled={isLocked}
                            className={`px-2 py-1 text-xs rounded border ${on ? "bg-[var(--primary)] border-[var(--primary)]" : "border-[var(--border)] text-[var(--muted)]"}`}
                          >
                            {w.short}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-xs text-[var(--muted)] mt-1">
                      {sendDaysLabel(parseSendDays(form.send_days ?? null))} — with no day selected the plan runs every day.
                    </p>
                  </div>
                  <div>
                    <Label>Timezone</Label>
                    <Input
                      value={form.send_timezone ?? ""}
                      placeholder={defaultSendTimezone}
                      onChange={(e) => setForm({ ...form, send_timezone: e.target.value })}
                      disabled={isLocked}
                    />
                    <p className="text-xs text-[var(--muted)] mt-1">
                      IANA zone the day boundary and time are read in (e.g. Australia/Brisbane). Blank follows the server
                      default <span className="text-white">{defaultSendTimezone}</span>.
                    </p>
                    {planTimezoneInvalid && (
                      <p className="text-xs text-amber-400 mt-1">
                        Not a zone this app can resolve — save would silently fall back to {defaultSendTimezone}.
                      </p>
                    )}
                  </div>
                  <div className="text-xs rounded border border-[var(--border)] bg-[var(--accent)]/40 px-3 py-2">
                    Plan: <span className="text-white">{planWords(formPlan, planTimezone)}</span>
                    {planTail}
                    {editing && progressData && !progressData.planned ? " · save to start using this plan" : ""}
                    {planRampFallback ? (
                      <div className="text-amber-400 mt-1">{planRampFallback}</div>
                    ) : null}
                  </div>
                </>
              )}

              {editing && progressData?.planned && ["scheduled", "sending", "paused"].includes(status) && (
                <div className="grid grid-cols-1 gap-2 rounded border border-[var(--border)] p-3">
                  <div className="text-xs uppercase tracking-wide text-[var(--muted)]">Progress</div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {[
                      ["Released today", `${progressData.released_today}${progressData.daily_cap ? ` / ${progressData.daily_cap}` : ""}`],
                      ["Sent today", String(progressData.sent_today)],
                      ["Remaining", String(progressData.remaining)],
                      ["In flight", String(progressData.queued)],
                    ].map(([label, value]) => (
                      <div key={label} className="flex justify-between bg-[var(--background)] rounded px-2 py-1">
                        <span className="text-[var(--muted)]">{label}</span>
                        <span className="font-mono">{value}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-[var(--muted)]">
                    {progressData.window_open ? (
                      <>Today's window is open.</>
                    ) : (
                      <>
                        Waiting for the next window
                        {progressData.next_window_at ? ` — ${fmtInPlanZone(progressData.next_window_at)}` : ""}.
                      </>
                    )}{" "}
                    {progressData.projected_finish_at ? (
                      <>
                        Projected last batch{" "}
                        <span className="text-white">{fmtInPlanZone(progressData.projected_finish_at)}</span>
                        {progressData.projected_days
                          ? ` (${progressData.projected_days} sending day${progressData.projected_days === 1 ? "" : "s"})`
                          : ""}
                        .
                      </>
                    ) : null}
                  </p>
                  {status === "paused" && (
                    <p className="text-xs text-amber-400">Paused — no batch is released until you resume.</p>
                  )}
                </div>
              )}
            </CollapsibleSection>

            <div>
              <Label>Template source</Label>
              <Select value={form.template_source} onChange={(e) => setForm({ ...form, template_source: e.target.value })} disabled={isLocked}>
                <option value="local">In-app template</option>
                <option value="smtp2go">SMTP2GO template</option>
              </Select>
            </div>

            {form.template_source === "local" ? (
              <div>
                <Label>Template</Label>
                <Select value={form.template_id ?? ""} onChange={(e) => setForm({ ...form, template_id: e.target.value })} disabled={isLocked}>
                  <option value="">Choose template…</option>
                  {localTemplates.map((t: any) => (
                    <option key={t.id} value={t.id}>{t.name}{t.is_base ? " (base)" : ""}</option>
                  ))}
                </Select>
              </div>
            ) : (
              <div>
                <Label>SMTP2GO template</Label>
                <Select value={form.external_template_id ?? ""} onChange={(e) => setForm({ ...form, external_template_id: e.target.value })} disabled={isLocked}>
                  <option value="">Choose template…</option>
                  {remoteTemplates.map((t: any) => (
                    <option key={t.template_id} value={t.template_id}>
                      {t.templatename || t.name || t.template_id}
                    </option>
                  ))}
                </Select>
                {form.external_template_id && (
                  <p className="text-xs text-[var(--muted)] mt-1">
                    Will send via SMTP2GO template <code className="font-mono">{form.external_template_id}</code>. SMTP2GO renders the subject and body; variables are passed as <code>template_data</code>.
                  </p>
                )}
                {smtpTemplateError && (
                  <p className="text-xs text-red-400 mt-1">SMTP2GO: {smtpTemplateError}</p>
                )}
                {!smtpTemplateError && !remoteTemplates.length && !smtpTemplates.isLoading && (
                  <p className="text-xs text-[var(--muted)] mt-1">No templates found in your SMTP2GO account.</p>
                )}
              </div>
            )}

            {isBaseSelected && (
              <div className="rounded border border-[var(--border)] p-3 grid grid-cols-1 gap-2">
                                <Label>Campaign content</Label>
                <Textarea
                  rows={12}
                  className="resize-y"
                  placeholder={"Write this campaign's content here.\n\nLeave a blank line between paragraphs. Variables like {{first_name}} work here too."}
                  value={form.body_text ?? ""}
                  onChange={(e) => setForm({ ...form, body_text: e.target.value })}
                  disabled={isLocked}
                />
                <p className="text-xs text-[var(--muted)]">
                  Goes into the base template at <code>{"{{content}}"}</code>; variables are substituted after the merge, so the
                  mapping below applies to content written here as well.
                </p>
                {templateHasSlot ? (
                  <p className="text-xs text-emerald-400">Base template found a <code>{"{{content}}"}</code> slot.</p>
                ) : (
                  <p className="text-xs text-amber-400">
                    ⚠ This base template has no <code>{"{{content}}"}</code> slot, so the content will be appended at the end of
                    the template. Add <code>{"{{content}}"}</code> to the template’s HTML to control where it lands.
                  </p>
                )}
              </div>
            )}

            {!!varsTemplateId && (
              <CollapsibleSection
                id="variables"
                title={
                  <span className="flex items-center gap-1.5">
                    <span>Template variables</span>
                    <span
                      className="cursor-help rounded-full border border-[var(--border)] px-1.5 leading-4 text-[0.7rem] text-[var(--muted)]"
                      title={VAR_SOURCE_HINT}
                      aria-label={VAR_SOURCE_HINT}
                    >?</span>
                  </span>
                }
                summary={varMappingCollapseSummary(varSummary)}
                actions={
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        const existing = new Set((form.var_pairs ?? []).map((p: any) => p.name));
                        const common: VarRow[] = [
                          { name: "first_name", source: "field", field: "first_name", value: "" },
                          { name: "last_name", source: "field", field: "last_name", value: "" },
                          { name: "email", source: "field", field: "email", value: "" },
                          { name: "practice_name", source: "field", field: "practice_name", value: "" },
                        ];
                        const defaults = common.filter((d) => !existing.has(d.name));
                        setForm({ ...form, var_pairs: [...(form.var_pairs ?? []), ...defaults] });
                      }}
                      disabled={isLocked}
                    >Add common fields</Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        setForm({
                          ...form,
                          var_pairs: [
                            ...(form.var_pairs ?? []),
                            { name: "", source: "field", field: "", value: "" } as VarRow,
                          ],
                        })
                      }
                      disabled={isLocked}
                    >Add row</Button>
                  </>
                }
              >
                <p className="text-xs text-[var(--muted)] whitespace-pre-line">
                  {VAR_SOURCE_HINT}
                </p>
                <p className="text-xs text-[var(--muted)]">
                  {form.template_source === "smtp2go"
                    ? <>Sent to SMTP2GO as <code>template_data</code>. Reference them in your template as <code>{"{{variable}}"}</code>.</>
                    : <>Rendered into <code>{"{{variable}}"}</code> placeholders in the template subject/body.</>}
                </p>
                {varsTemplateId && (
                  <div className="text-xs rounded border border-[var(--border)] bg-[var(--accent)]/40 px-3 py-2">
                    {templateVars.isLoading && <span className="text-[var(--muted)]">Detecting variables in template…</span>}
                    {templateVars.data?.error && (
                      <span className="text-red-400">Could not read template: {templateVars.data.error}</span>
                    )}
                    {detectedVars.length > 0 && (
                      <div className="space-y-1">
                        <div>
                          Variables found:{" "}
                          {varSummary.detected.map((v, i) => (
                            <span key={v.name}>
                              {i > 0 && " "}
                              <span className="whitespace-nowrap">
                                <code className="font-mono">{`{{${v.name}}}`}</code>{" "}
                                <span className="text-[var(--muted)]">({originLabel(v.origin)})</span>
                              </span>
                            </span>
                          ))}
                        </div>
                        <div className={varSummary.missing.length ? "text-amber-400" : "text-emerald-400"}>
                          {formatVarMappingLine(varSummary)}
                        </div>
                      </div>
                    )}
                    {templateVars.data && !templateVars.data.error && detectedVars.length === 0 && (
                      <span className="text-[var(--muted)]">No variables found in this template or the campaign content.</span>
                    )}
                  </div>
                )}
                {showSourceFields && (
                  <div className="grid grid-cols-[auto_1fr] gap-2 items-center">
                    <span className="text-xs text-[var(--muted)]">Source table</span>
                    <Input
                      placeholder="e.g. dentists (optional, introspects SOURCE_DB)"
                      value={sourceTable}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSourceTable(v);
                        try { window.localStorage.setItem("campaign.var_source_table", v); } catch {}
                      }}
                      disabled={isLocked}
                    />
                  </div>
                )}
                {showSourceFields && fields.data?.source_error && (
                  <p className="text-xs text-red-400">Source: {fields.data.source_error}</p>
                )}
                {(form.var_pairs ?? []).length === 0 && (
                  <p className="text-xs text-[var(--muted)]">No variables configured.</p>
                )}
                {(form.var_pairs ?? []).map((pair: any, idx: number) => (
                  <div key={idx} className="grid grid-cols-[1fr_8rem_minmax(0,1.6fr)_auto] gap-2 items-start">
                    <Input
                      placeholder="variable name (e.g. button_label)"
                      value={pair.name}
                      onChange={(e) => updateVarRow(idx, { name: e.target.value })}
                      disabled={isLocked}
                    />
                    <Select
                      value={pair.source ?? "field"}
                      onChange={(e) =>
                        updateVarRow(idx, {
                          source: e.target.value as VarRow["source"],
                          field: "",
                          value: "",
                        })
                      }
                      disabled={isLocked}
                    >
                      <option value="field">Contact field</option>
                      <option value="static">Static value</option>
                    </Select>
                    {(pair.source ?? "field") === "static" ? (
                      <div className="grid grid-cols-1 gap-1" title={VAR_SOURCE_HINT}>
                        <Input
                          placeholder={
                            pair.name === "button_url"
                              ? "https://localdentists.au/…"
                              : "value sent to everyone"
                          }
                          value={pair.value ?? ""}
                          onChange={(e) => updateVarRow(idx, { value: e.target.value })}
                          disabled={isLocked}
                        />
                        {isUnsafeStaticValue(pair.value) && (
                          <span className="text-xs text-amber-400">
                            Unsafe URL scheme — only http, https and mailto are allowed. This value is
                            dropped when the email renders.
                          </span>
                        )}
                      </div>
                    ) : (
                      <Select
                        value={pair.field ?? pair.path ?? ""}
                        onChange={(e) => updateVarRow(idx, { field: e.target.value })}
                        disabled={isLocked}
                      >
                        <option value="">Choose contact field…</option>
                        {/* A saved mapping can reference a field this audience no
                            longer shows (or never had). Keep it visible instead of
                            silently rendering an empty select. */}
                        {(() => {
                          const sel = pair.field ?? pair.path ?? "";
                          const listed = [
                            ...(fields.data?.fixed ?? []),
                            ...(fields.data?.attributes ?? []),
                            ...(showSourceFields ? fields.data?.source ?? [] : []),
                          ].some((f: any) => f.path === sel);
                          if (!sel || listed) return null;
                          return (
                            <option value={sel}>{String(sel).replace(/^attributes\./, "")} — not in this audience</option>
                          );
                        })()}
                        <optgroup label="Contact fields">
                          {(fields.data?.fixed ?? []).map((f: any) => (
                            <option key={f.path} value={f.path}>{f.label} ({f.path})</option>
                          ))}
                        </optgroup>
                        {(fields.data?.attributes ?? []).length > 0 && (
                          <optgroup
                            label={
                              fields.data?.scope === "global"
                                ? "Custom attributes (all imports)"
                                : `Custom attributes — ${fields.data?.scope_label}`
                            }
                          >
                            {(fields.data?.attributes ?? []).map((f: any) => (
                              <option key={f.path} value={f.path}>{f.label}</option>
                            ))}
                          </optgroup>
                        )}
                        {showSourceFields && (fields.data?.source ?? []).length > 0 && (
                          <optgroup label={`Source DB columns (${sourceTable})`}>
                            {(fields.data?.source ?? []).map((f: any) => (
                              <option key={`src-${f.path}-${f.label}`} value={f.path}>{f.label}</option>
                            ))}
                          </optgroup>
                        )}
                      </Select>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        setForm({
                          ...form,
                          var_pairs: form.var_pairs.filter((_: any, i: number) => i !== idx),
                        })
                      }
                      disabled={isLocked}
                    >Remove</Button>
                  </div>
                ))}
              </CollapsibleSection>
            )}


            <div className="grid grid-cols-2 gap-3">
              <div><Label>From name</Label><Input value={form.from_name ?? ""} onChange={(e) => setForm({ ...form, from_name: e.target.value })} disabled={isLocked} /></div>
              <div><Label>From email</Label><Input value={form.from_email ?? ""} onChange={(e) => setForm({ ...form, from_email: e.target.value })} disabled={isLocked} /></div>
            </div>
            <div><Label>Reply-to (optional)</Label><Input value={form.reply_to ?? ""} onChange={(e) => setForm({ ...form, reply_to: e.target.value })} disabled={isLocked} /></div>

            <div>
              <Label>Sending domain (must be verified in SMTP2GO)</Label>
              <Select value={form.sending_domain ?? ""} onChange={(e) => setForm({ ...form, sending_domain: e.target.value })} disabled={isLocked}>
                <option value="">Use default</option>
                {/* A stored value that is not a domain (an old first-label truncation)
                    stays visible rather than being silently dropped, and the picker
                    offers only full domains as replacements. Saving it again is
                    refused by the API. */}
                {form.sending_domain && !isSendingDomain(form.sending_domain) && (
                  <option value={form.sending_domain}>{form.sending_domain} — not a domain; pick one below</option>
                )}
                {sendingDomains.map((d: any, i: number) => {
                  // Every SMTP2GO record yields a full domain (fulldomain, or the
                  // parts rebuilt with the whole suffix) — never a first label.
                  const name = smtp2goRecordDomain(d);
                  if (!name) return null;
                  const verified = d?.dkim_verified ?? d?.rpath_verified ?? d?.domain?.dkim_verified ?? d?.domain?.rpath_verified;
                  const status = typeof verified === "boolean" ? (verified ? "verified" : "unverified") : (typeof d?.status === "string" ? d.status : "");
                  return (
                    <option key={name} value={name}>{name} {status ? `· ${status}` : ""}</option>
                  );
                })}
              </Select>
              {domainsError && (
                <p className="text-xs text-red-400 mt-1">SMTP2GO: {domainsError}</p>
              )}
            </div>
          </Card>

          <div className="space-y-4">
            <Card className="p-5 grid grid-cols-1 gap-3">
              <div className="text-sm font-medium">Audience</div>
              <Select value={form.audience_source} onChange={(e) => setForm({ ...form, audience_source: e.target.value })} disabled={isLocked}>
                <option value="all">All active contacts</option>
                <option value="list">Static list</option>
                <option value="segment">Segment</option>
              </Select>
              {form.audience_source === "list" && (
                <Select value={form.list_id ?? ""} onChange={(e) => setForm({ ...form, list_id: e.target.value })} disabled={isLocked}>
                  <option value="">Choose list…</option>
                  {staticLists.map((l: any) => (<option key={l.id} value={l.id}>{l.name}</option>))}
                </Select>
              )}
              {form.audience_source === "segment" && (
                <Select value={form.segment_id ?? ""} onChange={(e) => setForm({ ...form, segment_id: e.target.value })} disabled={isLocked}>
                  <option value="">Choose segment…</option>
                  {segments.map((l: any) => (<option key={l.id} value={l.id}>{l.name}</option>))}
                </Select>
              )}
              {hasAudienceSelection && (
                <>
                  <div className="text-xs text-[var(--muted)]">
                    Audience size: <span className="font-mono text-white">{audienceCount.data?.count ?? "…"}</span>
                  </div>
                  {audienceCount.data?.degraded && (
                    <div className="text-xs text-red-400">
                      ⚠ Segment could not be evaluated — sending is blocked. Open Lists &amp; tags, edit this segment, and re-save its rules.
                    </div>
                  )}
                  {(audienceCount.data?.warnings ?? []).map((w: string, i: number) => (
                    <div key={i} className="text-xs text-amber-400">⚠ {w}</div>
                  ))}
                </>
              )}
            </Card>

            <Card className="p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-medium">Preview (sample data)</div>
                {isBaseSelected && (
                  <span className="text-xs text-[var(--muted)]">base template + campaign content</span>
                )}
              </div>
              {form.template_source === "local" && form.template_id ? (
                <iframe
                  title="campaign preview"
                  className="w-full h-[420px] bg-white rounded border border-[var(--border)]"
                  srcDoc={mergedPreview}
                />
              ) : (
                <p className="text-xs text-[var(--muted)]">Pick an in-app template to preview it here.</p>
              )}
            </Card>

            <Card className="p-5 grid grid-cols-1 gap-3 min-w-0 overflow-hidden">
              <Label>Send test (comma-separated, max 5)</Label>
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <Input className="flex-1 min-w-[12rem]" placeholder="me@example.com" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
                <Button variant="outline" className="shrink-0" disabled={!editing || !testTo || sendTest.isPending} onClick={() => sendTest.mutate()}>Send test</Button>
              </div>
              {!editing && <p className="text-xs text-[var(--muted)]">Save the campaign first to send a test.</p>}

              {editing && (
                <>
                  <Label>Render as (whose data the test uses)</Label>
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <Input
                      className="flex-1 min-w-[12rem]"
                      placeholder="Search this campaign's audience…"
                      value={testRenderQuery}
                      onChange={(e) => setTestRenderQuery(e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0"
                      disabled={randomTestContact.isPending || !testContacts.data?.total}
                      onClick={() => randomTestContact.mutate()}
                    >
                      Pick another
                    </Button>
                  </div>
                  <Select className="w-full max-w-full" value={testRenderId} onChange={(e) => setTestRenderId(e.target.value)}>
                    <option value="sample">No contact — sample data</option>
                    {(testContacts.data?.rows ?? []).map((r: any) => (
                      <option key={r.id} value={r.id}>
                        {r.business_name} · {r.email}
                      </option>
                    ))}
                  </Select>
                  {testContacts.data?.degraded && (
                    <div className="text-xs text-red-400">
                      ⚠ This campaign's audience could not be evaluated, so no contact can be picked.
                    </div>
                  )}
                  {testContacts.data && testContacts.data.total === 0 && (
                    <div className="text-xs text-amber-400">
                      This campaign's audience is empty — the test will render with sample data.
                    </div>
                  )}
                  {!!testContacts.data?.total && (
                    <div className="text-xs text-[var(--muted)]">
                      Searches this campaign's audience ({testContacts.data.total} contact
                      {testContacts.data.total === 1 ? "" : "s"}).
                      {testContacts.data.truncated ? " Only the first 20,000 are searched." : ""}
                    </div>
                  )}

                  {/* The values that will be used, shown BEFORE sending — the
                      resolved link is the thing a test is for. */}
                  {testRender.data && (
                    <div className="rounded border border-[var(--border)] bg-[var(--background)] p-3 grid grid-cols-1 gap-2 min-w-0">
                      <div className="text-xs text-[var(--muted)]">
                        {testRender.data.render_source === "contact" ? (
                          <>
                            Renders as <span className="text-white">{testRender.data.render_contact?.business_name}</span>
                            {testRender.data.render_contact?.email ? ` · ${testRender.data.render_contact.email}` : ""}
                          </>
                        ) : (
                          <>No contact selected — this test renders with the shared sample data.</>
                        )}
                      </div>
                      {(testRender.data.links ?? []).map((l: any) => (
                        <div key={l.name} className="text-xs break-all">
                          <span className="text-[var(--muted)]">{l.name}: </span>
                          <a href={l.url} target="_blank" rel="noreferrer" className="text-blue-400 underline">
                            {l.url}
                          </a>
                        </div>
                      ))}
                      {(testRender.data.empty ?? []).length > 0 && (
                        <div className="text-xs text-amber-400">
                          ⚠ Rendered empty: {(testRender.data.empty ?? []).join(", ")}
                        </div>
                      )}
                      {(testRender.data.links ?? []).length === 0 && (testRender.data.empty ?? []).length === 0 && (
                        <div className="text-xs text-[var(--muted)]">No link variables in this template.</div>
                      )}
                    </div>
                  )}
                  {testRender.isError && (
                    <div className="text-xs text-red-400">{errorOf(testRender.error)}</div>
                  )}
                </>
              )}
            </Card>

            {editing && (
              <Card className="p-5">
                <div className="text-sm font-medium mb-3">Live stats</div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {statsRows.length === 0 && <div className="text-[var(--muted)] col-span-2">No sends yet.</div>}
                  {statsRows.map((s: any) => (
                    <div key={s.status} className="flex justify-between bg-[var(--background)] rounded px-3 py-2">
                      <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                      <span className="font-mono">{s.n}</span>
                    </div>
                  ))}
                </div>
                {stats.data?.engagement && (
                  <>
                    <div className="text-xs uppercase tracking-wide text-[var(--muted)] mt-4 mb-2">Engagement</div>
                    {/* Per-recipient summary, so the counts have context. */}
                    <div className="text-xs text-[var(--muted)] mb-2">
                      <span className="text-white font-mono">{Number(stats.data.total ?? 0)}</span> sent ·{" "}
                      <span className="text-white font-mono">{Number(stats.data.engagement?.opened ?? 0)}</span> opened ·{" "}
                      <span className="text-white font-mono">{Number(stats.data.engagement?.clicked ?? 0)}</span> clicked
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      {(["delivered", "opened", "clicked", "bounced"] as const).map((k) => (
                        <div key={k} className="flex justify-between bg-[var(--background)] rounded px-3 py-2">
                          <span className="capitalize text-[var(--muted)]">{k}</span>
                          <span className="font-mono">{Number(stats.data.engagement?.[k] ?? 0)}</span>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-[var(--muted)] mt-3">
                      Opens/clicks appear only if tracking is enabled on the SMTP2GO template and Open/Click webhooks are subscribed.
                    </p>
                  </>
                )}
              </Card>
            )}
          </div>
        </div>

        {editing && (
          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div className="text-sm font-medium">Recipients</div>
              {recipients.data?.counts && (
                <div className="text-xs text-[var(--muted)]">
                  <span className="text-white font-mono">{recipients.data.counts.total}</span> sent ·{" "}
                  <span className="text-white font-mono">{recipients.data.counts.delivered}</span> delivered ·{" "}
                  <span className="text-white font-mono">{recipients.data.counts.opened}</span> opened ·{" "}
                  <span className="text-white font-mono">{recipients.data.counts.clicked}</span> clicked ·{" "}
                  <span className="text-white font-mono">{recipients.data.counts.bounced}</span> bounced
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 mb-3">
              <Select
                value={recipientFilter}
                onChange={(e) => {
                  setRecipientFilter(e.target.value as any);
                  setRecipientOffset(0);
                }}
              >
                <option value="all">All recipients</option>
                <option value="opened">Opened</option>
                <option value="clicked">Clicked</option>
                <option value="delivered">Delivered</option>
                <option value="bounced">Bounced</option>
                <option value="not-opened">Not opened</option>
              </Select>
              <Select
                value={recipientSort}
                onChange={(e) => {
                  setRecipientSort(e.target.value as any);
                  setRecipientOffset(0);
                }}
              >
                <option value="recent">Most recent send</option>
                <option value="engagement">Most recent open/click</option>
              </Select>
              <Input
                className="flex-1 min-w-[12rem]"
                placeholder="Search email or name…"
                value={recipientSearchInput}
                onChange={(e) => setRecipientSearchInput(e.target.value)}
              />
            </div>

            {recipients.isError && (
              <div className="text-xs text-red-400 mb-2">{errorOf(recipients.error)}</div>
            )}
            {recipients.data && recipients.data.total === 0 && (
              <div className="text-xs text-[var(--muted)] mb-2">
                {recipients.data.counts?.total
                  ? "No recipients match this filter."
                  : "No sends yet."}
              </div>
            )}

            {!!recipients.data?.rows?.length && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                      <th className="py-2 pr-3">Recipient</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">Sent</th>
                      <th className="py-2 pr-3">Delivered</th>
                      <th className="py-2 pr-3">Opened</th>
                      <th className="py-2 pr-3">Clicked</th>
                      <th className="py-2 pr-3">Bounced</th>
                      <th className="py-2 pr-3">SMTP2Go</th>
                      <th className="py-2">GHL contact</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipients.data.rows.map((r: any) => (
                      <tr key={r.id} className="border-t border-[var(--border)] align-top">
                        <td className="py-2 pr-3">
                          <div className="text-white">{r.name || r.email}</div>
                          {r.name && <div className="text-xs text-[var(--muted)]">{r.email}</div>}
                        </td>
                        <td className="py-2 pr-3">
                          <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                        </td>
                        <td className="py-2 pr-3 text-[var(--muted)] whitespace-nowrap">{fmtRecipientTime(r.sent_at)}</td>
                        <td className="py-2 pr-3 text-[var(--muted)] whitespace-nowrap">{fmtRecipientTime(r.delivered_at)}</td>
                        <td className="py-2 pr-3 text-[var(--muted)] whitespace-nowrap">{fmtRecipientTime(r.opened_at)}</td>
                        <td className="py-2 pr-3 text-[var(--muted)] whitespace-nowrap">{fmtRecipientTime(r.clicked_at)}</td>
                        <td className="py-2 pr-3 text-[var(--muted)] whitespace-nowrap">{fmtRecipientTime(r.bounced_at)}</td>
                        <td className="py-2 pr-3 font-mono text-xs text-[var(--muted)]">{r.smtp2go_id || "—"}</td>
                        <td
                          className="py-2 font-mono text-xs text-[var(--muted)]"
                          title={r.ghl_contact_id ? `GHL contact ${r.ghl_contact_id}` : "No GHL contact"}
                        >
                          {r.ghl_contact_id || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {recipients.data && recipients.data.total > 0 && (
              <div className="flex items-center justify-between mt-3 text-xs text-[var(--muted)]">
                <div>
                  Showing {recipients.data.offset + 1}–
                  {Math.min(recipients.data.offset + recipients.data.rows.length, recipients.data.total)} of{" "}
                  {recipients.data.total}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={recipients.data.offset <= 0 || recipients.isFetching}
                    onClick={() =>
                      setRecipientOffset(Math.max(0, recipients.data.offset - RECIPIENT_PAGE))
                    }
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    disabled={
                      recipients.data.offset + RECIPIENT_PAGE >= recipients.data.total ||
                      recipients.isFetching
                    }
                    onClick={() => setRecipientOffset(recipients.data.offset + RECIPIENT_PAGE)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
            <p className="text-xs text-[var(--muted)] mt-3">
              One row per send. Opens/clicks appear only if tracking is enabled on the SMTP2GO
              template and Open/Click webhooks are subscribed.
            </p>
          </Card>
        )}
      </Page>
    </>
  );
}
