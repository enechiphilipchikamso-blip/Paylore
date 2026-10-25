import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { getWorkspaceForUser, listWorkspaceDeadLetterSolanaWebhookEvents, retryDeadLetterSolanaWebhookEvent } from "@paylore/database";

vi.mock("server-only", () => ({}));
vi.mock("../../../../../server/db", () => ({ getDatabase: () => ({}) }));
vi.mock("../../../../../server/session", () => ({
  clearSessionCookie: vi.fn(),
  getSessionState: vi.fn(async () => ({ status: "authenticated", session: { userId: "user-1" } }))
}));
vi.mock("@paylore/database", () => ({
  getWorkspaceForUser: vi.fn(),
  listWorkspaceDeadLetterSolanaWebhookEvents: vi.fn(),
  retryDeadLetterSolanaWebhookEvent: vi.fn()
}));

const context = { params: Promise.resolve({ workspaceId: "workspace-1" }) };
afterEach(() => vi.clearAllMocks());

describe("workspace dead-letter event controls", () => {
  it("restricts inspection to organization administrators", async () => {
    vi.mocked(getWorkspaceForUser).mockResolvedValue({ role: "finance_auditor" } as never);
    const response = await GET(new Request("https://paylore.example"), context);
    expect(response.status).toBe(403);
    expect(listWorkspaceDeadLetterSolanaWebhookEvents).not.toHaveBeenCalled();
  });

  it("lists dead letters only after organization-admin authorization", async () => {
    vi.mocked(getWorkspaceForUser).mockResolvedValue({ role: "organization_admin" } as never);
    vi.mocked(listWorkspaceDeadLetterSolanaWebhookEvents).mockResolvedValue([] as never);
    const response = await GET(new Request("https://paylore.example"), context);
    expect(response.status).toBe(200);
    expect(listWorkspaceDeadLetterSolanaWebhookEvents).toHaveBeenCalledWith({}, { workspaceId: "workspace-1", limit: 100 });
  });

  it("only schedules retry for an event mapped to the authorized workspace", async () => {
    vi.mocked(getWorkspaceForUser).mockResolvedValue({ role: "organization_admin" } as never);
    vi.mocked(retryDeadLetterSolanaWebhookEvent).mockResolvedValue(true as never);
    const response = await POST(new Request("https://paylore.example/api", {
      method: "POST", headers: { origin: "https://paylore.example", "content-type": "application/json" },
      body: JSON.stringify({ eventId: "d7e9ef90-68b3-4a94-9a42-8ad987654321" })
    }), context);
    expect(response.status).toBe(200);
    expect(retryDeadLetterSolanaWebhookEvent).toHaveBeenCalledWith({}, {
      workspaceId: "workspace-1", eventId: "d7e9ef90-68b3-4a94-9a42-8ad987654321"
    });
  });
});
