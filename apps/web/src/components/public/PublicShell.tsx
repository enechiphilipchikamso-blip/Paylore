import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeToggle } from "./ThemeToggle";

const primaryLinks = [
  { href: "/", label: "Home" },
  { href: "/product", label: "Product" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" }
];

const footerLinks = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/security", label: "Security" }
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
          <Link
            className="brand-lockup"
            href="/"
            aria-label="Paylore home"
          >
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

            <span className="brand-lockup__name">
              Paylore
            </span>
          </Link>

          <nav
            className="desktop-nav"
            aria-label="Primary navigation"
          >
            <ul>
              {primaryLinks.map(
                (link) => (
                  <li key={link.href}>
                    <Link href={link.href}>
                      {link.label}
                    </Link>
                  </li>
                )
              )}
            </ul>
          </nav>

          <div className="site-header__actions">
            <ThemeToggle />

            <Link
              className="auth-link"
              href="/auth"
            >
              Sign in
            </Link>
          </div>

          <details className="mobile-nav">
            <summary>Menu</summary>

            <nav aria-label="Mobile navigation">
              <ul>
                {primaryLinks.map(
                  (link) => (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                      >
                        {link.label}
                      </Link>
                    </li>
                  )
                )}
              </ul>
            </nav>
          </details>
        </div>
      </header>

      <main
        id="main-content"
        className="site-main"
        tabIndex={-1}
      >
        {children}
      </main>

      <footer className="site-footer">
        <div className="site-container site-footer__inner">
          <div>
            <Link
              className="brand-lockup brand-lockup--footer"
              href="/"
              aria-label="Paylore home"
            >
              <span className="brand-lockup__mark">
                <Image
                  src="/brand/paylore.svg"
                  alt=""
                  width={32}
                  height={32}
                  unoptimized
                />
              </span>

              <span className="brand-lockup__name">
                Paylore
              </span>
            </Link>

            <p className="site-footer__description">
              Private on-chain payroll for
              crypto-native organizations.
            </p>
          </div>

          <nav aria-label="Footer navigation">
            <ul className="site-footer__links">
              {footerLinks.map(
                (link) => (
                  <li key={link.href}>
                    <Link href={link.href}>
                      {link.label}
                    </Link>
                  </li>
                )
              )}
            </ul>
          </nav>
        </div>
      </footer>
    </>
  );
}