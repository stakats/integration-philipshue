import test from "ava";
import { HueError, ResourceApi } from "../src/lib/hue-api/api.js";
import SceneResource from "../src/lib/hue-api/scene-resource.js";
import { GroupResourceResponse, SceneRecallResponse, SceneResourceResult } from "../src/lib/hue-api/types.js";

interface RequestRecord {
  method: "GET" | "POST" | "PUT";
  endpoint: string;
  body?: unknown;
}

interface MockResponses {
  [endpoint: string]: unknown;
}

function makeMockApi(responses: MockResponses): { api: ResourceApi; calls: RequestRecord[] } {
  const calls: RequestRecord[] = [];
  const api: ResourceApi = {
    sendRequest: async <T>(method: "GET" | "POST" | "PUT", endpoint: string, body?: unknown): Promise<T> => {
      calls.push({ method, endpoint, body });
      if (!(endpoint in responses)) {
        throw new Error(`mock api: no response configured for ${method} ${endpoint}`);
      }
      return responses[endpoint] as T;
    }
  };
  return { api, calls };
}

const ROOM_ID = "11111111-1111-1111-1111-111111111111";
const ZONE_ID = "22222222-2222-2222-2222-222222222222";
const SCENE_IN_ROOM_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SCENE_IN_ZONE_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ORPHAN_SCENE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const roomsResponse: GroupResourceResponse = {
  errors: [],
  data: [
    {
      id: ROOM_ID,
      children: [],
      services: [],
      type: "room",
      metadata: { name: "Living Room", archetype: "living_room" }
    }
  ]
};

const zonesResponse: GroupResourceResponse = {
  errors: [],
  data: [
    {
      id: ZONE_ID,
      children: [],
      services: [],
      type: "zone",
      metadata: { name: "Downstairs", archetype: "other" }
    }
  ]
};

test("getScenes resolves groupName for room and zone scenes, leaves orphans undefined", async (t) => {
  const scenesResponse: SceneResourceResult = {
    errors: [],
    data: [
      {
        id: SCENE_IN_ROOM_ID,
        type: "scene",
        metadata: { name: "Sunset" },
        group: { rid: ROOM_ID, rtype: "room" }
      },
      {
        id: SCENE_IN_ZONE_ID,
        type: "scene",
        metadata: { name: "Movie" },
        group: { rid: ZONE_ID, rtype: "zone" }
      },
      {
        id: ORPHAN_SCENE_ID,
        type: "scene",
        metadata: { name: "Stale" },
        group: { rid: "deadbeef-dead-beef-dead-beefdeadbeef", rtype: "room" }
      }
    ]
  };

  const { api } = makeMockApi({
    "/clip/v2/resource/scene": scenesResponse,
    "/clip/v2/resource/room": roomsResponse,
    "/clip/v2/resource/zone": zonesResponse
  });

  const sceneResource = new SceneResource(api);
  const scenes = await sceneResource.getScenes();

  t.is(scenes.length, 3);

  const room = scenes.find((s) => s.id === SCENE_IN_ROOM_ID);
  t.truthy(room);
  t.is(room?.name, "Sunset");
  t.is(room?.group.rid, ROOM_ID);
  t.is(room?.group.rtype, "room");
  t.is(room?.groupName, "Living Room");

  const zone = scenes.find((s) => s.id === SCENE_IN_ZONE_ID);
  t.is(zone?.groupName, "Downstairs");
  t.is(zone?.group.rtype, "zone");

  const orphan = scenes.find((s) => s.id === ORPHAN_SCENE_ID);
  t.is(orphan?.groupName, undefined, "orphan scene resolves groupName to undefined without throwing");
});

test("getScenes returns empty array when no scenes exist", async (t) => {
  const { api, calls } = makeMockApi({
    "/clip/v2/resource/scene": { errors: [], data: [] } as SceneResourceResult
  });

  const sceneResource = new SceneResource(api);
  const scenes = await sceneResource.getScenes();

  t.deepEqual(scenes, []);
  // when there are no scenes, we skip the room/zone fetch entirely
  t.is(calls.length, 1);
  t.is(calls[0].endpoint, "/clip/v2/resource/scene");
});

test("getScene maps empty data to NotFound HueError", async (t) => {
  const { api } = makeMockApi({
    [`/clip/v2/resource/scene/${ORPHAN_SCENE_ID}`]: { errors: [], data: [] } as SceneResourceResult
  });

  const sceneResource = new SceneResource(api);

  await t.throwsAsync(() => sceneResource.getScene(ORPHAN_SCENE_ID), {
    instanceOf: HueError,
    message: "Scene resource not found"
  });
});

test("recall defaults to action: 'active' and PUTs to the scene endpoint", async (t) => {
  const recallResponse: SceneRecallResponse = {
    errors: [],
    data: [{ rid: SCENE_IN_ROOM_ID }]
  };

  const { api, calls } = makeMockApi({
    [`/clip/v2/resource/scene/${SCENE_IN_ROOM_ID}`]: recallResponse
  });

  const sceneResource = new SceneResource(api);
  const data = await sceneResource.recall(SCENE_IN_ROOM_ID);

  t.is(calls.length, 1);
  t.is(calls[0].method, "PUT");
  t.is(calls[0].endpoint, `/clip/v2/resource/scene/${SCENE_IN_ROOM_ID}`);
  t.deepEqual(calls[0].body, { recall: { action: "active" } });
  t.deepEqual(data, [{ rid: SCENE_IN_ROOM_ID }]);
});

test("getSceneStatuses returns {id, groupId, active} and skips the room/zone fetch", async (t) => {
  const scenesResponse: SceneResourceResult = {
    errors: [],
    data: [
      {
        id: SCENE_IN_ROOM_ID,
        type: "scene",
        metadata: { name: "Sunset" },
        group: { rid: ROOM_ID, rtype: "room" },
        status: { active: "static" }
      },
      {
        id: SCENE_IN_ZONE_ID,
        type: "scene",
        metadata: { name: "Movie" },
        group: { rid: ZONE_ID, rtype: "zone" },
        status: { active: "inactive" }
      },
      {
        id: ORPHAN_SCENE_ID,
        type: "scene",
        metadata: { name: "Stale" },
        group: { rid: ROOM_ID, rtype: "room" }
      }
    ]
  };

  const { api, calls } = makeMockApi({
    "/clip/v2/resource/scene": scenesResponse
  });

  const sceneResource = new SceneResource(api);
  const statuses = await sceneResource.getSceneStatuses();

  t.is(calls.length, 1, "should make exactly one API call (no room/zone fetch)");
  t.is(calls[0].endpoint, "/clip/v2/resource/scene");
  t.deepEqual(statuses, [
    { id: SCENE_IN_ROOM_ID, groupId: ROOM_ID, active: "static" },
    { id: SCENE_IN_ZONE_ID, groupId: ZONE_ID, active: "inactive" },
    { id: ORPHAN_SCENE_ID, groupId: ROOM_ID, active: undefined }
  ]);
});

test("getSceneStatuses returns empty array when no scenes exist", async (t) => {
  const { api } = makeMockApi({
    "/clip/v2/resource/scene": { errors: [], data: [] } as SceneResourceResult
  });
  const sceneResource = new SceneResource(api);
  t.deepEqual(await sceneResource.getSceneStatuses(), []);
});

test("recall forwards an explicit action to the bridge", async (t) => {
  const recallResponse: SceneRecallResponse = { errors: [], data: [{ rid: SCENE_IN_ROOM_ID }] };
  const { api, calls } = makeMockApi({
    [`/clip/v2/resource/scene/${SCENE_IN_ROOM_ID}`]: recallResponse
  });

  const sceneResource = new SceneResource(api);

  await sceneResource.recall(SCENE_IN_ROOM_ID, "dynamic_palette");
  t.deepEqual(calls.at(-1)?.body, { recall: { action: "dynamic_palette" } });

  await sceneResource.recall(SCENE_IN_ROOM_ID, "static");
  t.deepEqual(calls.at(-1)?.body, { recall: { action: "static" } });
});
