import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const getUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser }, rpc }),
}));
let invitationAccount: string | null = "acc-a";
let invitationError: { message: string } | null = null;
vi.mock("@/lib/platform/admin-client", () => ({
  platformAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: invitationAccount ? { account_id: invitationAccount } : null,
            error: invitationError,
          }),
        }),
      }),
    }),
  }),
}));
const forgetProfileAccount = vi.fn();
vi.mock("@/lib/platform/tenant-lookup", () => ({ forgetProfileAccount }));
const { POST } = await import("./route");
const { __resetRateLimitForTests } = await import("@/lib/rate-limit");

function call(headers: Record<string, string> = {}) {
  return POST(new Request("https://b.crm.stellmedia.com/api/invitations/tok/redeem", { method: "POST", headers }), {
    params: Promise.resolve({ token: "tok" }),
  });
}

beforeEach(() => {
  __resetRateLimitForTests();
  vi.clearAllMocks();
  invitationAccount = "acc-a";
  invitationError = null;
  getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
  rpc.mockResolvedValue({ data: "acc-a", error: null });
});

describe("redeem on a tenant host", () => {
  it("rejects an invite that belongs to a different tenant", async () => {
    const res = await call({ "x-tenant-id": "acc-b" });
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("redeems when the invite matches the tenant and clears the cached account", async () => {
    const res = await call({ "x-tenant-id": "acc-a" });
    expect(res.status).toBe(200);
    expect(forgetProfileAccount).toHaveBeenCalledWith("u1");
  });
  it("is unchanged outside platform mode (no tenant header)", async () => {
    const res = await call();
    expect(res.status).toBe(200);
  });
  it("fails closed with 503 when the invitation lookup errors", async () => {
    invitationError = { message: "boom" };
    const res = await call({ "x-tenant-id": "acc-a" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Could not verify invitation" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
