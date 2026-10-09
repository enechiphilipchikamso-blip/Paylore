"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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

export function SiteMenu() {
  const pathname = usePathname();

  return (
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
              <Link
                href={link.href}
                aria-current={pathname === link.href ? "page" : undefined}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </details>
  );
}
