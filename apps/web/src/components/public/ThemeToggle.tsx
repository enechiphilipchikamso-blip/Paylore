"use client";

import { useEffect, useRef } from "react";

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
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    const select = selectRef.current;

    if (!select) {
      return;
    }

    try {
      const storedTheme = localStorage.getItem(STORAGE_KEY);

      if (isTheme(storedTheme)) {
        select.value = storedTheme;
        applyTheme(storedTheme);
      } else {
        select.value = "system";
        applyTheme("system");
      }
    } catch {
      select.value = "system";
      applyTheme("system");
    }

    select.dataset.themeReady = "true";
  }, []);

  function handleChange(nextTheme: Theme) {
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
        ref={selectRef}
        aria-label="Theme"
        defaultValue="system"
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