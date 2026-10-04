import {
  describe,
  expect,
  it
} from "vitest";
import {
  roleAllows,
  WORKSPACE_ROLE_LABELS
} from "./authorization";

describe("workspace authorization", () => {
  it("keeps the three approved role labels", () => {
    expect(
      WORKSPACE_ROLE_LABELS
        .organization_admin
    ).toBe(
      "Organization Administrator"
    );

    expect(
      WORKSPACE_ROLE_LABELS
        .finance_auditor
    ).toBe("Finance/Auditor");

    expect(
      WORKSPACE_ROLE_LABELS
        .contributor
    ).toBe("Contributor");
  });

  it("checks exact allowed roles", () => {
    expect(
      roleAllows(
        "organization_admin",
        ["organization_admin"]
      )
    ).toBe(true);

    expect(
      roleAllows(
        "contributor",
        ["organization_admin"]
      )
    ).toBe(false);
  });
});