import { Component, ReactNode } from "react";
import { Routes, Route, NavLink, Navigate } from "react-router-dom";
import { LayoutDashboard, Users, Mail, FileText, ShieldOff, Settings, Send, Tags, GitBranch } from "lucide-react";
import Dashboard from "./pages/Dashboard";
import Contacts from "./pages/Contacts";
import Suppressions from "./pages/Suppressions";
import Templates from "./pages/Templates";
import TemplateEdit from "./pages/TemplateEdit";
import Campaigns from "./pages/Campaigns";
import CampaignEdit from "./pages/CampaignEdit";
import Sequences from "./pages/Sequences";
import SequenceEdit from "./pages/SequenceEdit";
import SequenceDetail from "./pages/SequenceDetail";
import SettingsPage from "./pages/Settings";
import Imports from "./pages/Imports";
import Lists from "./pages/Lists";

const nav = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/campaigns", label: "Campaigns", icon: Send },
  { to: "/sequences", label: "Sequences", icon: GitBranch },
  { to: "/contacts", label: "Contacts", icon: Users },
  { to: "/lists", label: "Lists & tags", icon: Tags },
  { to: "/templates", label: "Templates", icon: FileText },
  { to: "/suppressions", label: "Suppressions", icon: ShieldOff },
  { to: "/imports", label: "Imports", icon: Mail },
  { to: "/settings", label: "Settings", icon: Settings },
];

export default function App() {
  return (
    <div className="grid grid-cols-[240px_1fr] h-full">
      <aside className="border-r border-[var(--border)] bg-[var(--card)] flex flex-col">
        <div className="px-5 py-5 text-lg font-semibold tracking-tight">
          <span className="text-[var(--primary)]">●</span> Bulk Emailer
        </div>
        <nav className="px-2 flex-1">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-md text-sm mb-0.5 ${
                  isActive
                    ? "bg-[var(--accent)] text-white"
                    : "text-[var(--muted)] hover:text-white hover:bg-[var(--accent)]/60"
                }`
              }
            >
              <n.icon size={16} />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-5 py-3 text-xs text-[var(--muted)] border-t border-[var(--border)]">
          Cloudflare Workers · D1 · SMTP2GO
        </div>
      </aside>
      <main className="overflow-auto">
        <ScreenErrorBoundary>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/campaigns/new" element={<CampaignEdit />} />
            <Route path="/campaigns/:id" element={<CampaignEdit />} />
            <Route path="/sequences" element={<Sequences />} />
            <Route path="/sequences/:id" element={<SequenceDetail />} />
            <Route path="/sequences/:id/edit" element={<SequenceEdit />} />
            <Route path="/contacts" element={<Contacts />} />
            <Route path="/lists" element={<Lists />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/templates/new" element={<TemplateEdit />} />
            <Route path="/templates/:id" element={<TemplateEdit />} />
            <Route path="/suppressions" element={<Suppressions />} />
            <Route path="/imports" element={<Imports />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ScreenErrorBoundary>
      </main>
    </div>
  );
}

class ScreenErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="p-8">
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg p-5 max-w-2xl">
          <h1 className="text-xl font-semibold">Screen error</h1>
          <p className="text-sm text-[var(--muted)] mt-2">The app caught a rendering error instead of going blank.</p>
          <pre className="mt-4 bg-[var(--background)] border border-[var(--border)] rounded p-3 text-xs whitespace-pre-wrap text-red-400">
            {this.state.error.message}
          </pre>
        </div>
      </div>
    );
  }
}
