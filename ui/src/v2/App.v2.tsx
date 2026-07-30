/**
 * Conan v2 — the shell. Paper artboard RJ-0 "Application Shell".
 *   https://app.paper.design/file/01KYQJ3S5RCDAE0KY87NRFY75F/1-0/RJ-0
 *
 * COMPOSITION CONTRACT (docs/v2-astryx-redesign.md §4.4)
 * -----------------------------------------------------
 * T0 owns this file plus `Sidebar.tsx` and `Toolbar.tsx`. US-002…US-006 each own
 * ONE leaf under `components/` and touch nothing else; US-007 is the only later
 * story allowed back in here. That is what lets five worktrees run in parallel
 * without a merge conflict on the shell.
 *
 * WHAT THE ARTBOARD SAYS
 * ----------------------
 * RJ-0 is 1512×1030 in two pieces: a 48px window title bar (RK-0) above a
 * 1512×982 app body (4I-0). The body is a 273px sidebar beside a main column of
 * toolbar → content well, and the well (4N-0) is the one lifted surface — one
 * step up in tone (#262626 against #1B1B1B) with a 24px top-LEFT corner only, so
 * it reads as a page tucked under the toolbar and against the sidebar. Getting
 * that single asymmetric corner right is most of what makes the shell look like
 * the design.
 *
 * WHY THERE IS NO TITLE BAR HERE
 * ------------------------------
 * RK-0 draws macOS traffic lights. Conan's Tauri window is NOT undecorated
 * (`src-tauri/tauri.conf.json` sets no `decorations: false`), so the real window
 * already has a native title bar — painting a second, non-functional one below it
 * would be a lie in the UI. RK-0 is read as the artboard's mock of that native
 * chrome and deliberately not rendered. Its one piece of genuine app UI, the
 * sidebar-collapse toggle, is a later task; the `--conan-color-titlebar` and
 * `--conan-control-*` tokens are already in `tokens.css` for the day we do go
 * undecorated.
 *
 * ASTRYX HOUSE RULES that apply here (from `ui/.claude/CLAUDE.md`):
 *   - no raw <div>: Layout / LayoutPanel / VStack / HStack do the structure
 *   - one `Layout` per shell, never nested
 *   - no Tailwind classes, no raw hex, no raw px — anything the props can't
 *     express goes through `xstyle` reading `tokens.css` (contract §4.2/§4.3)
 */
import * as stylex from "@stylexjs/stylex";
import { Layout } from "@astryxdesign/core/Layout";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import Sidebar from "./Sidebar.tsx";
import Toolbar from "./Toolbar.tsx";
import SecondaryBar from "./components/SecondaryBar.tsx";

/**
 * `xstyle` is Astryx's per-component style escape hatch, and the reason this app
 * compiles StyleX (see the plugin in `vite.config.ts`). Astryx's own components
 * ship pre-compiled, but `stylex.create` in APP code throws at runtime unless a
 * build-time compiler rewrites it — verified in T0:
 *
 *   node -e "stylex.create({a:{color:'red'}})"
 *   → "Unexpected 'stylex.create' call at runtime. Styles must be compiled…"
 *
 * Every value below is a `tokens.css` variable, never a literal (contract §4.2).
 */
const styles = stylex.create({
  shell: {
    backgroundColor: "var(--conan-color-bg)",
  },
  // 4N-0 — the lifted content well. ONE rounded corner: top-left. The other
  // three meet the window edge, so rounding them would open gaps.
  well: {
    backgroundColor: "var(--conan-color-content)",
    borderStartStartRadius: "var(--conan-radius-page)",
    flexGrow: 1,
    minHeight: 0,
    overflow: "clip",
  },
  // The transcript + composer region. Empty for the shell milestone; a later
  // phase fills it. `minHeight: 0` keeps it a scroll container, not a pusher.
  content: {
    flexGrow: 1,
    minHeight: 0,
  },
});

/**
 * Placeholder for the transcript + composer (Paper 4N-0's body), which land in a
 * later phase. Kept visibly provisional rather than faked: an empty well is an
 * honest statement that the shell is done and the content is not.
 */
function ContentPlaceholder() {
  return (
    <VStack
      gap={2}
      padding={6}
      align="start"
      isScrollable
      xstyle={styles.content}
      data-slot="content"
    >
      <Text type="supporting" color="secondary">
        Transcript and composer land in a later phase.
      </Text>
    </VStack>
  );
}

export default function AppV2() {
  return (
    <Layout
      height="fill"
      padding={0}
      start={<Sidebar />}
      xstyle={styles.shell}
      content={
        <VStack height="100%" gap={0} data-slot="main">
          <Toolbar />
          <VStack gap={0} xstyle={styles.well}>
            <SecondaryBar />
            <ContentPlaceholder />
          </VStack>
        </VStack>
      }
    />
  );
}
