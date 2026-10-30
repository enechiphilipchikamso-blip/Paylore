import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import WorkspaceError from "./workspace/[workspaceId]/error";
import WorkspaceLoading from "./workspace/[workspaceId]/loading";

describe("workspace route loading and error states", () => {
  it("announces workspace route loading and marks the section busy", () => {
    const html = renderToStaticMarkup(<WorkspaceLoading />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading workspace data…");
  });

  it("provides a safe retry state without exposing internal error details", () => {
    const html = renderToStaticMarkup(
      <WorkspaceError error={new Error("database connection refused")} reset={vi.fn()} />
    );
    expect(html).toContain("We couldn&#x27;t load this page");
    expect(html).toContain("Try again");
    expect(html).not.toContain("database connection refused");
  });
});
