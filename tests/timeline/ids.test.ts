// Canonical model: stable identity (src/lib/timeline/ids.ts).
import { describe, expect, it } from "vitest";
import { ID_PREFIX, randomIds, seededIds, stableId, type IdKind } from "@/lib/timeline/ids";

const KINDS = Object.keys(ID_PREFIX) as IdKind[];

describe("ids", () => {
  it("random ids are prefixed by kind, 128-bit, and unique", () => {
    const seen = new Set<string>();
    for (const kind of KINDS) {
      for (let i = 0; i < 2000; i += 1) {
        const id = randomIds.next(kind);
        expect(id).toMatch(new RegExp(`^${ID_PREFIX[kind]}_[0-9a-f]{32}$`));
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
  });

  it("seeded generators are deterministic, independent of time and of each other", () => {
    const a = seededIds("seed-1");
    const b = seededIds("seed-1");
    const c = seededIds("seed-2");
    const runA = [a.next("item"), a.next("item"), a.next("transaction")];
    const runB = [b.next("item"), b.next("item"), b.next("transaction")];
    const runC = [c.next("item"), c.next("item"), c.next("transaction")];
    expect(runA).toEqual(runB);
    expect(new Set([...runA, ...runC]).size).toBe(6);
    expect(runA[0]).toMatch(/^itm_[0-9a-f]{32}$/);
    expect(runA[2]).toMatch(/^txn_[0-9a-f]{32}$/);
  });

  it("stableId is a pure function of its kind and parts", () => {
    expect(stableId("item", "tl-1", "event-1", "0")).toBe(stableId("item", "tl-1", "event-1", "0"));
    expect(stableId("item", "tl-1", "event-1", "0")).not.toBe(
      stableId("item", "tl-1", "event-1", "1"),
    );
    expect(stableId("item", "x")).not.toBe(stableId("track", "x"));
    // Length-prefixed parts: no ambiguity from where a boundary falls.
    expect(stableId("item", "ab", "c")).not.toBe(stableId("item", "a", "bc"));
  });

  it("stableId does not collide across a realistic import (10k items)", () => {
    const ids = new Set<string>();
    for (let t = 0; t < 100; t += 1) {
      for (let d = 0; d < 100; d += 1) ids.add(stableId("item", `tl-${t}`, `event-${d}`, "0"));
    }
    expect(ids.size).toBe(10_000);
  });
});
