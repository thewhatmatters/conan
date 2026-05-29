// VS Code–style tabs: flat, the active tab marked by a top accent border (not a
// filled pill) — shared by the HUD tab bar (Hud.tsx) and the Settings dialog
// (SettingsView.tsx) so the two stay in sync. border-t border-transparent
// reserves the space so nothing shifts when a tab activates.
export const TAB_TRIGGER =
  "shrink-0 rounded-none border-t border-transparent px-3 py-1.5 text-xs font-normal text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-muted data-[state=active]:border-primary data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none";

// The flush, contiguous tab list that hosts TAB_TRIGGER triggers — no gap/padding
// so the triggers read as real tabs sitting on a border-b strip.
export const TAB_LIST =
  "h-auto min-w-0 flex-nowrap justify-start overflow-x-auto rounded-none bg-transparent p-0";
