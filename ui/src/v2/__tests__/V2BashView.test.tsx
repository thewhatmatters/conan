import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import V2BashView, { bashCommand } from "../components/V2BashView.tsx";

describe("V2BashView", () => {
  it("renders shell semantics and copies the exact command bytes", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const command = "printf '  alpha  \\n'\necho \"$PATH\"\n";
    const { container } = render(<V2BashView command={command} />);

    expect(screen.getByRole("group", { name: "bash" })).toBeInTheDocument();
    expect(container.querySelector('[data-slot="v2-bash-code-block"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /copy code/i }));
    expect(writeText).toHaveBeenCalledWith(command);
  });

  it("offers the Astryx disclosure for a tall shell script", () => {
    const command = Array.from({ length: 13 }, (_, index) => `echo ${index}`).join("\n");
    render(<V2BashView command={command} />);

    const disclosure = screen.getByRole("button", { name: /bash/i });
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
  });

  it("extracts only a non-empty string command", () => {
    expect(bashCommand({ command: "npm test" })).toBe("npm test");
    expect(bashCommand({ command: "" })).toBeNull();
    expect(bashCommand({ command: ["npm", "test"] })).toBeNull();
    expect(bashCommand("npm test")).toBeNull();
  });
});
