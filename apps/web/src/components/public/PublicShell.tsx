import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeToggle } from "./ThemeToggle";

const navigationLinks = [
  { href: "/", label: "Home" },
  { href: "/product", label: "Product" },
  { href: "/pricing", label: "Pricing" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/security", label: "Security" },
  { href: "/docs", label: "Docs" },
  { href: "/auth", label: "Sign In" }
];

export function PublicShell({
  children
}: {
  children: ReactNode;
}) {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <header className="site-header">
        <div className="site-container site-header__inner">
          <Link className="brand-lockup" href="/" aria-label="Paylore home">
            <span className="brand-lockup__mark">
              <Image
                src="/brand/paylore.svg"
                alt=""
                width={40}
                height={40}
                loading="eager"
                unoptimized
              />
            </span>
          </Link>

          <div className="site-header__actions">
            <ThemeToggle />
            <details className="site-menu">
              <summary>
                <span className="site-menu__icon" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                Menu
              </summary>
              <nav aria-label="Site navigation">
                <ul>
                  {navigationLinks.map((link) => (
                    <li key={link.href}>
                      <Link href={link.href}>{link.label}</Link>
                    </li>
                  ))}
                </ul>
              </nav>
            </details>
          </div>
        </div>
      </header>

      <main id="main-content" className="site-main" tabIndex={-1}>
        {children}
      </main>

      <footer className="site-footer">
        <nav
          className="site-container site-footer__inner"
          aria-label="Legal information"
        >
          <ul className="site-footer__links">
            <li>
              <Link href="/terms">Terms</Link>
            </li>
            <li>
              <Link href="/privacy">Privacy</Link>
            </li>
            <li>
              <Link href="/security">Security</Link>
            </li>
          </ul>
        </nav>
      </footer>
    </>
  );
}
