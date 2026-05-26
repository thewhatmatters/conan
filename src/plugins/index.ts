// US-011: plugins — surface the Claude Code plugins installed on this machine,
// the marketplaces they came from, and which are enabled. All read-only.
//
// Sources under ~/.claude (overridable for tests via CONAN_CLAUDE_DIR):
//   plugins/installed_plugins.json — { version, plugins: { "<name>@<market>":
//     [ { scope, installPath, projectPath?, version, installedAt, lastUpdated,
//         gitCommitSha } ] } }  (the value is an array — one entry per install
//     scope, e.g. a plugin can be user-scoped and project-scoped at once).
//   plugins/known_marketplaces.json — { "<market>": { source, installLocation,
//     lastUpdated } }.
// And the enabled flags live in settings.json `enabledPlugins`
//   { "<name>@<market>": boolean } — read from ~/.claude/settings.json and,
//   when an active project is given, merged with the project .claude/settings.json
//   (project wins) so project-scoped enables are honored.
//
// This module never throws: missing files, malformed JSON, or unexpected shapes
// all degrade to empty arrays.

import fs from "node:fs";
import path from "node:path";
import { HOME, PACKAGE_ROOT } from "../paths.js";

/** One installed plugin (flattened from the per-install array). */
export interface InstalledPlugin {
  /** "<name>@<marketplace>" key. */
  id: string;
  name: string;
  marketplace: string;
  scope: string;
  version: string | null;
  gitCommitSha: string | null;
  installPath: string | null;
  /** Set for project-scoped installs. */
  projectPath: string | null;
  installedAt: string | null;
  lastUpdated: string | null;
  /** From the merged enabledPlugins map; defaults to false when absent. */
  enabled: boolean;
}

export interface Marketplace {
  name: string;
  /** "git" | "github" | … from the source block. */
  sourceType: string | null;
  /** The git URL or owner/repo, whichever the source carries. */
  sourceUrl: string | null;
  installLocation: string | null;
  lastUpdated: string | null;
}

export interface PluginsStatus {
  plugins: InstalledPlugin[];
  marketplaces: Marketplace[];
}

/** The ~/.claude directory (overridable for tests via CONAN_CLAUDE_DIR). */
function claudeDir(): string {
  return process.env.CONAN_CLAUDE_DIR ?? path.join(HOME, ".claude");
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Read an `enabledPlugins` map from a settings.json, ignoring non-booleans. */
function readEnabledMap(file: string): Record<string, boolean> {
  const obj = readJson(file);
  const raw = obj?.enabledPlugins;
  const out: Record<string, boolean> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
  }
  return out;
}

export interface ReadPluginsOptions {
  /** Override ~/.claude (tests). */
  claudeDir?: string;
  /** Active project root; its .claude/settings.json enables are merged in. */
  projectDir?: string;
}

/**
 * Read installed plugins + marketplaces + enabled state. Missing/malformed
 * files degrade to empty arrays — never throws.
 */
export function readPlugins(opts: ReadPluginsOptions = {}): PluginsStatus {
  const dir = opts.claudeDir ?? claudeDir();
  const pluginsDir = path.join(dir, "plugins");

  // Enabled map: user settings.json, then project settings.json wins.
  const projectDir = opts.projectDir ?? PACKAGE_ROOT;
  const enabled: Record<string, boolean> = {
    ...readEnabledMap(path.join(dir, "settings.json")),
    ...readEnabledMap(path.join(projectDir, ".claude", "settings.json")),
  };

  const plugins: InstalledPlugin[] = [];
  const installed = readJson(path.join(pluginsDir, "installed_plugins.json"));
  const pluginMap = installed?.plugins;
  if (pluginMap && typeof pluginMap === "object") {
    for (const [id, installsRaw] of Object.entries(pluginMap as Record<string, unknown>)) {
      const at = id.lastIndexOf("@");
      const name = at > 0 ? id.slice(0, at) : id;
      const marketplace = at > 0 ? id.slice(at + 1) : "";
      const installs = Array.isArray(installsRaw) ? installsRaw : [];
      for (const inst of installs) {
        const e = (inst ?? {}) as Record<string, unknown>;
        plugins.push({
          id,
          name,
          marketplace,
          scope: str(e.scope) ?? "user",
          version: str(e.version),
          gitCommitSha: str(e.gitCommitSha),
          installPath: str(e.installPath),
          projectPath: str(e.projectPath),
          installedAt: str(e.installedAt),
          lastUpdated: str(e.lastUpdated),
          enabled: enabled[id] === true,
        });
      }
    }
  }
  // Stable order: by id, then scope.
  plugins.sort((a, b) => a.id.localeCompare(b.id) || a.scope.localeCompare(b.scope));

  const marketplaces: Marketplace[] = [];
  const known = readJson(path.join(pluginsDir, "known_marketplaces.json"));
  if (known) {
    for (const [name, v] of Object.entries(known)) {
      const m = (v ?? {}) as Record<string, unknown>;
      const source = (m.source ?? {}) as Record<string, unknown>;
      marketplaces.push({
        name,
        sourceType: str(source.source),
        sourceUrl: str(source.url) ?? str(source.repo),
        installLocation: str(m.installLocation),
        lastUpdated: str(m.lastUpdated),
      });
    }
  }
  marketplaces.sort((a, b) => a.name.localeCompare(b.name));

  return { plugins, marketplaces };
}
