import {
  describe,
  expect,
  it
} from "vitest";
import {
  evaluateSession,
  SESSION_HARD_LIFETIME_MS,
  SESSION_INACTIVITY_MS
} from "./session";

describe("session boundaries", () => {
  const issuedAt =
    new Date(
      "2026-10-04T08:00:00.000Z"
    );

  it("accepts an active session", () => {
    const lastSeenAt =
      new Date(
        issuedAt.getTime() +
          30 * 60 * 1000
      );

    const expiresAt =
      new Date(
        issuedAt.getTime() +
          SESSION_HARD_LIFETIME_MS
      );

    expect(
      evaluateSession(
        {
          issuedAt,
          lastSeenAt,
          expiresAt
        },
        new Date(
          issuedAt.getTime() +
            60 * 60 * 1000
        )
      )
    ).toEqual({
      status: "authenticated"
    });
  });

  it("expires after the inactivity window", () => {
    const lastSeenAt =
      new Date(
        issuedAt.getTime() -
          SESSION_INACTIVITY_MS
      );

    const expiresAt =
      new Date(
        issuedAt.getTime() +
          SESSION_HARD_LIFETIME_MS
      );

    expect(
      evaluateSession(
        {
          issuedAt,
          lastSeenAt,
          expiresAt
        },
        issuedAt
      )
    ).toEqual({
      status: "inactivity_expired"
    });
  });

  it("expires at the hard lifetime regardless of activity", () => {
    const lastSeenAt =
      new Date(
        issuedAt.getTime() +
          SESSION_HARD_LIFETIME_MS -
          1000
      );

    const expiresAt =
      new Date(
        issuedAt.getTime() +
          SESSION_HARD_LIFETIME_MS
      );

    expect(
      evaluateSession(
        {
          issuedAt,
          lastSeenAt,
          expiresAt
        },
        expiresAt
      )
    ).toEqual({
      status: "hard_expired"
    });
  });

  it("does not turn activity into a new seven-day lifetime", () => {
    const expiresAt =
      new Date(
        issuedAt.getTime() +
          SESSION_HARD_LIFETIME_MS
      );

    const later =
      new Date(
        issuedAt.getTime() +
          SESSION_HARD_LIFETIME_MS -
          1000
      );

    expect(
      evaluateSession(
        {
          issuedAt,
          lastSeenAt: later,
          expiresAt
        },
        later
      )
    ).toEqual({
      status: "authenticated"
    });

    expect(
      evaluateSession(
        {
          issuedAt,
          lastSeenAt: later,
          expiresAt
        },
        expiresAt
      )
    ).toEqual({
      status: "hard_expired"
    });
  });
});