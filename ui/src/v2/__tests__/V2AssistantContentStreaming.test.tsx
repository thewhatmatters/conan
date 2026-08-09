import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const markdownProps = vi.hoisted(() => vi.fn());

vi.mock("@astryxdesign/core/Markdown", () => ({
  Markdown: ({ children, isStreaming }: { children: ReactNode; isStreaming?: boolean }) => {
    markdownProps({ isStreaming });
    return <div data-testid="markdown-prose">{children}</div>;
  },
}));

import V2AssistantContent from "../chat/V2AssistantContent.tsx";

describe("V2AssistantContent streaming wiring", () => {
  it("defaults prose Markdown to settled rendering", () => {
    render(<V2AssistantContent text="Settled reply" />);

    expect(screen.getByTestId("markdown-prose")).toHaveTextContent("Settled reply");
    expect(markdownProps).toHaveBeenLastCalledWith({ isStreaming: false });
  });

  it("passes streaming through to prose Markdown", () => {
    render(<V2AssistantContent text="Live reply" isStreaming />);

    expect(markdownProps).toHaveBeenLastCalledWith({ isStreaming: true });
  });
});
