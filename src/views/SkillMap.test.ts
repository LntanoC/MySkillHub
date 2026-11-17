// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { combineAgentSkills, sortAgentsBySkillCount, type MapAgent } from "./skillMapData";
import type { DiscoveredGroup, ProjectSkill, ToolInfo } from "../lib/tauri";

describe("skill map discovery", () => {
  it("sorts agents by total discovered skill locations and keeps ties stable", () => {
    const agent = (key: string, count: number) => ({ tool: { key }, skills: Array(count).fill({}), failed: false }) as MapAgent;
    const input = [agent("small", 1), agent("first", 3), agent("second", 3), agent("empty", 0)];
    expect(sortAgentsBySkillCount(input).map((item) => item.tool.key)).toEqual(["first", "second", "small", "empty"]);
    expect(input[0].tool.key).toBe("small");
  });

  it("merges the same path while preserving distinct installations and other agents", () => {
    const tool = { key: "claude" } as ToolInfo;
    const local = [{ name: "review", path: "/skills/review", description: "Local", enabled: true }] as ProjectSkill[];
    const groups = [{ name: "review", locations: [
      { tool: "claude", found_path: "/skills/review/", plugin: "marketplace", id: "1", git_candidate: null },
      { tool: "claude", found_path: "/other/review", plugin: null, id: "2", git_candidate: null },
      { tool: "codex", found_path: "/codex/review", plugin: null, id: "3", git_candidate: null },
    ] }] as DiscoveredGroup[];
    const result = combineAgentSkills(tool, local, groups);
    expect(result).toHaveLength(2);
    expect(result.find((skill) => skill.path === "/skills/review")).toMatchObject({ plugin: "marketplace", description: "Local", enabled: true });
    expect(result.find((skill) => skill.path === "/other/review")).toMatchObject({ plugin: null, enabled: null });
  });
});
