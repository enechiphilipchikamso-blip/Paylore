import {
  describe,
  expect,
  it
} from "vitest";
import {
  decideWorkspaceCreation,
  WORKSPACE_CREATION_MAX_ATTEMPTS
} from "./workspaces-policy";

describe(
  "workspace creation anti-abuse",
  () => {
    it(
      "allows attempts inside the threshold",
      () => {
        expect(
          decideWorkspaceCreation(
            WORKSPACE_CREATION_MAX_ATTEMPTS,
            1000
          )
        ).toEqual({
          allowed: true,
          retryAfterSeconds:
            0
        });
      }
    );

    it(
      "blocks the first attempt beyond the threshold",
      () => {
        const result =
          decideWorkspaceCreation(
            WORKSPACE_CREATION_MAX_ATTEMPTS +
              1,
            1000
          );

        expect(
          result.allowed
        ).toBe(false);

        expect(
          result.retryAfterSeconds
        ).toBeGreaterThan(0);
      }
    );

    it(
      "reports a concrete retry window",
      () => {
        const result =
          decideWorkspaceCreation(
            WORKSPACE_CREATION_MAX_ATTEMPTS +
              1,
            14 * 60 * 1000
          );

        expect(result).toEqual({
          allowed: false,
          retryAfterSeconds:
            60
        });
      }
    );
  }
);