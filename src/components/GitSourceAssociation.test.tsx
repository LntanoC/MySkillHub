// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitSourceAssociation } from "./GitSourceAssociation";
import { associateGitSource } from "../lib/tauri";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../lib/tauri", () => ({ associateGitSource: vi.fn() }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(associateGitSource).mockReset();
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

async function render() { await act(async () => { root.render(<GitSourceAssociation skillId="s1" />); }); }
function setInput(index: number, value: string) {
  const input = container.querySelectorAll("input")[index];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(button).toBeDefined();
  await act(async () => { button!.click(); });
}
const result = (changed: boolean) => ({ skill_id: "s1", clone_url: "https://example.com/a/b", subpath: null, branch: null, revision: "abc123", content_changed: changed, dry_run: true });

describe("Git source association", () => {
  it("never offers confirmation when the source differs", async () => {
    vi.mocked(associateGitSource).mockResolvedValue(result(true));
    await render(); setInput(0, "https://example.com/a/b");
    await click("mySkills.associate.preview");
    expect(container.textContent).toContain("mySkills.associate.different");
    expect(container.textContent).not.toContain("mySkills.associate.confirm");
  });
  it("pins the reviewed revision on confirmation", async () => {
    vi.mocked(associateGitSource).mockResolvedValue(result(false));
    await render(); setInput(0, "https://example.com/a/b");
    await click("mySkills.associate.preview");
    await click("mySkills.associate.confirm");
    expect(associateGitSource).toHaveBeenLastCalledWith("s1", "https://example.com/a/b", "", null, "abc123");
  });
  it("invalidates a preview when an input changes", async () => {
    vi.mocked(associateGitSource).mockResolvedValue(result(false));
    await render(); setInput(0, "https://example.com/a/b");
    await click("mySkills.associate.preview");
    setInput(1, "other");
    expect(container.textContent).not.toContain("mySkills.associate.confirm");
  });
});
