import {
  describe,
  expect,
  it
} from "vitest";
import {
  buildChallenge,
  challengeIsUsable
} from "./protocol";
import {
  isSafeReturnTo
} from "../security";

describe(
  "authentication protocol",
  () => {
    const issuedAt =
      new Date(
        "2026-10-04T08:00:00.000Z"
      );

    const expirationTime =
      new Date(
        "2026-10-04T08:05:00.000Z"
      );

    const walletAddress =
      "11111111111111111111111111111111";

    it(
      "binds the SIWS challenge to the auth origin",
      () => {
        const result =
          buildChallenge({
            walletAddress,
            nonce:
              "a".repeat(64),
            issuedAt,
            expirationTime,
            requestUrl:
              "https://paylore.example/api/auth/challenge"
          });

        expect(
          result.input.domain
        ).toBe(
          "paylore.example"
        );

        expect(
          result.input.uri
        ).toBe(
          "https://paylore.example/auth"
        );

        expect(
          result.input.address
        ).toBe(
          walletAddress
        );

        expect(
          result.input.chainId
        ).toBe(
          "solana:devnet"
        );

        expect(
          result.message
        ).toContain(
          "Paylore"
        );
      }
    );

    it(
      "rejects a consumed challenge",
      () => {
        expect(
          challengeIsUsable(
            {
              issuedAt,
              expirationTime,
              consumedAt:
                new Date(
                  "2026-10-04T08:01:00.000Z"
                )
            },
            new Date(
              "2026-10-04T08:02:00.000Z"
            )
          )
        ).toBe(false);
      }
    );

    it(
      "rejects an expired challenge",
      () => {
        expect(
          challengeIsUsable(
            {
              issuedAt,
              expirationTime,
              consumedAt: null
            },
            new Date(
              "2026-10-04T08:06:00.000Z"
            )
          )
        ).toBe(false);
      }
    );

    it(
      "accepts an unconsumed challenge inside the time window",
      () => {
        expect(
          challengeIsUsable(
            {
              issuedAt,
              expirationTime,
              consumedAt: null
            },
            new Date(
              "2026-10-04T08:03:00.000Z"
            )
          )
        ).toBe(true);
      }
    );

    it(
      "rejects external return paths",
      () => {
        expect(
          isSafeReturnTo(
            "https://evil.example"
          )
        ).toBe("/app");

        expect(
          isSafeReturnTo(
            "//evil.example"
          )
        ).toBe("/app");
      }
    );

    it(
      "allows a safe internal return path",
      () => {
        expect(
          isSafeReturnTo(
            "/invite/example"
          )
        ).toBe(
          "/invite/example"
        );
      }
    );
  }
);