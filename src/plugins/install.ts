import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Install bundled Conan skills into Claude Code's discovery path by symlinking
 * each `<CONAN_PLUGIN_DIR>/<plugin>/skills/<skill>/` into
 * `~/.claude/skills/<skill>/`.
 *
 * Why symlinks + the user-skills path (not the plugins tree): Claude Code's
 * plugin discovery is driven by `installed_plugins.json` (a manifest of
 * marketplace-installed plugins). A raw `~/.claude/plugins/<name>/` directory
 * — even a symlink — is not picked up by that manifest, so a skill placed
 * there is invisible to Claude. Symlinking each skill into `~/.claude/skills/`
 * uses Claude's standard user-skill scan, no manifest touch required, while
 * keeping the source-of-truth inside the Tauri app bundle (the symlink target
 * is `Contents/Resources/plugin/<plugin>/skills/<skill>/`).
 *
 * Safety:
 *  - If `~/.claude/skills/<skill>` is a regular directory (not a symlink), we
 *    skip with a warning — that's a user-authored skill we won't clobber.
 *  - If it's a symlink pointing somewhere else (a different Conan install,
 *    say), we re-point it at our bundle. The previous target is presumed
 *    stale (a removed Conan install).
 *  - All filesystem work is best-effort: warnings on stderr, the gateway
 *    keeps booting either way.
 */
export function installBundledPlugins(): void {
  const src = process.env.CONAN_PLUGIN_DIR;
  if (!src) return; // not running under the Tauri sidecar (or env override)

  let plugins: fs.Dirent[];
  try {
    plugins = fs.readdirSync(src, { withFileTypes: true });
  } catch (e) {
    console.warn(
      `[conan] plugin source dir not readable (${src}):`,
      (e as Error).message,
    );
    return;
  }

  const skillsRoot = path.join(os.homedir(), ".claude", "skills");
  try {
    fs.mkdirSync(skillsRoot, { recursive: true });
  } catch (e) {
    console.warn(
      `[conan] could not create ${skillsRoot}:`,
      (e as Error).message,
    );
    return;
  }

  for (const plugin of plugins) {
    if (!plugin.isDirectory()) continue;
    const pluginSkillsDir = path.join(src, plugin.name, "skills");
    let skills: fs.Dirent[];
    try {
      skills = fs.readdirSync(pluginSkillsDir, { withFileTypes: true });
    } catch {
      continue; // plugin has no skills/ subdir — fine
    }
    for (const skill of skills) {
      if (!skill.isDirectory()) continue;
      const srcSkill = path.join(pluginSkillsDir, skill.name);
      const destLink = path.join(skillsRoot, skill.name);
      linkSkill(srcSkill, destLink, skill.name);
    }
  }
}

function linkSkill(srcSkill: string, destLink: string, name: string): void {
  let existing: fs.Stats | null = null;
  let existingTarget: string | null = null;
  try {
    existing = fs.lstatSync(destLink);
    if (existing.isSymbolicLink()) {
      existingTarget = fs.readlinkSync(destLink);
    }
  } catch {
    /* doesn't exist — we'll create it */
  }

  if (existing && !existing.isSymbolicLink()) {
    console.warn(
      `[conan] skipping skill install for "${name}": ${destLink} exists as a regular directory; refusing to clobber a user-authored skill.`,
    );
    return;
  }
  if (existing && existingTarget === srcSkill) {
    return; // already correct
  }
  try {
    if (existing) fs.unlinkSync(destLink);
    fs.symlinkSync(srcSkill, destLink, "dir");
    console.log(`[conan] linked skill ${name} → ${srcSkill}`);
  } catch (e) {
    console.warn(
      `[conan] failed to link skill ${name}:`,
      (e as Error).message,
    );
  }
}
