import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, Input, Textarea, Button, Label, Select } from "./ui";
import { api } from "../api";
import { htmlToText, isPlainOnlyHtml, textToPlainHtml } from "../lib/htmlToText";
import { plainTextToHtml } from "../../shared/body";

/**
 * The one email editor.
 *
 * This is the Templates page editor, extracted so the sequence builder's step
 * panel uses exactly the same component instead of a second, drifting one.
 * It owns subject + body (HTML and plain-text) + live preview + the optional
 * variables list and test-send control.
 *
 * `plainTextOnly` is the sequence-step mode: only a plain-text body, with no
 * content-type switch and no formatting controls. The body text is converted to
 * paragraph HTML with the shared `plainTextToHtml` helper, so blank lines still
 * separate paragraphs on send. Templates keep the full HTML + plain-text editor.
 *
 * The component is UNCONTROLLED as to layout mode: it owns the html/text
 * toggle, the plain-only mode and the auto-generated text state, all seeded
 * from `value` when it MOUNTS. Give it a React `key` per document (template id,
 * step id) so switching documents remounts it with fresh state.
 *
 * `value.html` is always the effective HTML body: when "plain text only" is on,
 * editing the text also rewrites `html` to the wrapped plain-text document, so
 * a caller can save `value` verbatim.
 *
 * `layout` selects which pane(s) to render, so a caller can drive one tab per
 * pane (the full-screen editor) without forking the editor:
 *   "split" (default) — editor + preview side by side
 *   "editor"          — the editor only
 *   "preview"         — the rendered preview only
 *   "variables"       — the detected/available variables list only
 */
export interface EmailEditorValue {
  subject: string;
  html: string;
  text: string;
  isBase?: number;
}

export interface TestSendSpec {
  onSend: (email: string) => void;
  pending?: boolean;
  hint?: string;
}

export type EmailEditorLayout = "split" | "editor" | "preview" | "variables";

export function EmailEditor({
  value,
  onChange,
  showBaseToggle = false,
  variables,
  testSend,
  className = "",
  layout = "split",
  plainTextOnly = false,
  previewHtml,
}: {
  value: EmailEditorValue;
  onChange: (patch: Partial<EmailEditorValue>) => void;
  /** Templates page only: the "base template" checkbox. */
  showBaseToggle?: boolean;
  /** Variable names available to this document (rendered as a hint list). */
  variables?: string[];
  /** Optional test-send control (docked step panel). */
  testSend?: TestSendSpec;
  className?: string;
  /** Which pane(s) to render. Default "split" (editor + preview). */
  layout?: EmailEditorLayout;
  /** Sequence-step mode: a plain-text body only, no HTML/formatting controls. */
  plainTextOnly?: boolean;
  /** Override the preview body (e.g. a step merged into its attached template). */
  previewHtml?: string;
}) {
  const seededPlain = plainTextOnly || (isPlainOnlyHtml(value.html) && !!(value.text ?? "").trim());
  const [plainOnly, setPlainOnly] = useState(seededPlain);
  const [bodyMode, setBodyMode] = useState<"html" | "text">(seededPlain ? "text" : "html");
  const [previewMode, setPreviewMode] = useState<"html" | "text">(seededPlain ? "text" : "html");
  const [autoText, setAutoText] = useState(!seededPlain && !(value.text ?? "").trim());
  const [testEmail, setTestEmail] = useState("");
  const htmlRef = useRef<HTMLTextAreaElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  // Placeholder chips are drawn from the audience the operator picks: custom
  // attributes are stored per contact, so unscoped they are every column from
  // every import. Default "all" keeps the previous behaviour.
  const [fieldScope, setFieldScope] = useState<{ source: "all" | "list" | "segment"; id: string }>({
    source: "all",
    id: "",
  });
  const lists = useQuery({ queryKey: ["lists"], queryFn: () => api("/api/lists") });
  const scopeParam =
    fieldScope.source !== "all" && fieldScope.id
      ? `${fieldScope.source === "list" ? "list_id" : "segment_id"}=${fieldScope.id}`
      : "";
  const fields = useQuery({
    queryKey: ["contact-fields", `editor:${scopeParam}`],
    queryFn: () => api(`/api/contacts/fields${scopeParam ? `?${scopeParam}` : ""}`),
  });

  /** Insert a {{placeholder}} at the caret of whichever body box is in use. */
  const insertToken = (path: string) => {
    // A read-only auto-generated text box takes no edits, so the HTML box is the
    // target there and the plain-text fallback regenerates itself.
    const useText = plainTextOnly || plainOnly || (bodyMode === "text" && !autoText);
    const el = useText ? textRef.current : htmlRef.current;
    const token = `{{${path}}}`;
    if (!el) {
      onChange(useText ? { text: `${value.text ?? ""}${token}` } : { html: `${value.html ?? ""}${token}` });
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = el.value.slice(0, start) + token + el.value.slice(end);
    onChange(useText ? { text: next } : { html: next });
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // Auto-generate the plain-text fallback from the HTML body.
  useEffect(() => {
    if (plainTextOnly || plainOnly || !autoText) return;
    const next = htmlToText(value.html);
    if (next !== (value.text ?? "")) onChange({ text: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.html, autoText, plainOnly, plainTextOnly]);

  const togglePlainOnly = (on: boolean) => {
    setPlainOnly(on);
    if (on) {
      const t = (value.text ?? "").trim() ? value.text : htmlToText(value.html);
      onChange({ text: t, html: textToPlainHtml(t) });
      setBodyMode("text");
      setPreviewMode("text");
    } else {
      setBodyMode("html");
      setPreviewMode("html");
    }
  };

  const editText = (t: string) => {
    // The step editor keeps the HTML in step with the plain text as paragraphs.
    if (plainTextOnly) {
      onChange({ text: t, html: plainTextToHtml(t) });
      return;
    }
    // In plain-only mode the HTML is derived from the text on every keystroke.
    onChange(plainOnly ? { text: t, html: textToPlainHtml(t) } : { text: t });
  };

  const sub = (s: string) =>
    s
      .replace(/\{\{\s*first_name\s*\}\}/g, "Alex")
      .replace(/\{\{\s*practice_name\s*\}\}/g, "Riverside Clinic")
      .replace(/\{\{\s*email\s*\}\}/g, "alex@example.com");
  const htmlPreview = sub(previewHtml ?? value.html);
  const textPreview = sub(value.text);
  // Templates can preview either half; a step's body is always shown rendered.
  const showHtmlPreview = plainTextOnly || (!plainOnly && previewMode === "html");

  // Every {{token}} written in the subject or either body, in order.
  const usedVars: string[] = [];
  {
    const re = /\{\{\s*([a-zA-Z0-9_][a-zA-Z0-9_.-]*)\s*\}\}/g;
    const hay = `${value.subject ?? ""}\n${value.html ?? ""}\n${value.text ?? ""}`;
    let m: RegExpExecArray | null;
    while ((m = re.exec(hay))) if (!usedVars.includes(m[1])) usedVars.push(m[1]);
  }
  const availableVars = ["first_name", "practice_name", "email", ...(variables ?? [])].filter(
    (v, i, a) => a.indexOf(v) === i,
  );

  const editorPane = (
    <Card className="p-5 flex flex-col gap-4 h-full">
      {showBaseToggle && (
        <div>
          <label className="flex items-start gap-2 text-xs text-[var(--muted)]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={!!value.isBase}
              onChange={(e) => onChange({ isBase: e.target.checked ? 1 : 0 })}
            />
            <span>
              Base template — supplies the chrome (header/footer/styles) while each campaign writes its own
              content. Put <code>{"{{content}}"}</code> where the campaign content should land. Existing
              campaigns keep working either way.
            </span>
          </label>
        </div>
      )}
      <div>
        <Label>Subject (supports {`{{vars}}`})</Label>
        <Input value={value.subject} onChange={(e) => onChange({ subject: e.target.value })} />
      </div>
      {!plainTextOnly && (
        <div>
          <Label>Content type</Label>
          <div className="flex gap-1 p-0.5 rounded-md bg-[var(--background)] border border-[var(--border)] w-fit">
            <Button
              variant={!plainOnly ? "primary" : "ghost"}
              onClick={() => togglePlainOnly(false)}
              className="!px-2.5 !py-1 text-xs"
            >
              HTML + plain text
            </Button>
            <Button
              variant={plainOnly ? "primary" : "ghost"}
              onClick={() => togglePlainOnly(true)}
              className="!px-2.5 !py-1 text-xs"
            >
              Plain text only
            </Button>
          </div>
        </div>
      )}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-1.5 gap-3 flex-wrap">
          <label className="block text-xs text-[var(--muted)] uppercase tracking-wide">
            {plainTextOnly ? "Body (plain text)" : "Body"}
          </label>
          <div className="flex items-center gap-3">
            {!plainTextOnly && !plainOnly && bodyMode === "text" && (
              <>
                <label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
                  <input type="checkbox" checked={autoText} onChange={(e) => setAutoText(e.target.checked)} />
                  Auto-generate from HTML
                </label>
                {!autoText && (
                  <Button
                    variant="outline"
                    className="!px-2.5 !py-1 text-xs"
                    onClick={() => onChange({ text: htmlToText(value.html) })}
                  >
                    Generate from HTML
                  </Button>
                )}
              </>
            )}
            {!plainTextOnly && !plainOnly && (
              <div className="flex gap-1 p-0.5 rounded-md bg-[var(--background)] border border-[var(--border)]">
                <Button
                  variant={bodyMode === "html" ? "primary" : "ghost"}
                  onClick={() => setBodyMode("html")}
                  className="!px-2.5 !py-1 text-xs"
                >
                  HTML
                </Button>
                <Button
                  variant={bodyMode === "text" ? "primary" : "ghost"}
                  onClick={() => setBodyMode("text")}
                  className="!px-2.5 !py-1 text-xs"
                >
                  Plain text
                </Button>
              </div>
            )}
          </div>
        </div>
        {!plainTextOnly && !plainOnly && bodyMode === "html" ? (
          <Textarea
            ref={htmlRef}
            className="flex-1 min-h-0 resize-none"
            value={value.html}
            onChange={(e) => onChange({ html: e.target.value })}
          />
        ) : (
          <Textarea
            ref={textRef}
            className="flex-1 min-h-0 resize-none"
            value={value.text}
            readOnly={!plainTextOnly && !plainOnly && autoText}
            onChange={(e) => editText(e.target.value)}
            placeholder={plainTextOnly ? "Write the email as plain text" : plainOnly ? "Plain-text email body" : "Plain-text fallback (optional)"}
          />
        )}
        <div className="text-xs text-[var(--muted)] mt-1">
          {plainTextOnly ? (
            <>
              Plain text — a blank line starts a new paragraph. Variables:{" "}
              <code>{`{{first_name}}`}</code>, <code>{`{{practice_name}}`}</code>, <code>{`{{email}}`}</code>, plus any
              CSV column.
            </>
          ) : !plainOnly && bodyMode === "text" && autoText ? (
            "Auto-generated from the HTML body. Untick to edit by hand."
          ) : (
            <>
              Variables: <code>{`{{first_name}}`}</code>, <code>{`{{practice_name}}`}</code>,{" "}
              <code>{`{{email}}`}</code>, plus any CSV column.
            </>
          )}
        </div>
      </div>

      {variables && variables.length > 0 && (
        <div className="text-xs text-[var(--muted)]">
          <span className="uppercase tracking-wide">Detected variables: </span>
          <span className="flex flex-wrap gap-1 mt-1">
            {variables.map((v) => (
              <code key={v} className="px-1.5 py-0.5 rounded bg-[var(--background)] border border-[var(--border)]">
                {`{{${v}}}`}
              </code>
            ))}
          </span>
        </div>
      )}

      {testSend && (
        <div className="border-t border-[var(--border)] pt-3">
          <Label>Test send</Label>
          <div className="flex items-center gap-2">
            <Input
              placeholder="you@example.com"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              type="email"
            />
            <Button
              variant="outline"
              disabled={!testEmail || !!testSend.pending}
              onClick={() => testSend.onSend(testEmail.trim())}
            >
              {testSend.pending ? "Sending…" : "Send test"}
            </Button>
          </div>
          {testSend.hint && <p className="text-xs text-[var(--muted)] mt-1">{testSend.hint}</p>}
        </div>
      )}
    </Card>
  );

  const previewPane = (
    <Card className={`${layout === "split" ? "xl:sticky xl:top-6 " : ""}h-full flex flex-col`}>
      <div className="px-5 py-3 border-b border-[var(--border)] flex items-center justify-between">
        <div className="text-sm font-medium">Preview (sample data)</div>
        {!plainTextOnly && !plainOnly && (
          <div className="flex gap-1 p-0.5 rounded-md bg-[var(--background)] border border-[var(--border)]">
            <Button
              variant={previewMode === "html" ? "primary" : "ghost"}
              onClick={() => setPreviewMode("html")}
              className="!px-2.5 !py-1 text-xs"
            >
              HTML
            </Button>
            <Button
              variant={previewMode === "text" ? "primary" : "ghost"}
              onClick={() => setPreviewMode("text")}
              className="!px-2.5 !py-1 text-xs"
            >
              Plain text
            </Button>
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0">
        {showHtmlPreview ? (
          <iframe className="w-full h-full bg-white" srcDoc={htmlPreview} title="Email preview" />
        ) : (
          <pre className="w-full h-full overflow-auto p-4 text-xs font-mono whitespace-pre-wrap bg-[var(--background)] text-white m-0">
            {textPreview || <span className="text-[var(--muted)]">No plain-text content yet.</span>}
          </pre>
        )}
      </div>
    </Card>
  );

  const variablesPane = (
    <Card className="p-5 h-full overflow-auto flex flex-col gap-4">
      <div>
        <div className="text-sm font-medium">Variables</div>
        <p className="text-xs text-[var(--muted)] mt-0.5">
          Substituted at send time. Names come from the contact; anything else resolves against a CSV column or
          contact attribute.
        </p>
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-[var(--muted)] mb-1">Used in this email</div>
        {usedVars.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {usedVars.map((v) => (
              <code key={v} className="px-1.5 py-0.5 rounded bg-[var(--background)] border border-[var(--border)]">
                {`{{${v}}}`}
              </code>
            ))}
          </div>
        ) : (
          <p className="text-xs text-[var(--muted)]">Nothing referenced yet.</p>
        )}
      </div>
      <div>
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="text-xs uppercase tracking-wide text-[var(--muted)]">Available</div>
          <span className="text-xs text-[var(--muted)] truncate">{fields.data?.scope_label ?? "All contacts"} · click to insert</span>
        </div>
        <div className="flex gap-2 flex-wrap mb-2">
          <Select
            value={fieldScope.source}
            onChange={(e) => setFieldScope({ source: e.target.value as any, id: "" })}
            className="!w-auto !py-1 !text-xs"
          >
            <option value="all">All contacts</option>
            <option value="list">Static list</option>
            <option value="segment">Segment</option>
          </Select>
          {fieldScope.source !== "all" && (
            <Select
              value={fieldScope.id}
              onChange={(e) => setFieldScope({ ...fieldScope, id: e.target.value })}
              className="!w-auto !py-1 !text-xs"
            >
              <option value="">{`Choose ${fieldScope.source}…`}</option>
              {(lists.data?.rows ?? [])
                .filter((l: any) => (fieldScope.source === "segment" ? l.kind === "segment" : l.kind !== "segment"))
                .map((l: any) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
            </Select>
          )}
        </div>
        {fields.data?.scope_warning && (
          <p className="text-xs text-amber-400 mb-1">⚠ {fields.data.scope_warning}</p>
        )}
        <div className="flex flex-wrap gap-1">
          {[...(fields.data?.fixed ?? []), ...(fields.data?.attributes ?? [])].map((f: any) => (
            <button
              key={f.path}
              type="button"
              title={`Insert {{${f.path}}}`}
              onClick={() => insertToken(f.path)}
              className="px-1.5 py-0.5 rounded bg-[var(--background)] border border-[var(--border)] font-mono text-[11px] hover:bg-[var(--accent)]"
            >{`{{${f.path}}}`}</button>
          ))}
          {!fields.data &&
            availableVars.map((v) => (
              <code key={v} className="px-1.5 py-0.5 rounded bg-[var(--background)] border border-[var(--border)]">
                {`{{${v}}}`}
              </code>
            ))}
        </div>
      </div>
    </Card>
  );

  if (layout === "editor") {
    return <div className={`h-full min-h-0 flex flex-col ${className}`}>{editorPane}</div>;
  }
  if (layout === "preview") {
    return <div className={`h-full min-h-0 flex flex-col ${className}`}>{previewPane}</div>;
  }
  if (layout === "variables") {
    return <div className={`h-full min-h-0 flex flex-col ${className}`}>{variablesPane}</div>;
  }
  return (
    <div className={`grid grid-cols-1 xl:grid-cols-2 gap-6 items-stretch min-h-[600px] ${className}`}>
      {editorPane}
      {previewPane}
    </div>
  );
}
