import { describe, expect, it } from "vitest";
import { TtlCache } from "./ttl-cache";

describe("TtlCache", () => {
  it("returns values until they expire", () => {
    let t = 0;
    const c = new TtlCache<string | null>(1000, () => t);
    c.set("a", "x");
    c.set("b", null);
    expect(c.get("a")).toBe("x");
    expect(c.get("b")).toBeNull();
    t = 1001;
    expect(c.get("a")).toBeUndefined();
  });
});
