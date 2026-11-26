import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Page, PageHeader, Card, Badge, statusTone } from "../components/ui";
import { Link } from "react-router-dom";

export default function Dashboard() {
  const stats = useQuery({ queryKey: ["contact-stats"], queryFn: () => api("/api/contacts/stats") });
  const campaigns = useQuery({ queryKey: ["campaigns"], queryFn: () => api("/api/campaigns") });
  const suppressions = useQuery({ queryKey: ["suppressions", 1], queryFn: () => api("/api/suppressions?pageSize=1") });

  const totalContacts = stats.data?.stats?.reduce((s: number, x: any) => s + x.n, 0) ?? 0;
  const active = stats.data?.stats?.find((x: any) => x.status === "active")?.n ?? 0;

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Live overview of your sending operation" />
      <Page>
        <div className="grid grid-cols-4 gap-4">
          <Stat label="Total contacts" value={totalContacts} />
          <Stat label="Active" value={active} />
          <Stat label="Suppressed" value={suppressions.data?.total ?? 0} />
          <Stat label="Campaigns" value={campaigns.data?.rows?.length ?? 0} />
        </div>

        <Card>
          <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
            <h2 className="font-medium">Recent campaigns</h2>
            <Link to="/campaigns" className="text-sm text-[var(--primary)]">View all →</Link>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_repeat(6,minmax(3.5rem,auto))_auto] items-center gap-x-4 px-5 py-2 text-xs text-[var(--muted)] border-b border-[var(--border)]">
            <div>Campaign</div>
            <div className="text-right hidden lg:block">Sent</div>
            <div className="text-right hidden lg:block">Opens</div>
            <div className="text-right hidden lg:block">Clicks</div>
            <div className="text-right hidden lg:block">CTR</div>
            <div className="text-right hidden lg:block">Bounces</div>
            <div className="text-right hidden lg:block">Unsub</div>
            <div className="text-right">Status</div>
          </div>
          <div>
            {(campaigns.data?.rows ?? []).slice(0, 8).map((c: any) => {
              const sent = Number(c.sent ?? 0);
              const opened = Number(c.opened ?? 0);
              const clicked = Number(c.clicked ?? 0);
              const bounced = Number(c.bounced ?? 0);
              const unsub = Number(c.unsubscribed ?? 0);
              const openRate = sent > 0 ? Math.round((opened / sent) * 100) : 0;
              const ctr = sent > 0 ? Math.round((clicked / sent) * 100) : 0;
              return (
                <Link
                  key={c.id}
                  to={`/campaigns/${c.id}`}
                  className="grid grid-cols-[minmax(0,1fr)_repeat(6,minmax(3.5rem,auto))_auto] items-center gap-x-4 gap-y-1 px-5 py-3 border-b border-[var(--border)] last:border-0 hover:bg-[var(--accent)]/40"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">{c.name}</div>
                    <div className="text-xs text-[var(--muted)]">
                      {new Date(c.created_at * 1000).toLocaleString()}
                    </div>
                  </div>
                  <div className="text-right text-xs tabular-nums hidden lg:block">{sent.toLocaleString()}</div>
                  <div className="text-right text-xs tabular-nums hidden lg:block">{opened.toLocaleString()} <span className="text-[var(--muted)]">({openRate}%)</span></div>
                  <div className="text-right text-xs tabular-nums hidden lg:block">{clicked.toLocaleString()}</div>
                  <div className="text-right text-xs tabular-nums hidden lg:block">{ctr}%</div>
                  <div className="text-right text-xs tabular-nums hidden lg:block">{bounced.toLocaleString()}</div>
                  <div className="text-right text-xs tabular-nums hidden lg:block">{unsub.toLocaleString()}</div>
                  <div className="text-right"><Badge tone={statusTone(c.status)}>{c.status}</Badge></div>
                </Link>
              );
            })}
            {!campaigns.data?.rows?.length && (
              <div className="px-5 py-10 text-center text-sm text-[var(--muted)]">
                No campaigns yet. <Link to="/campaigns/new" className="text-[var(--primary)]">Create one →</Link>
              </div>
            )}
          </div>
        </Card>
      </Page>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <Card className="p-5">
      <div className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="text-3xl font-semibold mt-2">{value.toLocaleString?.() ?? value}</div>
    </Card>
  );
}
