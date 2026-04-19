/**
 * Philips Hue API for the Remote Two/3 integration driver.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

import { HueError, ResourceApi } from "./api.js";
import { StatusCodes } from "@unfoldedcircle/integration-api";
import {
  LightEffect,
  LightResource as LightResourceData,
  LightResourceParams,
  LightResourceResponse,
  LightResourceResult
} from "./types.js";
import { CommandCoalescer } from "./command-coalescer.js";

// Per-resource minimum dispatch intervals. The Hue CLIP v2 core-concepts doc
// gives "10 /light per second, 1 /grouped_light per second" as guidance for
// sustained rates, but bridges empirically absorb short bursts well above
// those figures, and the Hue app itself dispatches /grouped_light faster than
// 1/sec during a slider drag (otherwise its slider would feel as laggy as a
// strictly-1/sec coalescer). We keep /light at the documented 10/sec and set
// /grouped_light to 4/sec, which matches the bridge behavior we see on the
// target hardware and eliminates the 200–1000ms pending-flush lag a user
// felt on slow, deliberate group brightness drags. The coalescer still rate-
// limits — a true fire-hose (color-wheel drag at 30Hz etc.) still merges —
// so this is a lag floor tuning, not a protection change.
const LIGHT_MIN_INTERVAL_MS = 100;
const GROUPED_LIGHT_MIN_INTERVAL_MS = 250;

class LightResource {
  private readonly api: ResourceApi;
  private readonly lightCoalescer: CommandCoalescer<Partial<LightResourceParams>>;
  private readonly groupedLightCoalescer: CommandCoalescer<Partial<LightResourceParams>>;

  constructor(api: ResourceApi) {
    this.api = api;
    this.lightCoalescer = new CommandCoalescer<Partial<LightResourceParams>>(LIGHT_MIN_INTERVAL_MS, (id, params) =>
      this.api.sendRequest<LightResourceResponse>("PUT", `/clip/v2/resource/light/${id}`, params)
    );
    this.groupedLightCoalescer = new CommandCoalescer<Partial<LightResourceParams>>(
      GROUPED_LIGHT_MIN_INTERVAL_MS,
      (id, params) =>
        this.api.sendRequest<LightResourceResponse>("PUT", `/clip/v2/resource/grouped_light/${id}`, params)
    );
  }

  async getLights(): Promise<LightResourceData[]> {
    const res = await this.api.sendRequest<LightResourceResult>("GET", "/clip/v2/resource/light");
    return res.data.map((light) => this.getWithCleanedV1Id(light));
  }

  async getLight(id: string): Promise<LightResourceData> {
    const res = await this.api.sendRequest<LightResourceResult>("GET", `/clip/v2/resource/light/${id}`);
    if (!res.data || res.data.length === 0) {
      throw new HueError("Light not found", StatusCodes.NotFound);
    }
    return this.getWithCleanedV1Id(res.data[0]);
  }

  private getWithCleanedV1Id(light: LightResourceData) {
    if (!light.id_v1) return light;

    const parts = light.id_v1.split("/");
    const cleanedIdV1 = parts[parts.length - 1];
    return {
      ...light,
      id_v1: cleanedIdV1
    };
  }

  async setOn(id: string, on: boolean, singleLight: boolean): Promise<LightResourceResponse["data"]> {
    const endpoint = singleLight ? `/clip/v2/resource/light/${id}` : `/clip/v2/resource/grouped_light/${id}`;
    const res = await this.api.sendRequest<LightResourceResponse>("PUT", endpoint, {
      on: { on }
    });
    return res.data;
  }

  async setBrightness(id: string, brightness: number, singleLight: boolean): Promise<LightResourceResponse["data"]> {
    const endpoint = singleLight ? `/clip/v2/resource/light/${id}` : `/clip/v2/resource/grouped_light/${id}`;
    const res = await this.api.sendRequest<LightResourceResponse>("PUT", endpoint, {
      dimming: {
        brightness: Math.max(1, Math.min(100, brightness))
      }
    });
    return res.data;
  }

  async setColorTemperature(id: string, mirek: number, singleLight: boolean): Promise<LightResourceResponse["data"]> {
    const endpoint = singleLight ? `/clip/v2/resource/light/${id}` : `/clip/v2/resource/grouped_light/${id}`;
    const res = await this.api.sendRequest<LightResourceResponse>("PUT", endpoint, {
      color_temperature: {
        mirek: Math.max(153, Math.min(500, mirek))
      }
    });
    return res.data;
  }

  async setColor(id: string, x: number, y: number, singleLight: boolean): Promise<LightResourceResponse["data"]> {
    const endpoint = singleLight ? `/clip/v2/resource/light/${id}` : `/clip/v2/resource/grouped_light/${id}`;
    const res = await this.api.sendRequest<LightResourceResponse>("PUT", endpoint, {
      color: {
        xy: {
          x: Math.max(0, Math.min(1, x)),
          y: Math.max(0, Math.min(1, y))
        }
      }
    });
    return res.data;
  }

  // not sure if it's supported by UC, it is not in light attributes
  async setEffect(id: string, effect: LightEffect): Promise<LightResourceResponse["data"]> {
    const res = await this.api.sendRequest<LightResourceResponse>("PUT", `/clip/v2/resource/light/${id}`, {
      effects: {
        effect: effect === "no_effect" ? undefined : effect,
        status: effect === "no_effect" ? "no_effect" : "active"
      }
    });
    return res.data;
  }

  /**
   * Send a light-state update. Routes through the per-resource coalescer so
   * bursts from color-wheel drags don't exceed the bridge's documented rate
   * limits. Callers await resolution to know the command (or a coalesced
   * superset of it) has been dispatched. The bridge's own response body is not
   * surfaced to the caller when coalesced; no current caller consumes it.
   */
  async updateLightState(id: string, params: Partial<LightResourceParams>, singleLight: boolean): Promise<void> {
    const coalescer = singleLight ? this.lightCoalescer : this.groupedLightCoalescer;
    await coalescer.send(id, params);
  }
}

export default LightResource;
