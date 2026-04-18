import test from "ava";
import { CommandCoalescer } from "../src/lib/hue-api/command-coalescer.js";

// Helper: wait for `ms` milliseconds. Used because the coalescer uses real
// timers and AVA's default executor runs in a real-time event loop.
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("fires the first command immediately", async (t) => {
  const calls: Array<{ id: string; params: Record<string, unknown> }> = [];
  const c = new CommandCoalescer<Record<string, unknown>>(50, async (id, params) => {
    calls.push({ id, params });
  });

  await c.send("light-a", { on: { on: true } });
  t.is(calls.length, 1);
  t.deepEqual(calls[0], { id: "light-a", params: { on: { on: true } } });
});

test("coalesces bursts within the min interval into a single dispatch", async (t) => {
  const calls: Array<{ id: string; params: Record<string, unknown> }> = [];
  const c = new CommandCoalescer<Record<string, unknown>>(50, async (id, params) => {
    calls.push({ id, params });
  });

  // First fires immediately.
  await c.send("light-a", { color: { xy: { x: 0.1, y: 0.1 } } });
  // Subsequent three within the window get coalesced — we don't await yet
  // because the coalescer returns a promise tied to the eventual flush.
  const p2 = c.send("light-a", { color: { xy: { x: 0.2, y: 0.2 } } });
  const p3 = c.send("light-a", { color: { xy: { x: 0.3, y: 0.3 } } });
  const p4 = c.send("light-a", { color: { xy: { x: 0.4, y: 0.4 } } });

  await Promise.all([p2, p3, p4]);

  t.is(calls.length, 2);
  t.deepEqual(calls[0].params, { color: { xy: { x: 0.1, y: 0.1 } } });
  // Coalesced flush should carry the LAST sender's params (shallow last-wins merge).
  t.deepEqual(calls[1].params, { color: { xy: { x: 0.4, y: 0.4 } } });
});

test("shallow-merges coalesced params across different fields", async (t) => {
  const calls: Array<{ id: string; params: Record<string, unknown> }> = [];
  const c = new CommandCoalescer<Record<string, unknown>>(50, async (id, params) => {
    calls.push({ id, params });
  });

  await c.send("light-a", { on: { on: true } });
  const p2 = c.send("light-a", { color: { xy: { x: 0.5, y: 0.5 } } });
  const p3 = c.send("light-a", { dimming: { brightness: 80 } });

  await Promise.all([p2, p3]);

  t.is(calls.length, 2);
  // Flushed command includes BOTH color and dimming from different coalesced sends.
  t.deepEqual(calls[1].params, {
    color: { xy: { x: 0.5, y: 0.5 } },
    dimming: { brightness: 80 }
  });
});

test("different keys dispatch independently (no cross-interference)", async (t) => {
  const calls: Array<{ id: string; params: Record<string, unknown> }> = [];
  const c = new CommandCoalescer<Record<string, unknown>>(50, async (id, params) => {
    calls.push({ id, params });
  });

  await c.send("light-a", { on: { on: true } });
  await c.send("light-b", { on: { on: false } });

  t.is(calls.length, 2);
  t.is(calls[0].id, "light-a");
  t.is(calls[1].id, "light-b");
});

test("after min-interval elapses, next command fires immediately again", async (t) => {
  const calls: Array<{ id: string; params: Record<string, unknown> }> = [];
  const c = new CommandCoalescer<Record<string, unknown>>(30, async (id, params) => {
    calls.push({ id, params });
  });

  await c.send("light-a", { on: { on: true } });
  t.is(calls.length, 1);

  // Wait past the min interval, then send another. Should fire immediately.
  await wait(50);
  await c.send("light-a", { on: { on: false } });
  t.is(calls.length, 2);
});

test("pending count reflects unflushed commands", async (t) => {
  let dispatched = 0;
  const c = new CommandCoalescer<Record<string, unknown>>(100, async () => {
    dispatched++;
  });

  await c.send("light-a", { on: { on: true } });
  t.is(dispatched, 1);
  t.is(c.pendingCount(), 0);

  // Queue a few within the window — should be pending.
  const pA = c.send("light-a", { on: { on: false } });
  const pB = c.send("light-a", { on: { on: true } });
  t.is(c.pendingCount(), 1);

  await Promise.all([pA, pB]);
  t.is(c.pendingCount(), 0);
  t.is(dispatched, 2);
});

test("dispatch errors reject all coalesced send() promises", async (t) => {
  const c = new CommandCoalescer<Record<string, unknown>>(30, async (_id, params) => {
    if ((params as { fail?: boolean }).fail) throw new Error("boom");
  });

  await c.send("light-a", { on: { on: true } });
  const p2 = c.send("light-a", { on: { on: false } });
  const p3 = c.send("light-a", { fail: true });

  await t.throwsAsync(p2, { message: "boom" });
  await t.throwsAsync(p3, { message: "boom" });
});
