import React, { createContext, useContext, useEffect, useState } from "react";

interface ThemeContextType {
  isDark: boolean;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType>({
  isDark: true,
  toggleTheme: () => {},
});

const STORAGE_KEY = "astrosentinel_theme";

/**
 * The theme to start with.
 *
 * Order: an explicit past choice, then the operating system's preference,
 * then light. Before this the theme was plain useState(false), so every
 * reload threw the choice away and snapped back to light — on a dashboard
 * people leave open on a wall display overnight.
 *
 * Every storage access is guarded. localStorage throws outright in some
 * contexts (private windows with site data blocked, embedded previews), and
 * an exception here would take the whole provider — and therefore the app —
 * down before first paint.
 */
function initialIsDark(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark") return true;
    if (stored === "light") return false;
  } catch {
    // Storage unavailable — fall through to the system preference.
  }

  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(initialIsDark);

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }

    // Persisted on change rather than in the toggle, so a theme set by any
    // other means is saved too.
    try {
      localStorage.setItem(STORAGE_KEY, isDark ? "dark" : "light");
    } catch {
      // A preference that cannot be saved is not worth breaking the page for;
      // the theme still applies for this session.
    }
  }, [isDark]);

  const toggleTheme = () => setIsDark((prev) => !prev);

  return (
    <ThemeContext.Provider value={{ isDark, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
