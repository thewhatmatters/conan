import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * The UI can't import the gateway's types (separate tsconfig/build), so
 * `ui/src/hooks/useProviders.ts` hand-mirrors `AgentCapabilities`. Nothing in
 * the type system connects them: adding a capability on one side compiles
 * cleanly while the other silently lacks it, and the gap only surfaces when
 * some component finally reads the missing field.
 *
 * That already happened once — `modelSelection` was added to the driver seam
 * for the Grok resume fix and the UI mirror went without it until a composer
 * change tried to use it. This guard makes the drift a failing test instead of
 * a later surprise.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");

function interfaceFields(file: string, name: string): string[] {
  const src = fs.readFileSync(path.join(REPO, file), "utf8");
  const block = new RegExp(`export interface ${name} \\{(.*?)\\n\\}`, "s").exec(src);
  assert.ok(block?.[1], `${name} not found in ${file}`);
  const body = block[1]
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/.*/g, ""); // line comments
  return [...body.matchAll(/^\s*([A-Za-z_]\w*)\??\s*:/gm)].map((m) => m[1] as string).sort();
}

test("AgentCapabilities: the UI mirror matches the driver seam", () => {
  const gateway = interfaceFields("src/agent/driver.ts", "AgentCapabilities");
  const ui = interfaceFields("ui/src/hooks/useProviders.ts", "AgentCapabilities");
  assert.ok(gateway.length > 0, "gateway AgentCapabilities parsed no fields");
  assert.deepEqual(
    ui,
    gateway,
    "AgentCapabilities drifted — add the field to BOTH src/agent/driver.ts and " +
      "ui/src/hooks/useProviders.ts (and to every driver's descriptor).",
  );
});

test("AgentPermissionMode: the UI mirror matches the driver seam", () => {
  const gateway = interfaceFields("src/agent/driver.ts", "AgentPermissionMode");
  const ui = interfaceFields("ui/src/hooks/useProviders.ts", "AgentPermissionMode");
  assert.deepEqual(ui, gateway, "AgentPermissionMode drifted between gateway and UI");
});
