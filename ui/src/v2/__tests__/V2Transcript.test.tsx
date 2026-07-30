/**
 * V2Transcript — text-only streaming rows (US-202).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import V2Transcript from "../chat/V2Transcript.tsx";
import type { ChatItem } from "../lib/useV2Chat.ts";

const user: ChatItem = { id: "u1", role: "user", text: "Hello agent" };
const assistant: ChatItem = {
  id: "a1",
  role: "assistant",
  text: "Hello human",
};
const tool: ChatItem = {
  id: "t1",
  role: "tool",
  name: "Read",
  input: {},
  result: null,
  isError: false,
};

describe("V2Transcript", () => {
  it("renders user and assistant text via ChatMessageList", () => {
    const { container } = render(
      <V2Transcript items={[user, assistant]} />,
    );

    expect(container.querySelector('[data-slot="v2-transcript"]')).not.toBeNull();
    expect(screen.getByText("Hello agent")).toBeInTheDocument();
    expect(screen.getByText("Hello human")).toBeInTheDocument();
  });

  it("renders tool items as a one-line placeholder, not a rich card", () => {
    render(<V2Transcript items={[user, tool]} />);

    expect(screen.getByText("ran a tool · Read")).toBeInTheDocument();
    expect(screen.queryByText(/tool card/i)).not.toBeInTheDocument();
  });

  it("shows Working… while busy with no assistant text yet", () => {
    render(<V2Transcript items={[user]} busy />);

    expect(screen.getByText("Working…")).toBeInTheDocument();
  });

  it("hides Working… once assistant text is present", () => {
    render(<V2Transcript items={[user, assistant]} busy />);

    expect(screen.queryByText("Working…")).not.toBeInTheDocument();
  });
});
