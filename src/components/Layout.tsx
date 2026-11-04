import { NavLink, Outlet } from "react-router-dom";
import { useEffect, useState } from "react";

// The folder is called fantasy-drafter; the repo is fpl-autopicker. The
// fantasy-drafter repo is a stale manual upload — don't point people at it.
const REPO = "https://github.com/tobxoder-svg/fpl-autopicker";

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

const THEME_OPTIONS: Array<{ value: Theme; label: string; icon: React.ReactNode }> = [
  {
    value: "system",
    label: "Auto",
    icon: (
      <>
        <circle cx="12" cy="12" r="8.75" />
        <path d="M12 3.25a8.75 8.75 0 0 1 0 17.5z" fill="currentColor" stroke="none" />
      </>
    ),
  },
  {
    value: "light",
    label: "Light",
    icon: (
      <>
        <circle cx="12" cy="12" r="4.25" />
        <path d="M12 2v2.2M12 19.8V22M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2 12h2.2M19.8 12H22M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
      </>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: <path d="M20.5 14.3A8.75 8.75 0 1 1 9.7 3.5a7 7 0 0 0 10.8 10.8z" />,
  },
];

/**
 * Three explicit choices rather than a cycling button: a single button that
 * relabels itself gives no hint that it controls the theme, nor what the other
 * states are. "Auto" tracks the OS and is the default.
 */
function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-lg border border-line-strong bg-surface-2 p-0.5"
    >
      {THEME_OPTIONS.map((opt) => {
        const active = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={`${opt.label} theme`}
            onClick={() => setTheme(opt.value)}
            className={[
              "relative flex items-center gap-1.5 rounded-md font-mono text-[11px]",
              "uppercase tracking-wide transition-colors",
              // Roomy enough to hit with a thumb on a phone; tightens up once
              // the labels appear and a mouse is the likely input.
              "px-3 py-2 md:px-2 md:py-1",
              // Stretches the touch target to ~46px tall without changing how
              // big the control looks. Safe vertically — the header has slack
              // above and below, and the segments only neighbour each other
              // horizontally.
              "after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']",
              active
                ? "bg-accent text-accent-ink"
                : "text-ink-muted hover:bg-surface-3 hover:text-ink",
            ].join(" ")}
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden
              className="w-[17px] h-[17px] md:w-[14px] md:h-[14px] shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {opt.icon}
            </svg>
            <span className="hidden md:inline">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Chrome on Android fires `beforeinstallprompt` once the app qualifies as
 * installable. Holding on to it lets us offer a real Install button instead of
 * relying on people finding "Add to Home screen" in the browser menu.
 */
function useInstallPrompt(): [InstallPromptEvent | null, () => void] {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPromptEvent(e as InstallPromptEvent);
    };
    const onInstalled = () => setPromptEvent(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  const install = () => {
    if (!promptEvent) return;
    void promptEvent.prompt();
    void promptEvent.userChoice.finally(() => setPromptEvent(null));
  };
  return [promptEvent, install];
}

const NAV: Array<{ to: string; label: string; short: string; icon: React.ReactNode }> = [
  {
    to: "/",
    label: "Overview",
    short: "Home",
    icon: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  },
  {
    to: "/builder",
    label: "Builder",
    short: "Build",
    icon: <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4" />,
  },
  {
    to: "/fixtures",
    label: "Fixtures",
    short: "Fixtures",
    icon: <path d="M4 5h16a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 9h18M8 3v4M16 3v4" />,
  },
  {
    to: "/my-team",
    label: "My team",
    short: "Team",
    icon: <path d="M8 3 3 6l2 5 2-1v11h10V10l2 1 2-5-5-3a3 3 0 0 1-8 0z" />,
  },
  {
    to: "/autopilot",
    label: "Autopilot",
    short: "Auto",
    icon: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  },
  {
    to: "/method",
    label: "Method",
    short: "Method",
    icon: <path d="M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z" />,
  },
];

/** Android-style bottom tab bar, phones only. */
function BottomNav() {
  return (
    <nav
      aria-label="Main"
      className="sm:hidden fixed bottom-0 inset-x-0 z-30 border-t border-line bg-surface/95 backdrop-blur-sm pb-[env(safe-area-inset-bottom)]"
    >
      <div className="grid grid-cols-6">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              [
                "flex flex-col items-center gap-0.5 pt-2 pb-1.5 text-[10.5px] font-medium transition-colors",
                isActive ? "text-accent" : "text-ink-muted",
              ].join(" ")
            }
          >
            {({ isActive }) => (
              <>
                <span className={`px-3 py-1 rounded-full ${isActive ? "bg-accent-soft" : ""}`}>
                  <svg viewBox="0 0 24 24" aria-hidden className="w-[21px] h-[21px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    {item.icon}
                  </svg>
                </span>
                {item.short}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

function Tab({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        [
          "px-2 sm:px-3 py-1.5 rounded text-[13px] sm:text-[13.5px] font-medium transition-colors whitespace-nowrap",
          isActive ? "bg-accent-soft text-accent" : "text-ink-2 hover:text-ink hover:bg-surface-2",
        ].join(" ")
      }
    >
      {children}
    </NavLink>
  );
}

export default function Layout() {
  const [installPrompt, install] = useInstallPrompt();
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="border-b border-line bg-surface/80 backdrop-blur-sm sticky top-0 z-30">
        <div className="max-w-[1180px] mx-auto px-4 sm:px-5 h-14 flex items-center gap-1.5 sm:gap-4">
          <NavLink to="/" className="flex items-center gap-2.5 sm:mr-2 shrink-0">
            <span
              aria-hidden
              className="w-6 h-6 rounded-md bg-accent text-accent-ink grid place-items-center font-display font-bold text-[12px] leading-none"
            >
              FD
            </span>
            <span className="sm:hidden lg:inline font-display font-semibold text-[15.5px] tracking-tight">
              Fantasy Drafter
            </span>
          </NavLink>

          <nav className="hidden sm:flex items-center gap-1" aria-label="Main">
            {NAV.map((item) => (
              <Tab key={item.to} to={item.to}>
                {item.label}
              </Tab>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {installPrompt && (
              <button
                type="button"
                onClick={install}
                className="font-mono text-[11px] tracking-wide uppercase bg-accent text-accent-ink rounded px-2.5 py-1.5 hover:opacity-90"
              >
                Install
              </button>
            )}
            <a
              href={REPO}
              target="_blank"
              rel="noreferrer noopener"
              className="hidden lg:inline font-mono text-[11px] tracking-wide uppercase text-ink-2 border border-line-strong rounded px-2.5 py-1.5 hover:bg-surface-2 hover:text-ink transition-colors"
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

      <footer className="border-t border-line mt-16 mb-[calc(64px+env(safe-area-inset-bottom))] sm:mb-0">
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
      <BottomNav />
    </div>
  );
}
