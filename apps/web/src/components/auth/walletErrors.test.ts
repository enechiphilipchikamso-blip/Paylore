import {
  describe,
  expect,
  it
} from "vitest";
import {
  isWalletCancellation
} from "./walletErrors";

describe(
  "wallet cancellation detection",
  () => {
    it(
      "recognizes explicit user rejections",
      () => {
        expect(
          isWalletCancellation(
            new Error(
              "User rejected the request."
            )
          )
        ).toBe(true);
      }
    );

    it(
      "recognizes standard wallet rejection codes",
      () => {
        const cause =
          Object.assign(
            new Error("Request failed"),
            { code: 4001 }
          );

        expect(
          isWalletCancellation(cause)
        ).toBe(true);
      }
    );

    it(
      "does not call unrelated wallet errors cancellations",
      () => {
        expect(
          isWalletCancellation(
            new Error(
              "Signature rejected because the request was malformed."
            )
          )
        ).toBe(false);

        expect(
          isWalletCancellation(
            new Error(
              "Wallet denied access to the signing capability."
            )
          )
        ).toBe(false);
      }
    );
  }
);
