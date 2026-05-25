import fs from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT } from "../paths.js";

const PRD_PATH = path.join(PACKAGE_ROOT, "prd.json");
const PROGRESS_PATH = path.join(PACKAGE_ROOT, "progress.txt");

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
    raw = fs.readFileSync(PRD_PATH, "utf8");
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
      .readFileSync(PROGRESS_PATH, "utf8")
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
 * build loop updates them. Watches the repo dir so atomic replaces are caught.
 */
export function watchTasks(onChange: (state: TasksState) => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => onChange(readTasks()), 200);
  };
  const watcher = fs.watch(PACKAGE_ROOT, (_event, filename) => {
    if (filename === "prd.json" || filename === "progress.txt") fire();
  });
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
