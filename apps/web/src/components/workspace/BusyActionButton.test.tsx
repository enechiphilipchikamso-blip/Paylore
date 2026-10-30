import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BusyActionButton } from "./BusyActionButton";

describe("BusyActionButton", () => {
  it("disables pending actions and exposes the state used by the inline spinner", () => {
    const html = renderToStaticMarkup(
      <BusyActionButton busy onClick={() => undefined} type="button">
        Saving changes…
      </BusyActionButton>
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("Saving changes…");
  });

  it("preserves a caller's disabled state when it is not busy", () => {
    const html = renderToStaticMarkup(
      <BusyActionButton busy={false} disabled onClick={() => undefined} type="button">
        Save changes
      </BusyActionButton>
    );

    expect(html).toContain('disabled=""');
    expect(html).not.toContain("aria-busy");
  });
});
