/**
 * AddProjectDialog — the v2 shell's add-project recovery path (WHA-74).
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * The sidebar's "Add project" control has been a dead `<button>` since T0:
 * nothing in `ui/src/v2` ever wired it. A v2 user whose project list is empty
 * — a fresh DB, or the last project removed via the new kebab — had no way
 * back. This is the minimum that closes that trap.
 *
 * DELIBERATELY NOT v1's PICKER. `ui/src/components/ProjectPicker.tsx` is a
 * 288-line cmdk command palette with a sources view and localStorage recents.
 * That richer surface is WHA-60's (the v2 add/remove/sort/group counterpart
 * WHA-74 names as related); rebuilding it here would be the ticket quietly
 * growing a feature. This browses the SAME gateway route v1's picker does
 * (`GET /api/fs/list`) and does one thing: descend, go up, use this folder.
 *
 * The listing is single-level by design — /api/fs/list is not recursive, so
 * each navigation is one request and the dialog never holds a tree.
 */
import { useCallback, useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import {
  Layout,
  LayoutContent,
  LayoutFooter,
} from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ChevronUp, Folder } from "lucide-react";
import { apiBase } from "../../lib/gateway.ts";

/** Structural copy of the gateway's /api/fs/list payload (the dirs half). */
interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
}

interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  error?: string;
}

export interface AddProjectDialogProps {
  isOpen: boolean;
  token: string | null;
  /** Where browsing starts — the gateway's own cwd. */
  start: string;
  onOpenChange: (isOpen: boolean) => void;
  /** Resolves once the project row exists; the shell then refreshes. */
  onAdd: (path: string) => Promise<unknown>;
}

const ICON = 16;

const styles = stylex.create({
  // The listing is the only scrolling region; a fixed height stops the dialog
  // from resizing as you walk between a sparse folder and a dense one.
  list: {
    height: 260,
    overflowY: "auto",
  },
  row: {
    appearance: "none",
    backgroundColor: "transparent",
    borderRadius: "var(--conan-radius-md)",
    borderStyle: "none",
    color: "var(--conan-icon-dim)",
    cursor: "pointer",
    display: "flex",
    paddingBlock: "var(--conan-space-2)",
    paddingInline: "var(--conan-space-3)",
    textAlign: "start",
    width: "100%",
    ":hover": {
      backgroundColor: "var(--conan-wash-raised)",
    },
    ":focus-visible": {
      backgroundColor: "var(--conan-wash-raised)",
    },
  },
  // The current path can be long; it wraps rather than widening the dialog.
  path: {
    overflowWrap: "anywhere",
  },
  // Astryx's `TextColor` union has no error member, so the tone rides the
  // wrapper and the Text inherits — the same trick `ProjectTree`'s section
  // label uses for its one off-palette colour.
  errorText: {
    color: "var(--conan-color-error)",
  },
});

export default function AddProjectDialog({
  isOpen,
  token,
  start,
  onOpenChange,
  onAdd,
}: AddProjectDialogProps) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [cwd, setCwd] = useState(start);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const browse = useCallback(
    async (target: string) => {
      if (!token) return;
      try {
        const response = await fetch(
          apiBase() + `/api/fs/list?path=${encodeURIComponent(target)}`,
          { headers: { "x-conan-token": token } },
        );
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as FsListing;
        setListing(data);
        setCwd(data.path);
        // The gateway reports an unreadable directory in-band rather than
        // failing the request — surface it instead of showing an empty folder.
        setError(data.error ?? null);
      } catch {
        setError("Couldn't read that folder.");
      }
    },
    [token],
  );

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setListing(null);
    void browse(start);
  }, [browse, isOpen, start]);

  const close = () => {
    if (!busy) onOpenChange(false);
  };

  const use = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(cwd);
      onOpenChange(false);
    } catch {
      setError("Couldn't add that folder as a project. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const dirs = (listing?.entries ?? []).filter((entry) => entry.isDir);

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      purpose="form"
      width={480}
    >
      <Layout
        height="auto"
        header={
          <DialogHeader
            title="Add project"
            subtitle="Pick the folder Conan should treat as a project."
            onOpenChange={() => close()}
          />
        }
        content={
          <LayoutContent isScrollable={false}>
            <VStack gap={2} data-slot="add-project-browser">
              <Text type="supporting" color="secondary" xstyle={styles.path}>
                {cwd}
              </Text>
              {listing?.parent ? (
                <button
                  type="button"
                  aria-label="Go to parent folder"
                  onClick={() => void browse(listing.parent as string)}
                  disabled={busy}
                  {...stylex.props(styles.row)}
                >
                  <HStack align="center" gap={2}>
                    <ChevronUp size={ICON} aria-hidden />
                    <Text color="secondary">..</Text>
                  </HStack>
                </button>
              ) : null}
              <VStack gap={1} xstyle={styles.list}>
                {dirs.length === 0 ? (
                  <Text type="supporting" color="secondary">
                    No folders here.
                  </Text>
                ) : (
                  dirs.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => void browse(entry.path)}
                      disabled={busy}
                      data-slot="add-project-folder"
                      {...stylex.props(styles.row)}
                    >
                      <HStack align="center" gap={2}>
                        <Folder size={ICON} aria-hidden />
                        <Text color="secondary">{entry.name}</Text>
                      </HStack>
                    </button>
                  ))
                )}
              </VStack>
              {error ? (
                <HStack xstyle={styles.errorText} role="alert">
                  <Text type="supporting" color="inherit">
                    {error}
                  </Text>
                </HStack>
              ) : null}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end" align="center">
              <Button
                label="Cancel"
                variant="ghost"
                onClick={close}
                isDisabled={busy}
              />
              <Button
                label="Use this folder"
                variant="primary"
                onClick={() => void use()}
                isDisabled={busy}
                isLoading={busy}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
