import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { File, Folder, RotateCcw } from "lucide-react";
import TerminalEngine from "../../components/Terminal.tsx";
import { apiBase } from "../../lib/gateway.ts";
import { parseUnifiedPatch } from "../../lib/diff.ts";
import V2DiffView from "./V2DiffView.tsx";

const styles = stylex.create({
  body: {
    backgroundColor: "var(--conan-color-content)",
    color: "var(--conan-text-primary)",
    height: "100%",
    minHeight: 0,
    minWidth: 0,
    overflow: "auto",
    width: "100%",
  },
  padded: { padding: "var(--conan-space-4)" },
  fill: { flexGrow: 1, minHeight: 0, minWidth: 0, width: "100%" },
  terminal: {
    backgroundColor: "var(--conan-color-terminal)",
    padding: "var(--conan-space-2)",
  },
  frame: {
    backgroundColor: "var(--conan-color-bg)",
    border: 0,
    height: "100%",
    width: "100%",
  },
  row: {
    borderRadius: "var(--conan-radius-md)",
    justifyContent: "flex-start",
    width: "100%",
  },
  preview: {
    backgroundColor: "var(--conan-color-bg)",
    borderRadius: "var(--conan-radius-md)",
    fontFamily: "var(--conan-font-mono)",
    overflow: "auto",
    padding: "var(--conan-space-3)",
    whiteSpace: "pre-wrap",
  },
});

function CenterState({ children }: { children: string }) {
  return (
    <VStack align="center" justify="center" gap={2} xstyle={[styles.body, styles.padded]}>
      <Text color="secondary">{children}</Text>
    </VStack>
  );
}

export function V2TerminalSurface({ token, cwd }: { token: string | null; cwd: string | null }) {
  const [tid, setTid] = useState(() => crypto.randomUUID());
  const [exited, setExited] = useState(false);
  const killOnUnmount = useRef(true);
  if (!token) return <CenterState>Connecting to the shell…</CenterState>;
  if (exited) {
    return (
      <VStack align="center" justify="center" gap={3} xstyle={[styles.body, styles.padded]}>
        <Text weight="semibold">Shell exited</Text>
        <Text color="secondary">Restart to open a fresh shell in this workspace.</Text>
        <Button
          label="Restart shell"
          icon={<RotateCcw size={16} aria-hidden />}
          variant="secondary"
          clickAction={() => {
            setTid(crypto.randomUUID());
            setExited(false);
          }}
        />
      </VStack>
    );
  }
  return (
    <VStack xstyle={[styles.body, styles.terminal]}>
      <TerminalEngine
        key={tid}
        token={token}
        theme="dark"
        tid={tid}
        mode="shell"
        cwd={cwd ?? undefined}
        closeOnUnmount={killOnUnmount}
        onExit={() => setExited(true)}
      />
    </VStack>
  );
}

export function V2BrowserSurface() {
  const [draft, setDraft] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const open = useCallback(() => {
    const value = draft.trim();
    if (!value) return;
    setUrl(/^https?:\/\//i.test(value) ? value : `http://${value}`);
  }, [draft]);
  return (
    <VStack gap={3} xstyle={[styles.body, styles.padded]}>
      <HStack gap={2} align="end">
        <TextInput
          label="URL"
          isLabelHidden
          value={draft}
          placeholder="localhost:5173 or https://…"
          onChange={setDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") open();
          }}
          width="100%"
        />
        <Button label="Open" variant="secondary" clickAction={open} />
      </HStack>
      {url ? (
        <VStack xstyle={styles.fill}>
          <iframe src={url} title="Browser surface" {...stylex.props(styles.frame)} />
        </VStack>
      ) : (
        <CenterState>Enter a URL to preview it inside Conan.</CenterState>
      )}
    </VStack>
  );
}

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}
interface FileListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
  error?: string;
}

export function V2FilesSurface({ token, cwd }: { token: string | null; cwd: string | null }) {
  const [path, setPath] = useState(cwd);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  useEffect(() => setPath(cwd), [cwd]);
  useEffect(() => {
    if (!token || !path) return;
    let cancelled = false;
    fetch(apiBase() + `/api/fs/list?path=${encodeURIComponent(path)}`, {
      headers: { "x-conan-token": token },
    })
      .then((response) => response.json())
      .then((data: FileListing) => {
        if (!cancelled) setListing(data);
      })
      .catch(() => {
        if (!cancelled) setListing({ path, parent: null, entries: [], error: "Could not read folder." });
      });
    return () => {
      cancelled = true;
    };
  }, [path, token]);
  const openFile = useCallback(
    async (entry: FileEntry) => {
      if (!token) return;
      const response = await fetch(
        apiBase() + `/api/fs/read?path=${encodeURIComponent(entry.path)}`,
        { headers: { "x-conan-token": token } },
      );
      const data = (await response.json()) as { content?: string };
      setPreview({ path: entry.path, content: data.content ?? "This file cannot be previewed." });
    },
    [token],
  );
  if (!token || !path) return <CenterState>Select a thread to browse its files.</CenterState>;
  if (!listing) return <CenterState>Loading files…</CenterState>;
  return (
    <VStack gap={3} xstyle={[styles.body, styles.padded]}>
      <HStack gap={2} align="center">
        {listing.parent ? (
          <Button label="Parent folder" variant="ghost" size="sm" clickAction={() => setPath(listing.parent)} />
        ) : null}
        <Text color="secondary">{preview?.path ?? listing.path}</Text>
      </HStack>
      {preview ? (
        <VStack gap={2} xstyle={styles.fill}>
          <Button label="Back to files" variant="ghost" size="sm" clickAction={() => setPreview(null)} />
          <Text xstyle={styles.preview}>{preview.content}</Text>
        </VStack>
      ) : listing.error ? (
        <CenterState>{listing.error}</CenterState>
      ) : (
        <VStack gap={1}>
          {listing.entries.map((entry) => (
            <Button
              key={entry.path}
              label={entry.name}
              icon={entry.isDir ? <Folder size={16} aria-hidden /> : <File size={16} aria-hidden />}
              variant="ghost"
              size="sm"
              xstyle={styles.row}
              clickAction={() => (entry.isDir ? setPath(entry.path) : void openFile(entry))}
            />
          ))}
        </VStack>
      )}
    </VStack>
  );
}

interface DiffFile {
  path: string;
  patch: string;
}

export function V2DiffSurface({ token, cwd }: { token: string | null; cwd: string | null }) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!token || !cwd) return;
    let cancelled = false;
    fetch(apiBase() + "/api/fs/diff", {
      method: "POST",
      headers: { "content-type": "application/json", "x-conan-token": token },
      body: JSON.stringify({ cwd }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load changes.");
        return response.json() as Promise<{ repo: boolean; files: DiffFile[] }>;
      })
      .then((data) => {
        if (!cancelled) setFiles(data.files);
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, token]);
  const parsed = useMemo(
    () => files?.map((file) => ({ ...file, diff: parseUnifiedPatch(file.path, file.patch) })),
    [files],
  );
  if (!token || !cwd) return <CenterState>Select a thread to review changes.</CenterState>;
  if (error) return <CenterState>{error}</CenterState>;
  if (!parsed) {
    return (
      <VStack align="center" justify="center" xstyle={styles.body}>
        <Spinner label="Loading changes" />
      </VStack>
    );
  }
  if (parsed.length === 0) return <CenterState>No uncommitted changes.</CenterState>;
  return (
    <VStack gap={3} xstyle={[styles.body, styles.padded]}>
      {parsed.map((file) => (
        <VStack key={file.path} gap={2}>
          <Text weight="semibold">{file.path}</Text>
          <V2DiffView diff={file.diff} />
        </VStack>
      ))}
    </VStack>
  );
}
