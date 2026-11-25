import Link from "next/link";

const TABS = [
  ["/settings", "Company"],
  ["/settings/users", "Users"],
  ["/settings/airtable", "Airtable"],
  ["/settings/log", "Connector log"],
] as const;

export function SettingsNav({ at }: { at: string }) {
  return (
    <nav className="mb-6 flex flex-wrap gap-2 text-sm" aria-label="Settings">
      {TABS.map(([href, label]) => (
        <Link key={href} href={href} className={`rounded-full px-3 py-1 ${at === href ? "bg-gra-blue text-white" : "bg-white text-gra-ink-2"}`}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
