/**
 * Philips Hue API for the Remote Two/3 integration driver.
 *
 * @copyright (c) 2024 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

import { HueError, ResourceApi } from "./api.js";
import { StatusCodes } from "@unfoldedcircle/integration-api";
import {
  CombinedSceneResource,
  GroupResourceResponse,
  SceneRecallAction,
  SceneRecallBody,
  SceneRecallResponse,
  SceneResource as SceneResourceData,
  SceneResourceResult
} from "./types.js";

class SceneResource {
  private readonly api: ResourceApi;

  constructor(api: ResourceApi) {
    this.api = api;
  }

  public async getScenes(): Promise<CombinedSceneResource[]> {
    const res = await this.api.sendRequest<SceneResourceResult>("GET", "/clip/v2/resource/scene");
    if (!res.data || res.data.length === 0) {
      return [];
    }

    const groupNameById = await this.fetchGroupNameMap();
    return res.data.map((scene) => this.toCombined(scene, groupNameById));
  }

  public async getScene(id: string): Promise<CombinedSceneResource> {
    const res = await this.api.sendRequest<SceneResourceResult>("GET", `/clip/v2/resource/scene/${id}`);
    if (!res.data || res.data.length === 0) {
      throw new HueError("Scene resource not found", StatusCodes.NotFound);
    }

    const groupNameById = await this.fetchGroupNameMap();
    return this.toCombined(res.data[0], groupNameById);
  }

  public async recall(id: string, action: SceneRecallAction = "active"): Promise<SceneRecallResponse["data"]> {
    const body: SceneRecallBody = { recall: { action } };
    const res = await this.api.sendRequest<SceneRecallResponse>("PUT", `/clip/v2/resource/scene/${id}`, body);
    return res.data ?? [];
  }

  private async fetchGroupNameMap(): Promise<Map<string, string>> {
    const [rooms, zones] = await Promise.all([
      this.api.sendRequest<GroupResourceResponse>("GET", "/clip/v2/resource/room"),
      this.api.sendRequest<GroupResourceResponse>("GET", "/clip/v2/resource/zone")
    ]);
    const map = new Map<string, string>();
    for (const group of [...(rooms.data ?? []), ...(zones.data ?? [])]) {
      map.set(group.id, group.metadata.name);
    }
    return map;
  }

  private toCombined(scene: SceneResourceData, groupNameById: Map<string, string>): CombinedSceneResource {
    const rtype: "room" | "zone" = scene.group.rtype === "zone" ? "zone" : "room";
    return {
      id: scene.id,
      name: scene.metadata.name,
      group: { rid: scene.group.rid, rtype },
      groupName: groupNameById.get(scene.group.rid),
      active: scene.status?.active
    };
  }
}

export default SceneResource;
