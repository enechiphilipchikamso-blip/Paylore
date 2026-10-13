import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  assertSameOrigin,
  getRequestOrigin,
  RequestSecurityError
} from "./security";

beforeEach(() => {
  vi.stubEnv(
    "NODE_ENV",
    "test"
  );
  vi.stubEnv(
    "CODESPACE_NAME",
    ""
  );
  vi.stubEnv(
    "PORT",
    ""
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe(
  "same-origin request validation",
  () => {
    const requestUrl =
      "https://paylore.example/api/auth/challenge";

    it(
      "accepts a matching Origin header",
      () => {
        expect(() =>
          assertSameOrigin(
            new Request(requestUrl, {
              method: "POST",
              headers: {
                origin:
                  "https://paylore.example"
              }
            })
          )
        ).not.toThrow();
      }
    );

    it(
      "accepts the dynamic public origin forwarded by a development proxy",
      () => {
        const forwardedOrigin =
          "https://workspace-3000.app.github.dev";

        expect(() =>
          assertSameOrigin(
            new Request(
              "http://localhost:3000/api/auth/challenge",
              {
                method: "POST",
                headers: {
                  origin:
                    forwardedOrigin,
                  "x-forwarded-host":
                    "workspace-3000.app.github.dev",
                  "x-forwarded-proto":
                    "https"
                }
              }
            )
          )
        ).not.toThrow();
      }
    );

    it(
      "uses the Codespaces public hostname and request port when the proxy URL is internal",
      () => {
        vi.stubEnv(
          "NODE_ENV",
          "development"
        );
        vi.stubEnv(
          "CODESPACE_NAME",
          "workspace-name"
        );

        const request =
          new Request(
            "http://localhost:3000/api/auth/challenge",
            {
              method: "POST",
              headers: {
                origin:
                  "https://workspace-name-4012.app.github.dev"
              }
            }
          );

        expect(
          getRequestOrigin(request)
        ).toBe(
          "https://workspace-name-4012.app.github.dev"
        );
        expect(() =>
          assertSameOrigin(request)
        ).not.toThrow();
      }
    );

    it(
      "does not let internal forwarded headers override the validated Codespaces origin",
      () => {
        vi.stubEnv(
          "NODE_ENV",
          "development"
        );
        vi.stubEnv(
          "CODESPACE_NAME",
          "workspace-name"
        );

        const request =
          new Request(
            "http://localhost:3000/api/auth/challenge",
            {
              method: "POST",
              headers: {
                origin:
                  "https://workspace-name-4012.app.github.dev",
                "x-forwarded-host":
                  "localhost:3000",
                "x-forwarded-proto":
                  "http"
              }
            }
          );

        expect(
          getRequestOrigin(request)
        ).toBe(
          "https://workspace-name-4012.app.github.dev"
        );
        expect(() =>
          assertSameOrigin(request)
        ).not.toThrow();
      }
    );

    it(
      "accepts the exact current Codespaces origin when proxy headers describe only the internal server",
      () => {
        vi.stubEnv(
          "NODE_ENV",
          "development"
        );
        vi.stubEnv(
          "CODESPACE_NAME",
          "jubilant-rotary-phone-g49r4xv7q6553pw5x"
        );

        expect(() =>
          assertSameOrigin(
            new Request(
              "http://localhost:3000/api/auth/challenge",
              {
                method: "POST",
                headers: {
                  origin:
                    "https://jubilant-rotary-phone-g49r4xv7q6553pw5x-3000.app.github.dev",
                  "x-forwarded-host":
                    "localhost:3000",
                  "x-forwarded-proto":
                    "http"
                }
              }
            )
          )
        ).not.toThrow();
      }
    );

    it(
      "accepts the loopback Origin rewritten by the Codespaces tunnel in development",
      () => {
        vi.stubEnv(
          "NODE_ENV",
          "development"
        );
        vi.stubEnv(
          "CODESPACE_NAME",
          "jubilant-rotary-phone-g49r4xv7q6553pw5x"
        );

        expect(() =>
          assertSameOrigin(
            new Request(
              "http://localhost:3000/api/auth/challenge",
              {
                method: "POST",
                headers: {
                  origin:
                    "http://localhost:3000",
                  "content-type":
                    "application/json"
                }
              }
            )
          )
        ).not.toThrow();
      }
    );

    it(
      "accepts the internal loopback Origin for a forwarded public host in development",
      () => {
        vi.stubEnv(
          "NODE_ENV",
          "development"
        );

        const request =
          new Request(
            "http://localhost:3000/api/auth/challenge",
            {
              method: "POST",
              headers: {
                origin:
                  "http://localhost:3000",
                "x-forwarded-host":
                  "github.dev",
                "x-forwarded-proto":
                  "https"
              }
            }
          );

        expect(
          getRequestOrigin(request)
        ).toBe("https://github.dev");
        expect(() =>
          assertSameOrigin(request)
        ).not.toThrow();
      }
    );

    it(
      "accepts a forwarded development request when its public URL and browser Origin differ",
      () => {
        vi.stubEnv(
          "NODE_ENV",
          "development"
        );

        const request =
          new Request(
            "https://github.dev/api/auth/challenge",
            {
              method: "POST",
              headers: {
                origin:
                  "http://localhost:3000",
                "x-forwarded-host":
                  "github.dev",
                "x-forwarded-proto":
                  "https"
              }
            }
          );

        expect(
          getRequestOrigin(request)
        ).toBe("https://github.dev");
        expect(() =>
          assertSameOrigin(request)
        ).not.toThrow();
      }
    );

    it(
      "rejects an unrelated loopback port for a forwarded development request",
      () => {
        vi.stubEnv(
          "NODE_ENV",
          "development"
        );

        expect(() =>
          assertSameOrigin(
            new Request(
              "https://github.dev/api/auth/challenge",
              {
                method: "POST",
                headers: {
                  origin:
                    "http://localhost:4012",
                  "x-forwarded-host":
                    "github.dev",
                  "x-forwarded-proto":
                    "https"
                }
              }
            )
          )
        ).toThrow(RequestSecurityError);
      }
    );

    it(
      "rejects the internal loopback Origin for a forwarded public host in production",
      () => {
        vi.stubEnv(
          "NODE_ENV",
          "production"
        );

        expect(() =>
          assertSameOrigin(
            new Request(
              "http://localhost:3000/api/auth/challenge",
              {
                method: "POST",
                headers: {
                  origin:
                    "http://localhost:3000",
                  "x-forwarded-host":
                    "github.dev",
                  "x-forwarded-proto":
                    "https"
                }
              }
            )
          )
        ).toThrow(RequestSecurityError);
      }
    );

    it(
      "does not accept a different loopback port from the request URL",
      () => {
        vi.stubEnv(
          "NODE_ENV",
          "development"
        );
        vi.stubEnv(
          "CODESPACE_NAME",
          "jubilant-rotary-phone-g49r4xv7q6553pw5x"
        );

        expect(() =>
          assertSameOrigin(
            new Request(
              "http://localhost:3000/api/auth/challenge",
              {
                method: "POST",
                headers: {
                  origin:
                    "http://localhost:4012",
                  "content-type":
                    "application/json"
                }
              }
            )
          )
        ).toThrow(RequestSecurityError);
      }
    );

    it(
      "accepts a matching Referer when Origin is omitted",
      () => {
        expect(() =>
          assertSameOrigin(
            new Request(requestUrl, {
              method: "POST",
              headers: {
                referer:
                  "https://paylore.example/auth"
              }
            })
          )
        ).not.toThrow();
      }
    );

    it(
      "accepts browser same-origin fetch metadata when Origin and Referer are omitted",
      () => {
        expect(() =>
          assertSameOrigin(
            new Request(requestUrl, {
              method: "POST",
              headers: {
                "sec-fetch-site":
                  "same-origin"
              }
            })
          )
        ).not.toThrow();
      }
    );

    it(
      "rejects cross-origin requests even if fetch metadata claims same-origin",
      () => {
        expect(() =>
          assertSameOrigin(
            new Request(requestUrl, {
              method: "POST",
              headers: {
                origin:
                  "https://evil.example",
                "sec-fetch-site":
                  "same-origin"
              }
            })
          )
        ).toThrow(RequestSecurityError);
      }
    );

    it(
      "rejects an attacker Origin when Codespaces forwarded headers identify the app",
      () => {
        expect(() =>
          assertSameOrigin(
            new Request(
              "http://localhost:3000/api/auth/challenge",
              {
                method: "POST",
                headers: {
                  origin:
                    "https://evil.example",
                  "x-forwarded-host":
                    "workspace-3000.app.github.dev",
                  "x-forwarded-proto":
                    "https"
                }
              }
            )
          )
        ).toThrow(RequestSecurityError);
      }
    );

    it(
      "rejects when no same-origin metadata is available",
      () => {
        expect(() =>
          assertSameOrigin(
            new Request(requestUrl, {
              method: "POST"
            })
          )
        ).toThrow(RequestSecurityError);
      }
    );

    it(
      "allows JSON requests from the configured Codespace when mobile browsers omit origin metadata",
      () => {
        vi.stubEnv(
          "NODE_ENV",
          "development"
        );
        vi.stubEnv(
          "CODESPACE_NAME",
          "workspace-name"
        );
        vi.stubEnv("PORT", "4012");

        const request =
          new Request(
            "http://localhost:3000/api/auth/challenge",
            {
              method: "POST",
              headers: {
                "content-type":
                  "application/json"
              }
            }
          );

        expect(
          getRequestOrigin(request)
        ).toBe(
          "https://workspace-name-4012.app.github.dev"
        );
        expect(() =>
          assertSameOrigin(request)
        ).not.toThrow();
      }
    );

    it(
      "rejects cross-site fetches even when development metadata fallback is enabled",
      () => {
        vi.stubEnv(
          "NODE_ENV",
          "development"
        );
        vi.stubEnv(
          "CODESPACE_NAME",
          "workspace-name"
        );
        vi.stubEnv("PORT", "4012");

        expect(() =>
          assertSameOrigin(
            new Request(
              "http://localhost:3000/api/auth/challenge",
              {
                method: "POST",
                headers: {
                  "content-type":
                    "application/json",
                  "sec-fetch-site":
                    "cross-site"
                }
              }
            )
          )
        ).toThrow(RequestSecurityError);
      }
    );
  }
);
