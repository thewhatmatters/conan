// US-005 test: the skills frontmatter reader (src/skills/index.ts). Covers the
// pure frontmatter parser (description present/absent/quoted/malformed) and
// readSkills over a temp project-skills fixture (source tagging, name-only
// fallback when a description is missing, dirs without SKILL.md skipped, builtins
// emitted name-only, dedup precedence). No real-tree assertions beyond presence.
//
// Run: tsx scripts/test-skills.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};

try {
  const { frontmatterDescription, frontmatterField, readSkills } =
    await import("../src/skills/index.ts");

  // --- frontmatter parser -------------------------------------------------
  const fm = (desc) => `---\nname: x\ndescription: ${desc}\n---\n\n# body`;
  check("reads a plain description", frontmatterDescription(fm("Does a thing.")) === "Does a thing.");
  check(
    "long single-line description preserved",
    frontmatterDescription(fm("A very long description with — dashes, commas, and \"quotes\" inside.")) ===
      'A very long description with — dashes, commas, and "quotes" inside.',
  );
  check("strips matched double quotes", frontmatterDescription(fm('"quoted value"')) === "quoted value");
  check("strips matched single quotes", frontmatterDescription(fm("'quoted value'")) === "quoted value");
  check("no frontmatter -> null", frontmatterDescription("# just a heading\ntext") === null);
  check(
    "frontmatter without description -> null",
    frontmatterDescription("---\nname: x\nlicense: MIT\n---\n") === null,
  );
  check("empty description value -> null", frontmatterDescription(fm("")) === null);
  check("frontmatter must lead the file -> null", frontmatterDescription("intro\n---\ndescription: y\n---") === null);
  check("reads the name field too", frontmatterField(fm("d"), "name") === "x");
  check("missing field -> null", frontmatterField(fm("d"), "nope") === null);

  // --- readSkills over a temp project fixture -----------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-skills-"));
  const skillsRoot = path.join(tmp, ".claude", "skills");
  const mkSkill = (dir, contents) => {
    const d = path.join(skillsRoot, dir);
    fs.mkdirSync(d, { recursive: true });
    if (contents != null) fs.writeFileSync(path.join(d, "SKILL.md"), contents);
  };
  mkSkill("alpha", "---\nname: alpha\ndescription: The alpha skill.\n---\n# alpha");
  mkSkill("beta", "---\nname: beta\n---\n# beta (no description)"); // name-only fallback
  mkSkill("no-skill-md", null); // dir without SKILL.md -> skipped
  fs.writeFileSync(path.join(skillsRoot, "README.md"), "not a skill"); // stray file -> ignored

  const skills = readSkills(tmp, ["init", "review"]);
  const byName = (n) => skills.find((s) => s.name === n);

  check("project skill parsed with description + source", (() => {
    const a = byName("alpha");
    return a && a.description === "The alpha skill." && a.source === "Project";
  })());
  check("skill missing description -> listed name-only (no fabrication)", (() => {
    const b = byName("beta");
    return b && b.description === null && b.source === "Project";
  })());
  check("dir without SKILL.md is not listed", byName("no-skill-md") === undefined);
  check("stray non-dir entry is not listed", byName("README.md") === undefined);
  check("builtins emitted name-only with Built-in source", (() => {
    const i = byName("init");
    return i && i.description === null && i.source === "Built-in" && i.plugin === undefined;
  })());
  check("every entry has the required shape", skills.every(
    (s) => typeof s.name === "string" && (s.description === null || typeof s.description === "string") &&
      ["User", "Project", "Plugin", "Built-in"].includes(s.source),
  ));
  check("names are deduped", skills.length === new Set(skills.map((s) => s.name)).size);

  fs.rmSync(tmp, { recursive: true, force: true });
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
