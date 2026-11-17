// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SkillMapTranslation } from "./SkillMapTranslation";
import { translateSkillDescription } from "../lib/tauri";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../lib/tauri", () => ({ translateSkillDescription: vi.fn() }));

it("translates only distinct English descriptions after an explicit click", async () => {
  vi.mocked(translateSkillDescription).mockResolvedValue("翻译内容");
  const onTranslated = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<SkillMapTranslation descriptions={["Review code", "Review code", "这是中文介绍"]} translations={{}} onTranslated={onTranslated} />); });
  expect(translateSkillDescription).not.toHaveBeenCalled();
  await act(async () => { container.querySelector("button")!.click(); });
  expect(translateSkillDescription).toHaveBeenCalledTimes(1);
  expect(translateSkillDescription).toHaveBeenCalledWith("https://api.deepseek.com/chat/completions", "deepseek-flash", "", "Review code");
  expect(onTranslated).toHaveBeenCalledWith("Review code", "翻译内容");
  act(() => root.unmount());
  container.remove();
});
