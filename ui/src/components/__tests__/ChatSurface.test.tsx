import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChatSurface from "../ChatSurface.tsx";

vi.mock("../ChatPane.tsx", async () => {
  const React = await import("react");
  return {
    default: ({ onState, resume }: {
      onState: (state: Record<string, unknown>) => void;
      resume: { sessionId: string } | null;
    }) => {
      React.useEffect(() => {
        onState({
          status: "open",
          busy: false,
          awaitingApproval: false,
          title: "Ship the confirmation",
          sessionId: resume?.sessionId ?? null,
          provider: "claude",
        });
      }, [onState, resume?.sessionId]);
      return <div>Chat pane</div>;
    },
  };
});

vi.mock("../../hooks/useProviders.ts", () => ({
  useProviders: () => [],
}));

vi.mock("../../hooks/useThemes.ts", () => ({
  useThemes: () => ({
    activeTheme: { type: "light" },
    setActiveTheme: vi.fn(),
  }),
}));

const THREAD = {
  sessionId: "session-1",
  cwd: "/repo/conan",
  model: "opus",
  provider: "claude",
  effort: null,
  title: "Ship the confirmation",
  lastMessage: "Add a safe close flow",
  createdAt: 1,
  lastActivity: 2,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatSurface close-thread confirmation", () => {
  it("keeps the active chat until the destructive action is confirmed", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          projects: [{
            id: "project-1",
            path: "/repo/conan",
            name: "conan",
            createdAt: 1,
            threads: [THREAD],
          }],
        }),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatSurface
        token="token"
        defaultCwd="/repo/conan"
        lastSkillFired={null}
      />,
    );

    await screen.findByText("Chat pane");
    fireEvent(window, new CustomEvent("conan:close-chat"));

    expect(
      screen.getByRole("heading", { name: "Close “Ship the confirmation”?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Chat pane")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/agent/threads/session-1"),
      expect.objectContaining({ method: "DELETE" }),
    );

    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("heading", { name: /Close/ })).not.toBeInTheDocument();
    expect(screen.getByText("Chat pane")).toBeInTheDocument();

    fireEvent(window, new CustomEvent("conan:close-chat"));
    fireEvent.click(screen.getByRole("button", { name: "Close chat" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/agent/threads/session-1"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });
    expect(screen.queryByText("Chat pane")).not.toBeInTheDocument();
    expect(screen.getByText("No open chats.")).toBeInTheDocument();
  });
});
