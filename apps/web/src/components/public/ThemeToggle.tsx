"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "paylore-theme";

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;

  if (theme === "system") {
    root.removeAttribute("data-theme");
    return;
  }

  root.setAttribute("data-theme", theme);
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    try {
      const storedTheme = localStorage.getItem(STORAGE_KEY);

      if (isTheme(storedTheme)) {
        setTheme(storedTheme);
        applyTheme(storedTheme);
      } else {
        applyTheme("system");
      }
    } catch {
      applyTheme("system");
    }
  }, []);

  function handleChange(nextTheme: Theme) {
    setTheme(nextTheme);
    applyTheme(nextTheme);

    try {
      localStorage.setItem(STORAGE_KEY, nextTheme);
    } catch {
      // Theme still applies for the current page even when storage is unavailable.
    }
  }

  return (
    <label className="theme-control">
      <span className="theme-control__label">Theme</span>
      <select
        aria-label="Theme"
        value={theme}
        onChange={(event) =>
          handleChange(event.target.value as Theme)
        }
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}