import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  active: { "acct-active": true, "acct-suspended": false } as Record<string, boolean>,
  due: [] as Record<string, unknown>[],
  claims: [] as string[],
  resumed: [] as string[],
  suspendedIds: [] as string[],
  notCalls: [] as unknown[][],
}));

vi.mock("@/lib/platform/tenant-status", () => ({
  isTenantActive: async (id: string) => h.active[id] ?? true,
  listSuspendedAccountIds: async () => h.suspendedIds,
}));

vi.mock("@/lib/automations/engine", () => ({
  expireAwaitingReplies: async () => 0,
  resumePendingExecution: async (p: { id: string }) => {
    h.resumed.push(p.id);
  },
}));

vi.mock("@/lib/automations/admin-client", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      let isUpdate = false;
      let id = "";
      const chain = () => q;
      q.select = (cols?: string) => {
        if (!isUpdate) return q;
        void cols;
        return q;
      };
      q.update = () => {
        isUpdate = true;
        return q;
      };
      q.eq = (k: string, v: string) => {
        if (k === "id") id = v;
        return q;
      };
      q.not = (...args: unknown[]) => {
        h.notCalls.push(args);
        return q;
      };
      q.lte = chain;
      q.order = chain;
      q.limit = () => Promise.resolve({ data: h.due, error: null });
      q.maybeSingle = async () => {
        h.claims.push(id);
        return { data: { id }, error: null };
      };
      return q;
    },
  }),
}));

import { GET } from "./route";

const row = (id: string, account_id: string) => ({
  id,
  account_id,
  automation_id: "a",
  user_id: "u",
  next_step_position: 1,
});

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = "s3cret";
  h.due = [];
  h.claims = [];
  h.resumed = [];
  h.suspendedIds = [];
  h.notCalls = [];
});

describe("automations cron — soft suspend", () => {
  it("skips (does not claim, resume or fail) pending rows of suspended accounts", async () => {
    h.due = [row("p1", "acct-suspended"), row("p2", "acct-active")];
    const res = await GET(new Request("https://x/api/automations/cron", { headers: { "x-cron-secret": "s3cret" } }));
    expect((await res.json()).processed).toBe(1);
    expect(h.claims).toEqual(["p2"]);
    expect(h.resumed).toEqual(["p2"]);
  });

  it("excludes suspended accounts in the query when any exist", async () => {
    h.suspendedIds = ["acc-s"];
    await GET(new Request("https://x/api/automations/cron", { headers: { "x-cron-secret": "s3cret" } }));
    expect(h.notCalls).toEqual([["account_id", "in", "(acc-s)"]]);
  });

  it("adds no exclusion filter when nothing is suspended", async () => {
    await GET(new Request("https://x/api/automations/cron", { headers: { "x-cron-secret": "s3cret" } }));
    expect(h.notCalls).toHaveLength(0);
  });
});
