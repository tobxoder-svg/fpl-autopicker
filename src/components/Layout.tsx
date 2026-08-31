import { NavLink, Outlet } from "react-router-dom";
import { useEffect, useState } from "react";

const REPO = "https://github.com/tobxoder-svg/fantasy-drafter";

type Theme = "light" | "dark" | "system";

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem("fd-theme");
      return stored === "light" || stored === "dark" ? stored : "system";
    } catch {
      return "system";
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem("fd-theme");
      else localStorage.setItem("fd-theme", theme);
    } catch {
      /* private mode — the choice just won't persist */
    }
  }, [theme]);

  return [theme, setTheme];
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const order: Theme[] = ["system", "light", "dark"];
  const label = { system: "Auto", light: "Light", dark: "Dark" }[theme];
  return (
    <button
      type="button"
      onClick={() => setTheme(order[(order.indexOf(theme) + 1) % order.length])}
      className="font-mono text-[11px] tracking-wide uppercase text-ink-2 border border-line-strong rounded px-2.5 py-1.5 hover:bg-surface-2 hover:text-ink transition-colors"
      aria-label={`Theme: ${label}. Click to change.`}
    >
      {label}
    </button>
  );
}

function Tab({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        [
          "px-2.5 sm:px-3 py-1.5 rounded text-[13.5px] font-medium transition-colors whitespace-nowrap",
          isActive ? "bg-accent-soft text-accent" : "text-ink-2 hover:text-ink hover:bg-surface-2",
        ].join(" ")
      }
    >
      {children}
    </NavLink>
  );
}

export default function Layout() {
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="border-b border-line bg-surface/80 backdrop-blur-sm sticky top-0 z-30">
        <div className="max-w-[1180px] mx-auto px-4 sm:px-5 h-14 flex items-center gap-2 sm:gap-4">
          <NavLink to="/" className="flex items-center gap-2.5 sm:mr-2 shrink-0">
            <span
              aria-hidden
              className="w-6 h-6 rounded-md bg-accent text-accent-ink grid place-items-center font-display font-bold text-[12px] leading-none"
            >
              FD
            </span>
            <span className="hidden sm:inline font-display font-semibold text-[15.5px] tracking-tight">
              Fantasy Drafter
            </span>
          </NavLink>

          <nav className="flex items-center gap-1" aria-label="Main">
            <Tab to="/">Overview</Tab>
            <Tab to="/builder">Builder</Tab>
            <Tab to="/method">Method</Tab>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <a
              href={REPO}
              target="_blank"
              rel="noreferrer noopener"
              className="hidden sm:inline font-mono text-[11px] tracking-wide uppercase text-ink-2 border border-line-strong rounded px-2.5 py-1.5 hover:bg-surface-2 hover:text-ink transition-colors"
            >
              Source
            </a>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-line mt-16">
        <div className="max-w-[1180px] mx-auto px-5 py-8 flex flex-wrap gap-x-8 gap-y-3 items-baseline text-[12.5px] text-ink-muted">
          <span>
            Fantasy Drafter — an independent tool. Not affiliated with, endorsed by, or connected to
            the Premier League or Fantasy Premier League.
          </span>
          <a href={REPO} target="_blank" rel="noreferrer noopener" className="hover:text-ink underline underline-offset-2 ml-auto">
            Source on GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
