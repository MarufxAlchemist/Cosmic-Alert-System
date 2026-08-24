import React, { createContext, useContext, useEffect, useState } from "react";

interface ScienceModeContextType {
  scienceMode: boolean;
  toggleScienceMode: () => void;
}

const ScienceModeContext = createContext<ScienceModeContextType>({
  scienceMode: false,
  toggleScienceMode: () => {},
});

const STORAGE_KEY = "astrosentinel_science_mode";

/**
 * Science Mode gates 27 places in the UI — derived quantities, validation
 * diagnostics, provenance, system metadata.
 *
 * It was plain useState(false), so a researcher who turned it on lost it on
 * every reload and had to re-enable it to see the same panels again. Off
 * stays the default for a first visit: the extra detail is meaningful to
 * someone who asked for it and noise to someone who did not.
 *
 * Storage access is guarded because localStorage throws outright in some
 * contexts, and an exception here would take the provider down before the
 * app renders.
 */
function initialScienceMode(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function ScienceModeProvider({ children }: { children: React.ReactNode }) {
  const [scienceMode, setScienceMode] = useState(initialScienceMode);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(scienceMode));
    } catch {
      // Not worth breaking the page over; the setting still holds for this session.
    }
  }, [scienceMode]);

  const toggleScienceMode = () => setScienceMode((prev) => !prev);

  return (
    <ScienceModeContext.Provider value={{ scienceMode, toggleScienceMode }}>
      {children}
    </ScienceModeContext.Provider>
  );
}

export function useScienceMode() {
  return useContext(ScienceModeContext);
}
