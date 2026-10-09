import type { ReactNode } from "react";

type PublicPageProps = {
  eyebrow: string;
  title: string;
  description?: string;
  children: ReactNode;
};

export function PublicPage({
  eyebrow,
  title,
  description,
  children
}: PublicPageProps) {
  return (
    <div className="site-container page-wrap">
      <header className="page-heading">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {description ? (
          <p className="page-heading__description">
            {description}
          </p>
        ) : null}
      </header>

      <div className="content-stack">{children}</div>
    </div>
  );
}