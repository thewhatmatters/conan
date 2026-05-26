import fs from "node:fs";
import path from "node:path";
import { getActiveCwd, onCwdChange } from "../cwd/index.js";

// The Tasks reader follows the app-wide active cwd (US-019): when the toolbar
// directory picker switches projects, prd.json/progress.txt resolve under the
// new directory. Resolved per-read so a cwd change takes effect immediately.
const prdPath = () => path.join(getActiveCwd(), "prd.json");
const progressPath = () => path.join(getActiveCwd(), "progress.txt");

export interface TaskStory {
  id: string;
  title: string;
  priority: number;
  passes: boolean;
}

export interface TasksState {
  exists: boolean;
  project: string;
  branchName: string;
  total: number;
  done: number;
  currentId: string | null;
  stories: TaskStory[];
  activity: string[];
}

const EMPTY: TasksState = {
  exists: false,
  project: "",
  branchName: "",
  total: 0,
  done: 0,
  currentId: null,
  stories: [],
  activity: [],
};

/**
 * Read the current build-loop progress from prd.json (the passes source of
 * truth) plus progress.txt (the runner's timestamped activity trail). The
 * "current" story is the lowest-priority one still failing — exactly the target
 * run-tasks.sh picks next.
 */
export function readTasks(): TasksState {
  let raw: string;
  try {
    raw = fs.readFileSync(prdPath(), "utf8");
  } catch {
    return EMPTY;
  }

  let prd: {
    project?: string;
    branchName?: string;
    userStories?: Array<{
      id?: string;
      title?: string;
      priority?: number;
      passes?: boolean;
    }>;
  };
  try {
    prd = JSON.parse(raw);
  } catch {
    return EMPTY; // mid-write; a later watch event will deliver valid JSON
  }

  const stories: TaskStory[] = (prd.userStories ?? [])
    .map((s) => ({
      id: s.id ?? "?",
      title: s.title ?? "",
      priority: s.priority ?? 0,
      passes: Boolean(s.passes),
    }))
    .sort((a, b) => a.priority - b.priority);

  const done = stories.filter((s) => s.passes).length;
  const current = stories.find((s) => !s.passes) ?? null;

  return {
    exists: true,
    project: prd.project ?? "",
    branchName: prd.branchName ?? "",
    total: stories.length,
    done,
    currentId: current?.id ?? null,
    stories,
    activity: readActivity(),
  };
}

/** Last few non-header lines of progress.txt (newest last). */
function readActivity(limit = 8): string[] {
  try {
    return fs
      .readFileSync(progressPath(), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("# run:"))
      .slice(-limit);
  } catch {
    return [];
  }
}

/**
 * Watch prd.json + progress.txt and invoke `onChange` (debounced) whenever the
 * build loop updates them. Watches the active cwd so atomic replaces are caught,
 * and re-targets the watcher (then fires once) when the active cwd changes
 * (US-019) so the Tasks tab re-scopes to the newly-selected project.
 */
export function watchTasks(onChange: (state: TasksState) => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => onChange(readTasks()), 200);
  };
  const startWatch = () => {
    if (watcher) watcher.close();
    try {
      watcher = fs.watch(getActiveCwd(), (_event, filename) => {
        if (filename === "prd.json" || filename === "progress.txt") fire();
      });
    } catch {
      watcher = null; // directory vanished — a later cwd change can re-arm it
    }
  };
  startWatch();
  const unsub = onCwdChange(() => {
    startWatch();
    fire(); // push the new project's tasks even if no file event follows
  });
  return () => {
    if (timer) clearTimeout(timer);
    if (watcher) watcher.close();
    unsub();
  };
}
