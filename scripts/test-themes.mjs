// US-022 test: user-theme reading + validation (src/themes/index.ts). Covers the
// pure validators (isValidColor, isKnownTokenKey, validateUserTheme,
// validateUserThemes) and the fs reader readUserThemes over a temp themes dir —
// the four required cases (valid accepted, bad token key rejected, bad color
// rejected, raw-CSS rejected) plus malformed/missing-file resilience.
//
// Run: tsx scripts/test-themes.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};

// Quiet the [themes] skip-reason warnings the negative cases intentionally emit.
const origWarn = console.warn;
console.warn = () => {};

try {
  const {
    isValidColor,
    isKnownTokenKey,
    validateUserTheme,
    validateUserThemes,
    readUserThemes,
    KNOWN_TOKEN_KEYS,
  } = await import("../src/themes/index.ts");

  // --- isValidColor ------------------------------------------------------
  check("hex #rrggbb accepted", isValidColor("#059669"));
  check("hex #rgb accepted", isValidColor("#abc"));
  check("hex #rrggbbaa accepted", isValidColor("#11223344"));
  check("rgb() accepted", isValidColor("rgb(5, 150, 105)"));
  check("rgba() accepted", isValidColor("rgba(5,150,105,0.5)"));
  check("modern rgb space/slash accepted", isValidColor("rgb(255 0 0 / 50%)"));
  check("hsl() accepted", isValidColor("hsl(160, 84%, 39%)"));
  check("hsl deg accepted", isValidColor("hsl(160deg 84% 39%)"));
  check("named color rejected (not a literal)", !isValidColor("red"));
  check("non-string rejected", !isValidColor(123));
  check("url() injection rejected", !isValidColor("url(http://evil)"));
  check("expression() injection rejected", !isValidColor("expression(alert(1))"));
  check("trailing-; injection rejected", !isValidColor("#059669; background:url(x)"));
  check("brace injection rejected", !isValidColor("#fff}body{display:none"));
  check("bare number rejected", !isValidColor("12345"));

  // --- isKnownTokenKey ---------------------------------------------------
  check("known token key accepted", isKnownTokenKey("background"));
  check("chart token accepted", isKnownTokenKey("chart-3"));
  check("radius not themeable (rejected)", !isKnownTokenKey("radius"));
  check("arbitrary key rejected", !isKnownTokenKey("evil-key"));
  check("KNOWN_TOKEN_KEYS has the ~30 tokens", KNOWN_TOKEN_KEYS.length >= 28);

  // --- validateUserTheme: VALID THEME ACCEPTED ---------------------------
  const validRaw = {
    id: "midnight",
    name: "Midnight",
    type: "dark",
    tokens: { background: "#0b0f17", foreground: "#e6edf3", "chart-1": "rgb(80, 250, 123)" },
  };
  const okResult = validateUserTheme(validRaw);
  check("valid theme accepted", "theme" in okResult);
  check(
    "valid theme keeps id/name/type/tokens",
    "theme" in okResult &&
      okResult.theme.id === "midnight" &&
      okResult.theme.name === "Midnight" &&
      okResult.theme.type === "dark" &&
      okResult.theme.tokens.background === "#0b0f17" &&
      Object.keys(okResult.theme.tokens).length === 3,
  );
  check(
    "partial theme (subset of tokens) accepted",
    "theme" in validateUserTheme({ id: "p", name: "P", type: "light", tokens: { primary: "#059669" } }),
  );

  // --- validateUserTheme: BAD TOKEN KEY REJECTED -------------------------
  const badKey = validateUserTheme({
    id: "x",
    name: "X",
    type: "dark",
    tokens: { background: "#000", "evil-key": "#fff" },
  });
  check("bad token key rejected", "error" in badKey);
  check("bad-key error names the key", "error" in badKey && badKey.error.includes("evil-key"));

  // --- validateUserTheme: BAD COLOR VALUE REJECTED -----------------------
  const badColor = validateUserTheme({
    id: "y",
    name: "Y",
    type: "light",
    tokens: { background: "not-a-color" },
  });
  check("bad color value rejected", "error" in badColor);

  // --- validateUserTheme: RAW-CSS REJECTED -------------------------------
  const rawCss = validateUserTheme({
    id: "z",
    name: "Z",
    type: "dark",
    tokens: { background: "#000; } body { background: url(http://evil) }" },
  });
  check("raw-CSS injection rejected", "error" in rawCss);

  // --- validateUserTheme: shape errors -----------------------------------
  check("missing id rejected", "error" in validateUserTheme({ name: "n", type: "dark", tokens: {} }));
  check("bad type rejected", "error" in validateUserTheme({ id: "i", name: "n", type: "blue", tokens: {} }));
  check("non-object tokens rejected", "error" in validateUserTheme({ id: "i", name: "n", type: "dark", tokens: "x" }));
  check("non-object theme rejected", "error" in validateUserTheme("nope"));

  // --- validateUserThemes: list + dedupe ---------------------------------
  const list = validateUserThemes([
    validRaw,
    { id: "bad", name: "B", type: "dark", tokens: { "evil-key": "#fff" } }, // skipped
    { id: "midnight", name: "Midnight 2", type: "dark", tokens: { background: "#111111" } }, // dedupe: last wins
  ]);
  check("validateUserThemes skips invalid, keeps valid", list.length === 1);
  check("validateUserThemes dedupes by id (last wins)", list[0].name === "Midnight 2");
  check("validateUserThemes accepts {themes:[…]} wrapper", validateUserThemes({ themes: [validRaw] }).length === 1);
  check("validateUserThemes on non-array yields []", validateUserThemes(42).length === 0);

  // --- readUserThemes over a temp dir ------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-themes-"));
  try {
    // themes.json (array) + themes/*.json (single object + wrapper)
    fs.writeFileSync(
      path.join(tmp, "themes.json"),
      JSON.stringify([validRaw, { id: "junk", name: "J", type: "dark", tokens: { "evil-key": "#fff" } }]),
    );
    fs.mkdirSync(path.join(tmp, "themes"));
    fs.writeFileSync(
      path.join(tmp, "themes", "extra.json"),
      JSON.stringify({ id: "ocean", name: "Ocean", type: "dark", tokens: { background: "#001" } }),
    );
    fs.writeFileSync(
      path.join(tmp, "themes", "wrapped.json"),
      JSON.stringify({ themes: [{ id: "sand", name: "Sand", type: "light", tokens: { background: "#fed" } }] }),
    );
    fs.writeFileSync(path.join(tmp, "themes", "broken.json"), "{ not valid json ,,,");

    const themes = readUserThemes(tmp);
    const ids = themes.map((t) => t.id).sort();
    check("readUserThemes reads themes.json + themes/*.json, skips invalid + malformed", JSON.stringify(ids) === JSON.stringify(["midnight", "ocean", "sand"]));
    check("readUserThemes missing dir yields []", readUserThemes(path.join(tmp, "nope")).length === 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} catch (err) {
  console.warn = origWarn;
  console.error("test-themes threw:", err);
  failed = true;
} finally {
  console.warn = origWarn;
}

if (failed) {
  console.error("\nSOME THEMES TESTS FAILED");
  process.exit(1);
}
console.log("\nall themes tests passed");
