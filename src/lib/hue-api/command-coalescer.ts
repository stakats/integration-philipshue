/**
 * Philips Hue API for the Remote Two/3 integration driver.
 *
 * @copyright (c) 2026 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

/**
 * Leading-edge + trailing-coalesce rate limiter, keyed per light / grouped-light
 * resource ID. The first command in a quiet window fires immediately for
 * responsiveness; subsequent commands arriving within the min-interval window
 * are merged (last-writer-wins shallow merge per field) into a single pending
 * command, which fires at the end of the window.
 *
 * Motivation: the Hue bridge documents rate limits of 10 cmd/sec for /light and
 * 1 cmd/sec for /grouped_light. Dragging the color wheel on the UC remote can
 * emit events far faster than that; without coalescing, the bridge silently
 * drops the excess, meaning the user's final intended position may never reach
 * the bulb. Coalescing keeps the first and last positions of any drag burst
 * and discards the throwaway intermediate values.
 *
 * Semantics: callers await `send` to know the command (or a coalesced superset
 * of it) has been dispatched to the bridge. Coalesced callers will have their
 * params folded into the flush, and the promise resolves when that flush
 * completes.
 */
export class CommandCoalescer<Params extends object> {
  private state = new Map<
    string,
    {
      lastSentAt: number;
      pending?: {
        params: Params;
        timer: ReturnType<typeof setTimeout>;
        resolvers: Array<() => void>;
        rejectors: Array<(err: unknown) => void>;
      };
    }
  >();

  constructor(
    private readonly minIntervalMs: number,
    private readonly dispatch: (id: string, params: Params) => Promise<unknown>
  ) {}

  /**
   * Enqueue a command for the given resource ID. Returns a promise that
   * resolves when this command (or a later-coalesced superset of it) has
   * been dispatched to the bridge.
   */
  async send(id: string, params: Params): Promise<void> {
    const now = Date.now();
    const entry = this.state.get(id) ?? { lastSentAt: 0 };
    const elapsed = now - entry.lastSentAt;

    if (elapsed >= this.minIntervalMs && !entry.pending) {
      // Quiet window: fire immediately.
      entry.lastSentAt = now;
      this.state.set(id, entry);
      await this.dispatch(id, params);
      return;
    }

    // Within the window: coalesce into pending, schedule flush if not already.
    return new Promise<void>((resolve, reject) => {
      if (entry.pending) {
        clearTimeout(entry.pending.timer);
        entry.pending.params = { ...entry.pending.params, ...params };
        entry.pending.resolvers.push(resolve);
        entry.pending.rejectors.push(reject);
      } else {
        entry.pending = {
          params,
          timer: null as unknown as ReturnType<typeof setTimeout>,
          resolvers: [resolve],
          rejectors: [reject]
        };
      }
      const wait = Math.max(0, this.minIntervalMs - elapsed);
      entry.pending.timer = setTimeout(() => this.flush(id), wait);
      this.state.set(id, entry);
    });
  }

  /**
   * Test helper: returns number of currently-pending (not yet dispatched)
   * commands across all resource IDs.
   */
  pendingCount(): number {
    let count = 0;
    for (const entry of this.state.values()) {
      if (entry.pending) count++;
    }
    return count;
  }

  private async flush(id: string) {
    const entry = this.state.get(id);
    if (!entry?.pending) return;
    const { params, resolvers, rejectors } = entry.pending;
    entry.pending = undefined;
    entry.lastSentAt = Date.now();
    this.state.set(id, entry);
    try {
      await this.dispatch(id, params);
      for (const r of resolvers) r();
    } catch (err) {
      for (const r of rejectors) r(err);
    }
  }
}
