import type { DiscoveredGroup, ProjectSkill, ToolInfo } from "../lib/tauri";
import { IS_WINDOWS } from "../lib/platform";

export type MapSkill = { name: string; path: string; description: string | null; plugin: string | null; enabled: boolean | null };
export type MapAgent = { tool: ToolInfo; skills: MapSkill[]; failed: boolean };

/** Keep the original agent order for equal counts. */
export function sortAgentsBySkillCount(agents: MapAgent[]): MapAgent[] {
  return [...agents].sort((a, b) => b.skills.length - a.skills.length);
}

function pathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return IS_WINDOWS ? normalized.toLowerCase() : normalized;
}

/** Paths, rather than names or hashes, identify separate installations. */
export function combineAgentSkills(tool: ToolInfo, local: ProjectSkill[], groups: DiscoveredGroup[]): MapSkill[] {
  const items = new Map<string, MapSkill>();
  for (const skill of local) items.set(pathKey(skill.path), {
    name: skill.name, path: skill.path, description: skill.description, plugin: null, enabled: skill.enabled,
  });
  for (const group of groups) for (const location of group.locations) {
    if (location.tool !== tool.key) continue;
    const key = pathKey(location.found_path);
    const previous = items.get(key);
    if (previous) {
      if (location.plugin) previous.plugin = location.plugin;
      if (!previous.description && location.description) previous.description = location.description;
    } else {
      items.set(key, { name: group.name, path: location.found_path, description: location.description ?? null, plugin: location.plugin, enabled: null });
    }
  }
  return [...items.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

