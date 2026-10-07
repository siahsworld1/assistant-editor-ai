// Transactions and history (src/lib/timeline/{transactions,history}.ts):
// atomicity, undo/redo exactness, redo invalidation, the 200-entry cap,
// origins, and deterministic replay of a command log.
import { describe, expect, it } from "vitest";
import {
  canRedo,
  canUndo,
  commit,
  createHistory,
  HISTORY_CAP,
  nextRedo,
  nextUndo,
  redo,
  undo,
  type History,
} from "@/lib/timeline/history";
import { seededIds } from "@/lib/timeline/ids";
import { findViolations } from "@/lib/timeline/invariants";
import { applyTransaction, makeTransaction, replay } from "@/lib/timeline/transactions";
import type { Transaction, TransactionOrigin } from "@/lib/timeline/types";
import { assemblyFromLegacy } from "@/lib/timeline/commands/replace-assembly";
import { commands, directorSequence, item, media } from "./engine-helpers";
import { projectClips, refinedCut } from "./legacy-fixtures";

function committed(h: History, txn: Transaction): History {
  const out = commit(h, txn, { media });
  if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
  return out.history;
}

describe("transactions", () => {
  it("apply atomically: a failing command rolls back every command before it", () => {
    const seq = directorSequence();
    const ids = seededIds("atomic");
    const txn = makeTransaction(ids, "ai op", "director", [
      commands.trim(ids, item(seq, "event-6").id, "out", -24),
      commands.move(ids, [item(seq, "event-4").id], -6),
      commands.move(ids, [item(seq, "event-1").id], 10), // overlaps event 2 → rejected
    ]);
    const outcome = applyTransaction(seq, txn, { media });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.commandId).toBe(txn.commands[2]!.id);
    expect(seq).toStrictEqual(directorSequence()); // input untouched (and frozen)
    const h = createHistory(seq);
    const c = commit(h, txn, { media });
    expect(c.ok).toBe(false);
    expect(c.history).toBe(h); // nothing recorded
  });

  it("one AI operation of many commands is one transaction — and one undo", () => {
    const seq = directorSequence();
    const ids = seededIds("ai");
    const e2 = item(seq, "event-2");
    const e4 = item(seq, "event-4");
    const e7 = item(seq, "event-7");
    const e6 = item(seq, "event-6");
    const split = commands.split(ids, seq, e2.id, e2.startFrame + 60);
    const txn = makeTransaction(ids, "Tighten act two", "director", [
      commands.trim(ids, e6.id, "out", -24),
      commands.move(ids, [e4.id], -6),
      split,
      commands.move(ids, [e7.id], -2),
      commands.delete(ids, [split.params.rightItemIds[e2.id]!]),
    ]);
    const h1 = committed(createHistory(seq), txn);
    expect(h1.past).toHaveLength(1);
    expect(findViolations(h1.present)).toEqual([]);
    expect(h1.present).not.toStrictEqual(seq);
    const h0 = undo(h1);
    expect(h0.present).toBe(seq);
    expect(redo(h0).present).toBe(h1.present);
  });
});

describe("undo / redo", () => {
  const cases: Array<
    [
      string,
      (s: ReturnType<typeof directorSequence>, ids: ReturnType<typeof seededIds>) => Transaction,
    ]
  > = [
    [
      "move",
      (s, ids) =>
        makeTransaction(ids, "Move", "manual", [commands.move(ids, [item(s, "event-6").id], 48)]),
    ],
    [
      "trim",
      (s, ids) =>
        makeTransaction(ids, "Trim", "manual", [
          commands.trim(ids, item(s, "event-1").id, "out", -1),
        ]),
    ],
    [
      "split",
      (s, ids) =>
        makeTransaction(ids, "Split", "manual", [
          commands.split(ids, s, item(s, "event-1").id, 100),
        ]),
    ],
    [
      "delete",
      (s, ids) =>
        makeTransaction(ids, "Delete", "manual", [commands.delete(ids, [item(s, "event-3").id])]),
    ],
    [
      "ripple delete",
      (s, ids) =>
        makeTransaction(ids, "Ripple", "manual", [
          commands.rippleDelete(ids, [item(s, "event-2").id]),
        ]),
    ],
    [
      "replace assembly",
      (s, ids) =>
        makeTransaction(ids, "Director build", "director", [
          commands.replaceAssembly(ids, assemblyFromLegacy(s, refinedCut, projectClips, ids)),
        ]),
    ],
  ];

  it.each(cases)(
    "%s → undo restores the exact original; undo → redo the exact edit",
    (_name, build) => {
      const seq = directorSequence();
      const h1 = committed(createHistory(seq), build(seq, seededIds("u")));
      const edited = h1.present;
      const h0 = undo(h1);
      expect(h0.present).toBe(seq);
      expect(h0.present).toStrictEqual(directorSequence());
      const hr = redo(h0);
      expect(hr.present).toBe(edited);
      expect(hr.present).toStrictEqual(edited);
    },
  );

  it("split → undo restores the original item and id; redo brings back the same generated ids", () => {
    const seq = directorSequence();
    const ids = seededIds("split-ids");
    const e1 = item(seq, "event-1");
    const cmd = commands.split(ids, seq, e1.id, 100);
    const h1 = committed(createHistory(seq), makeTransaction(ids, "Split", "manual", [cmd]));
    const rightIds = Object.values(cmd.params.rightItemIds).sort();
    const h0 = undo(h1);
    expect(h0.present.items[e1.id]).toBe(e1);
    for (const id of rightIds) expect(h0.present.items[id]).toBeUndefined();
    const hr = redo(h0);
    expect(rightIds.every((id) => hr.present.items[id])).toBe(true);
    expect(Object.keys(hr.present.items).sort()).toEqual(Object.keys(h1.present.items).sort());
  });

  it("a new edit after undo clears redo", () => {
    const seq = directorSequence();
    const ids = seededIds("inval");
    const h1 = committed(
      createHistory(seq),
      makeTransaction(ids, "A", "manual", [commands.move(ids, [item(seq, "event-6").id], 4)]),
    );
    const h0 = undo(h1);
    expect(canRedo(h0)).toBe(true);
    const h2 = committed(
      h0,
      makeTransaction(ids, "B", "manual", [commands.move(ids, [item(seq, "event-7").id], -4)]),
    );
    expect(canRedo(h2)).toBe(false);
    expect(redo(h2)).toBe(h2);
  });

  it("keeps at most 200 transactions, dropping the oldest", () => {
    const seq = directorSequence();
    const ids = seededIds("cap");
    const e6 = item(seq, "event-6").id;
    let h = createHistory(seq);
    const states = [seq];
    for (let n = 1; n <= 205; n += 1) {
      h = committed(
        h,
        makeTransaction(ids, `step ${n}`, "manual", [commands.move(ids, [e6], n % 2 ? 1 : -1)]),
      );
      states.push(h.present);
    }
    expect(HISTORY_CAP).toBe(200);
    expect(h.past).toHaveLength(200);
    expect(h.past[0]!.transaction.label).toBe("step 6");
    for (let n = 0; n < 200; n += 1) h = undo(h);
    expect(canUndo(h)).toBe(false);
    expect(h.present).toBe(states[5]); // the state before "step 6"
    expect(undo(h)).toBe(h);
  });

  it("records who issued each transaction", () => {
    const seq = directorSequence();
    const ids = seededIds("origins");
    let h = createHistory(seq);
    const origins: TransactionOrigin[] = ["manual", "director", "system"];
    origins.forEach((origin, n) => {
      h = committed(
        h,
        makeTransaction(ids, `by ${origin}`, origin, [
          commands.move(ids, [item(seq, "event-6").id], n + 1),
        ]),
      );
    });
    expect(h.past.map((e) => e.transaction.origin)).toEqual(origins);
    expect(nextUndo(h)).toEqual({ label: "by system", origin: "system" });
    expect(nextRedo(undo(h))).toEqual({ label: "by system", origin: "system" });
  });
});

describe("deterministic replay", () => {
  it("the same command log always produces the same sequence, ids included", () => {
    const seq = directorSequence();
    const ids = seededIds("log");
    const e2 = item(seq, "event-2");
    const split = commands.split(ids, seq, e2.id, e2.startFrame + 30);
    const log = [
      makeTransaction(ids, "Split", "manual", [split]),
      makeTransaction(ids, "Trim", "manual", [
        commands.trim(ids, split.params.rightItemIds[e2.id]!, "out", -12),
      ]),
      makeTransaction(ids, "Ripple", "manual", [
        commands.rippleDelete(ids, [item(seq, "event-1").id]),
      ]),
      makeTransaction(ids, "Lift", "director", [commands.delete(ids, [item(seq, "event-7").id])]),
    ];
    const a = replay(seq, log, { media });
    const b = replay(seq, log, { media });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.sequence).toStrictEqual(b.sequence);
      let h = createHistory(seq);
      for (const txn of log) h = committed(h, txn);
      expect(h.present).toStrictEqual(a.sequence);
      // The split's generated ids survive replay.
      expect(a.sequence.items[split.params.rightItemIds[e2.id]!]).toBeDefined();
    }
  });
});
