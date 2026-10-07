// Stable identity for every object in the canonical edit model.
//
// IDs are generated ONCE — when an object is created (a new item, a track, a
// transaction, a command) — and never change afterwards. They are never
// derived from array position or from a clock.
//
// - `IdGenerator` is injected wherever ids are created, so production uses
//   random ids while tests (and command replay) can use a seeded, fully
//   deterministic generator.
// - `stableId` derives an id from content. It exists for ONE job: importing
//   legacy (schema-1) data, which is converted on every load until it is saved
//   in schema 2, so the same legacy cut must get the same ids each time.

export const ID_PREFIX = {
  sequence: "seq",
  track: "trk",
  item: "itm",
  link: "lnk",
  transaction: "txn",
  command: "cmd",
  version: "ver",
} as const;

export type IdKind = keyof typeof ID_PREFIX;

export interface IdGenerator {
  next(kind: IdKind): string;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Random 128-bit ids, e.g. `itm_5f0c…` (production). */
export const randomIds: IdGenerator = {
  next(kind) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return `${ID_PREFIX[kind]}_${hex(bytes)}`;
  },
};

/** Deterministic ids for tests and replay: the same seed yields the same
 * sequence of ids, independent of time or of other generators. */
export function seededIds(seed: string): IdGenerator {
  let n = 0;
  return {
    next(kind) {
      n += 1;
      return stableId(kind, seed, String(n));
    },
  };
}

const MASK64 = (1n << 64n) - 1n;
const FNV_PRIME = 0x100000001b3n;

function fnv1a64(input: string, offset: bigint): bigint {
  let h = offset;
  for (const byte of new TextEncoder().encode(input)) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/** A 128-bit content-derived id: the same parts always give the same id.
 * Parts are length-prefixed, so ("ab","c") and ("a","bc") differ. */
export function stableId(kind: IdKind, ...parts: string[]): string {
  const input = parts.map((p) => `${p.length}:${p}`).join("|");
  const a = fnv1a64(input, 0xcbf29ce484222325n);
  const b = fnv1a64(input, 0x84222325cbf29ce4n);
  return `${ID_PREFIX[kind]}_${a.toString(16).padStart(16, "0")}${b.toString(16).padStart(16, "0")}`;
}
