import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommandSource,
  createFileSource,
  createSkillSource,
} from "../lib/composerTriggers.ts";

afterEach(() => vi.unstubAllGlobals());

function respond(body: unknown) {
  const fetch = vi.fn(async (_url: string) =>
    new Response(JSON.stringify(body), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("composer trigger sources", () => {
  it("maps file results to v1-compatible @ tokens", async () => {
    const fetch = respond({ hits: [{ rel: "src/app.ts", name: "app.ts" }] });
    const items = await createFileSource("token", "/repo").search("app");
    expect(fetch.mock.calls[0]?.[0]).toContain("path=%2Frepo&q=app");
    expect(items[0]).toMatchObject({ id: "@src/app.ts", label: "src/app.ts" });
  });

  it("maps and caches skills", async () => {
    const fetch = respond([{ name: "audit-ui", description: "Audit UI" }]);
    const source = createSkillSource("token");
    expect((await source.search("audit"))[0]?.id).toBe("$audit-ui");
    await source.search("audit");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps commands with their argument hints", async () => {
    respond([{ name: "review", argumentHint: "[path]", source: "user" }]);
    const items = await createCommandSource("token", "/repo").search("rev");
    expect(items[0]).toMatchObject({ id: "/review", label: "/review [path]" });
  });
});
