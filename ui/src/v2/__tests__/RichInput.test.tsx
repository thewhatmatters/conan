import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatComposer } from "@astryxdesign/core/Chat";
import RichInput, { insertLineBreak } from "../chat/composer/RichInput.tsx";

function Harness({
  onFiles = vi.fn(),
  onSubmit = vi.fn(),
}: {
  onFiles?: (files: File[]) => void;
  onSubmit?: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <ChatComposer
      value={value}
      onChange={setValue}
      onSubmit={(next) => {
        onSubmit(next);
        setValue("");
      }}
      input={<RichInput token="token" cwd="/repo" onFiles={onFiles} />}
    />
  );
}

function typeAtCaret(input: HTMLElement, text: string) {
  const node = document.createTextNode(text);
  input.appendChild(node);
  const range = document.createRange();
  range.setStart(node, text.length);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.input(input);
}

// WHA-211. These cover the MANUAL path only: jsdom has no `execCommand`, so
// the branch that ships in a browser cannot run here. The shipped path is
// checked by reading the outgoing socket frame in a real engine — the DOM
// shape and the wire string are recorded in the commit message.
describe("insertLineBreak (fallback path)", () => {
  function fieldWithCaretAfter(text: string): HTMLElement {
    const field = document.createElement("div");
    field.setAttribute("contenteditable", "true");
    document.body.appendChild(field);
    const node = document.createTextNode(text);
    field.appendChild(node);
    const range = document.createRange();
    range.setStart(node, text.length);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return field;
  }

  it("breaks the line with a <br>, never a block element", () => {
    const field = fieldWithCaretAfter("| a | b |");
    expect(insertLineBreak()).toBe(true);
    // A <div> here is the bug: Astryx's serializer maps <br> to a newline and
    // walks straight through blocks, so a block break never reaches the agent.
    expect(field.querySelector("div")).toBeNull();
    expect(field.querySelectorAll("br").length).toBeGreaterThan(0);
    field.remove();
  });

  it("pads a trailing break so the caret can reach the new line", () => {
    const field = fieldWithCaretAfter("first");
    insertLineBreak();
    // A single trailing <br> is not rendered by any engine; without the pad
    // the user presses Shift+Enter and the caret does not move.
    expect(field.querySelectorAll("br").length).toBe(2);
    field.remove();
  });

  it("does not pad a break in the middle of a line", () => {
    const field = document.createElement("div");
    field.setAttribute("contenteditable", "true");
    document.body.appendChild(field);
    const head = document.createTextNode("head");
    const tail = document.createTextNode("tail");
    field.append(head, tail);
    const range = document.createRange();
    range.setStart(head, 4);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    insertLineBreak();
    expect(field.querySelectorAll("br").length).toBe(1);
    expect(field.textContent).toBe("headtail");
    field.remove();
  });

  it("reports failure when there is no caret to break at", () => {
    window.getSelection()!.removeAllRanges();
    expect(insertLineBreak()).toBe(false);
  });
});

describe("RichInput file intake", () => {
  it("routes pasted files to attachment staging", () => {
    const onFiles = vi.fn();
    render(<Harness onFiles={onFiles} />);
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    fireEvent.paste(screen.getByLabelText("Message input"), {
      clipboardData: { files: [file], items: [], getData: () => "" },
    });
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it("routes dropped files and prevents browser navigation", () => {
    const onFiles = vi.fn();
    render(<Harness onFiles={onFiles} />);
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [file], types: ["Files"] },
    });
    screen.getByLabelText("Message input").dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenCalledWith([file]);
  });
});

describe("RichInput built-ins", () => {
  it("uses the default result row and serializes a selected @ token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ hits: [{ rel: "src/app.ts", name: "app.ts" }] }),
        ),
      ),
    );
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const input = screen.getByLabelText("Message input");
    input.focus();

    typeAtCaret(input, "read @app");
    const option = await screen.findByRole("option", { name: "src/app.ts" });
    expect(option.querySelector("span")?.textContent).toBe("src/app.ts");
    fireEvent.mouseDown(option);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("read @src/app.ts");
  });

  it("recalls submitted history with ArrowUp and clears it with ArrowDown", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Message input");
    input.focus();
    typeAtCaret(input, "first prompt");
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.textContent).toBe("first prompt");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.textContent).toBe("");
  });
});
