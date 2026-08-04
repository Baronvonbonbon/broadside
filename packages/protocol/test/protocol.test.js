import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ActionType,
  CORE_SLOTS,
  CREATIVE_FORMATS,
  DEFAULT_FORMAT_ID,
  DROPPED_SLOTS,
  SLOTS,
  formatById,
  isSlot,
  splitPayment,
} from "../dist/index.js";

test("every creative format's tag matches its id", () => {
  // Format targeting works by the advertiser putting this exact tag in a
  // campaign's required tags while the widget injects it per slot. A drift
  // between the two spellings matches nothing, silently.
  for (const f of CREATIVE_FORMATS) {
    assert.equal(f.tag, `format:${f.id}`);
  }
});

test("formatById falls back rather than throwing", () => {
  assert.equal(formatById("nonsense").id, DEFAULT_FORMAT_ID);
  assert.equal(formatById(null).id, DEFAULT_FORMAT_ID);
  assert.equal(formatById("leaderboard").width, 728);
});

test("core slots are real slots", () => {
  for (const s of CORE_SLOTS) assert.ok(isSlot(s), `${s} is not in SLOTS`);
});

test("slot names are unique", () => {
  assert.equal(new Set(SLOTS).size, SLOTS.length);
});

test("dropped slots are actually gone", () => {
  // Guards against someone re-adding a contract the platform now provides.
  for (const name of Object.keys(DROPPED_SLOTS)) {
    assert.ok(!isSlot(name), `${name} was dropped but is back in SLOTS`);
  }
});

test("view payments are per-mille, click and action are flat", () => {
  const rate = 2_000_000n;
  const view = splitPayment(rate, 1000n, ActionType.View, 2000n);
  const click = splitPayment(rate, 1n, ActionType.Click, 2000n);
  assert.equal(view.total, rate); // 1000 views at a CPM rate == one rate unit
  assert.equal(click.total, rate);
});

test("the split conserves value exactly", () => {
  // Integer division truncates three times; the remainder has to land
  // somewhere rather than evaporate. Protocol absorbs it by construction.
  for (const take of [0n, 1n, 2500n, 3333n, 10000n]) {
    for (const count of [1n, 7n, 999n, 1000n]) {
      const s = splitPayment(1_234_567n, count, ActionType.View, take);
      assert.equal(
        s.publisher + s.user + s.protocol,
        s.total,
        `leak at take=${take} count=${count}`,
      );
    }
  }
});

test("a 100% take rate leaves the viewer nothing and still balances", () => {
  const s = splitPayment(1_000_000n, 1000n, ActionType.View, 10000n);
  assert.equal(s.publisher, s.total);
  assert.equal(s.user, 0n);
  assert.equal(s.protocol, 0n);
});
