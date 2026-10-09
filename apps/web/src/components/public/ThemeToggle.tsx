"use client";

import { useSyncExternalStore } from "react";

type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "paylore-theme";
const THEME_CHANGE_EVENT = "paylore-theme-change";
const themes: readonly Theme[] = ["system", "light", "dark"];
let transientTheme: Theme | null = null;

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function getThemeSnapshot(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isTheme(stored)) {
      return stored;
    }
  } catch {
    return transientTheme ?? "system";
  }

  return transientTheme ?? "system";
}

function getServerThemeSnapshot(): Theme {
  return "system";
}

function applyTheme(theme: Theme) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

function subscribeToThemeChange(onChange: () => void) {
  const updateTheme = () => {
    const theme = getThemeSnapshot();
    applyTheme(theme);
    onChange();
  };

  window.addEventListener(THEME_CHANGE_EVENT, updateTheme);
  window.addEventListener("storage", updateTheme);

  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, updateTheme);
    window.removeEventListener("storage", updateTheme);
  };
}

function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
    transientTheme = null;
  } catch {
    transientTheme = theme;
  }

  applyTheme(theme);
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

function nextTheme(theme: Theme): Theme {
  return themes[(themes.indexOf(theme) + 1) % themes.length] ?? "system";
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(
    subscribeToThemeChange,
    getThemeSnapshot,
    getServerThemeSnapshot
  );
  const next = nextTheme(theme);

  function toggleTheme() {
    saveTheme(next);
  }

  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label={`Theme: ${theme}. Activate to switch to ${next}.`}
      title={`Theme: ${theme}`}
      onClick={toggleTheme}
    >
      {theme === "light" ? (
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          data-theme-icon="light"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
        </svg>
      ) : theme === "dark" ? (
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          data-theme-icon="dark"
        >
          <path d="M20.2 15.4A8.5 8.5 0 0 1 8.6 3.8 8.5 8.5 0 1 0 20.2 15.4Z" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          data-theme-icon="system"
        >
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M8 21h8m-4-4v4" />
        </svg>
      )}
    </button>
  );
}
