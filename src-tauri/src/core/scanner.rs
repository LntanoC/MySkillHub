use anyhow::Result;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::content_hash;
use super::skill_metadata;
use super::skill_store::DiscoveredSkillRecord;
use super::tool_adapters;

pub struct ScanPlan {
    pub tools_scanned: usize,
    pub skills_found: usize,
    pub discovered: Vec<DiscoveredSkillRecord>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredGroup {
    pub name: String,
    pub fingerprint: Option<String>,
    pub locations: Vec<DiscoveredLocation>,
    pub imported: bool,
    pub found_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredLocation {
    pub id: String,
    pub tool: String,
    pub found_path: String,
    pub git_candidate: Option<GitCandidate>,
    pub plugin: Option<String>,
    pub description: Option<String>,
}

/// Claude's installation registry is evidence of ownership, not proof that a
/// plugin is enabled in the current session. Only existing user-scope paths
/// are considered; never infer ownership from a name or a marketplace clone.
fn claude_plugins_from_registry(registry: &Path) -> Vec<(String, PathBuf)> {
    let Ok(meta) = std::fs::metadata(registry) else { return vec![]; };
    if meta.len() > 4 * 1024 * 1024 { return vec![]; }
    let Ok(bytes) = std::fs::read(registry) else { return vec![]; };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return vec![]; };
    let Some(plugins) = value.get("plugins").and_then(|v| v.as_object()) else { return vec![]; };
    let mut result = Vec::new();
    for (name, entries) in plugins {
        let Some(entries) = entries.as_array() else { continue; };
        for entry in entries {
            if entry.get("scope").and_then(|v| v.as_str()) != Some("user") { continue; }
            let Some(path) = entry.get("installPath").and_then(|v| v.as_str()) else { continue; };
            if !Path::new(path).is_absolute() { continue; }
            if let Ok(path) = std::fs::canonicalize(path) {
                if path.is_dir() { result.push((name.clone(), path)); }
            }
        }
    }
    result
}

pub fn claude_plugin_roots() -> Vec<(String, PathBuf)> {
    let config = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|p| p.join(".claude")));
    config.map(|p| claude_plugins_from_registry(&p.join("plugins/installed_plugins.json"))).unwrap_or_default()
}

pub fn plugin_owner(path: &Path, roots: &[(String, PathBuf)]) -> Option<String> {
    let actual = std::fs::canonicalize(path).ok()?;
    roots.iter().find(|(_, root)| actual.starts_with(root)).map(|(name, _)| name.clone())
}

/// A repository containing a skill is only a lead, not proof of origin.
#[derive(Debug, Clone, Serialize)]
pub struct GitCandidate {
    pub url: String,
    pub branch: Option<String>,
    pub subpath: String,
}

fn git_candidate(path: &Path) -> Option<GitCandidate> {
    let repo = git2::Repository::discover(path).ok()?;
    let root = std::fs::canonicalize(repo.workdir()?).ok()?;
    let skill = std::fs::canonicalize(path).ok()?;
    let subpath = skill.strip_prefix(&root).ok()?.to_string_lossy().replace('\\', "/");
    let origin = repo.find_remote("origin").ok()?;
    // Only show safe HTTP(S) URLs; never expose embedded credentials or query tokens.
    let mut url = reqwest::Url::parse(origin.url()?).ok()?;
    if !matches!(url.scheme(), "http" | "https") { return None; }
    url.set_username("").ok()?;
    url.set_password(None).ok()?;
    url.set_query(None);
    url.set_fragment(None);
    let branch = repo.head().ok().and_then(|head| head.shorthand().map(str::to_string));
    Some(GitCandidate { url: url.to_string(), branch, subpath })
}

/// Directories to skip during recursive scans (internal/tool-specific metadata).
const RECURSIVE_SCAN_SKIP_DIRS: &[&str] = &[".hub", ".git", "node_modules"];

fn is_symlink_to_central(path: &Path) -> bool {
    if let Ok(target) = std::fs::read_link(path) {
        let central = super::central_repo::skills_dir();
        return target.starts_with(&central);
    }
    false
}

/// Recursively walk `dir` and return all subdirectories that contain SKILL.md.
/// Stops descending when a skill dir is found (skills don't nest). Skips
/// `.git` / `node_modules` / `.hub` and guards against symlink cycles.
pub fn collect_skill_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut results = Vec::new();
    let mut visited = HashSet::new();
    collect_skill_dirs_recursive(dir, &mut visited, &mut results);
    results
}

fn collect_skill_dirs_recursive(
    dir: &Path,
    visited: &mut HashSet<PathBuf>,
    results: &mut Vec<PathBuf>,
) {
    let canonical = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if !visited.insert(canonical) {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() && !path.is_symlink() {
            continue;
        }
        let dir_name = entry.file_name();
        let dir_name_str = dir_name.to_string_lossy();
        if RECURSIVE_SCAN_SKIP_DIRS.iter().any(|s| dir_name_str == *s) {
            continue;
        }
        if is_symlink_to_central(&path) {
            continue;
        }
        if skill_metadata::is_valid_skill_dir(&path) {
            results.push(path);
            continue;
        }
        collect_skill_dirs_recursive(&path, visited, results);
    }
}

/// Build a `DiscoveredSkillRecord` for `path` and push it onto `discovered`,
/// unless `path` is already tracked in `managed_paths` or already recorded.
/// Several agents read the same directory (e.g. `~/.agents/skills`), so the
/// first agent that finds a skill keeps it and the rest skip it.
fn push_discovered(
    adapter_key: &str,
    path: PathBuf,
    managed_paths: &[String],
    discovered: &mut Vec<DiscoveredSkillRecord>,
) {
    let path_str = path.to_string_lossy().to_string();
    if managed_paths.contains(&path_str) || discovered.iter().any(|d| d.found_path == path_str) {
        return;
    }
    let name = skill_metadata::infer_skill_name(&path);
    let fingerprint = content_hash::hash_directory(&path).ok();
    let found_at = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    discovered.push(DiscoveredSkillRecord {
        id: uuid::Uuid::new_v4().to_string(),
        tool: adapter_key.to_string(),
        found_path: path_str,
        name_guess: Some(name),
        fingerprint,
        found_at,
        imported_skill_id: None,
    });
}

fn scan_flat_dir(
    adapter_key: &str,
    scan_dir: &Path,
    managed_paths: &[String],
    discovered: &mut Vec<DiscoveredSkillRecord>,
) {
    let entries = match std::fs::read_dir(scan_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() && !path.is_symlink() {
            continue;
        }
        if is_symlink_to_central(&path) || !skill_metadata::is_valid_skill_dir(&path) {
            continue;
        }
        push_discovered(adapter_key, path, managed_paths, discovered);
    }
}

fn scan_recursive_dir(
    adapter_key: &str,
    scan_dir: &Path,
    managed_paths: &[String],
    discovered: &mut Vec<DiscoveredSkillRecord>,
) {
    let mut skill_dirs = Vec::new();
    let mut visited = HashSet::new();
    collect_skill_dirs_recursive(scan_dir, &mut visited, &mut skill_dirs);
    for path in skill_dirs {
        push_discovered(adapter_key, path, managed_paths, discovered);
    }
}

#[allow(dead_code)]
pub fn scan_local_skills(managed_paths: &[String]) -> Result<ScanPlan> {
    scan_local_skills_with_adapters(managed_paths, &tool_adapters::default_tool_adapters())
}

pub fn scan_local_skills_with_adapters(
    managed_paths: &[String],
    adapters: &[tool_adapters::ToolAdapter],
) -> Result<ScanPlan> {
    let mut discovered = Vec::new();
    let mut tools_scanned = 0;

    for adapter in adapters {
        let installed = adapter.is_installed();
        let additional_dirs = adapter.additional_existing_scan_dirs();

        // Discover via additional_scan_dirs even when the legacy detect dir is
        // missing — handles tools whose skills land in a shared location
        // (e.g. copilot → ~/.agents/skills) on machines without the legacy
        // vendor dir.
        if !installed && additional_dirs.is_empty() {
            continue;
        }

        tools_scanned += 1;

        if installed {
            let primary_scan_dir = adapter.skills_dir();
            if primary_scan_dir.exists() {
                if adapter.recursive_scan {
                    scan_recursive_dir(
                        &adapter.key,
                        &primary_scan_dir,
                        managed_paths,
                        &mut discovered,
                    );
                } else {
                    scan_flat_dir(
                        &adapter.key,
                        &primary_scan_dir,
                        managed_paths,
                        &mut discovered,
                    );
                }
            }
        }

        // Additional scan dirs are already resolved to concrete skills roots.
        for scan_dir in additional_dirs {
            scan_flat_dir(&adapter.key, &scan_dir, managed_paths, &mut discovered);
        }
    }

    // Installed plugin skills are listed for visibility only, not adopted.
    if adapters.iter().any(|adapter| adapter.key == "claude_code") {
        for (_, root) in claude_plugin_roots() {
            let skills = root.join("skills");
            if skills.is_dir() {
                for path in collect_skill_dirs(&skills) {
                    if std::fs::canonicalize(&path).is_ok_and(|actual| actual.starts_with(&root)) {
                        push_discovered("claude_code", path, managed_paths, &mut discovered);
                    }
                }
            }
        }
    }

    let skills_found = discovered.len();
    Ok(ScanPlan {
        tools_scanned,
        skills_found,
        discovered,
    })
}

pub fn group_discovered(records: &[DiscoveredSkillRecord]) -> Vec<DiscoveredGroup> {
    use std::collections::HashMap;
    let mut groups: HashMap<String, DiscoveredGroup> = HashMap::new();

    let plugin_roots = claude_plugin_roots();
    for rec in records {
        let name = rec.name_guess.clone().unwrap_or_else(|| "unknown".into());
        // Separate physical installations even when their bytes match: a
        // plugin and a user-managed copy can have different owners/updates.
        let group_key = format!("path:{}:{}", rec.tool, rec.found_path);
        let entry = groups.entry(group_key).or_insert_with(|| DiscoveredGroup {
            name,
            fingerprint: rec.fingerprint.clone(),
            locations: Vec::new(),
            imported: false,
            found_at: rec.found_at,
        });

        if rec.imported_skill_id.is_some() {
            entry.imported = true;
        }

        // Use the earliest found_at
        if rec.found_at < entry.found_at {
            entry.found_at = rec.found_at;
        }

        entry.locations.push(DiscoveredLocation {
            id: rec.id.clone(),
            tool: rec.tool.clone(),
            found_path: rec.found_path.clone(),
            git_candidate: git_candidate(Path::new(&rec.found_path)),
            plugin: plugin_owner(Path::new(&rec.found_path), &plugin_roots),
            description: super::skill_metadata::parse_skill_md(Path::new(&rec.found_path)).description,
        });
    }

    let mut result: Vec<_> = groups.into_values().collect();
    result.sort_by(|a, b| a.name.cmp(&b.name));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write_skill(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("SKILL.md"), "---\nname: x\n---\n# x").unwrap();
    }

    #[test]
    fn git_candidate_redacts_credentials_and_is_only_a_candidate() {
        let tmp = tempdir().unwrap();
        let repo = git2::Repository::init(tmp.path()).unwrap();
        repo.remote("origin", "https://user:secret@example.com/owner/repo.git?token=private#fragment").unwrap();
        let skill = tmp.path().join("skills/demo");
        write_skill(&skill);
        let candidate = git_candidate(&skill).unwrap();
        assert_eq!(candidate.url, "https://example.com/owner/repo.git");
        assert_eq!(candidate.subpath, "skills/demo");
        assert!(candidate.branch.is_none());
    }

    #[test]
    fn no_origin_has_no_candidate() {
        let tmp = tempdir().unwrap();
        git2::Repository::init(tmp.path()).unwrap();
        let skill = tmp.path().join("demo");
        write_skill(&skill);
        assert!(git_candidate(&skill).is_none());
    }

    #[test]
    fn plugin_ownership_requires_an_existing_user_scope_registry_path() {
        let tmp = tempdir().unwrap();
        let plugin = tmp.path().join("plugin");
        let skill = plugin.join("skills/example");
        write_skill(&skill);
        let registry = tmp.path().join("installed_plugins.json");
        let value = serde_json::json!({"plugins": {
            "demo@market": [{"scope": "user", "installPath": plugin.to_string_lossy()}],
            "project@market": [{"scope": "project", "installPath": tmp.path().to_string_lossy()}]
        }});
        fs::write(&registry, value.to_string()).unwrap();
        let roots = claude_plugins_from_registry(&registry);
        assert_eq!(plugin_owner(&skill, &roots).as_deref(), Some("demo@market"));
        let independent = tmp.path().join("independent");
        write_skill(&independent);
        assert_eq!(plugin_owner(&independent, &roots), None);
    }

    #[test]
    fn malformed_or_missing_plugin_registry_does_not_guess_ownership() {
        let tmp = tempdir().unwrap();
        let registry = tmp.path().join("installed_plugins.json");
        assert!(claude_plugins_from_registry(&registry).is_empty());
        fs::write(&registry, b"not-json").unwrap();
        assert!(claude_plugins_from_registry(&registry).is_empty());
        fs::write(&registry, r#"{"plugins":{"relative@market":[{"scope":"user","installPath":"relative/path"}]}}"#).unwrap();
        assert!(claude_plugins_from_registry(&registry).is_empty());
    }

    fn run(root: &Path) -> Vec<PathBuf> {
        let mut results = Vec::new();
        let mut visited = HashSet::new();
        collect_skill_dirs_recursive(root, &mut visited, &mut results);
        results.sort();
        results
    }

    #[test]
    fn recursive_finds_nested_skills() {
        let tmp = tempdir().unwrap();
        write_skill(&tmp.path().join("devops/deploy-k8s"));
        write_skill(&tmp.path().join("software-development/super-dev"));

        let results = run(tmp.path());
        assert_eq!(results.len(), 2);
        let names: Vec<_> = results
            .iter()
            .filter_map(|p| p.file_name().and_then(|n| n.to_str()))
            .collect();
        assert!(names.contains(&"deploy-k8s"));
        assert!(names.contains(&"super-dev"));
    }

    #[test]
    fn recursive_stops_descending_into_skill_dir() {
        // A skill dir's own subdirectories must not be reported as separate skills,
        // even if they happen to contain their own SKILL.md.
        let tmp = tempdir().unwrap();
        write_skill(&tmp.path().join("my-skill"));
        write_skill(&tmp.path().join("my-skill/nested"));

        let results = run(tmp.path());
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].file_name().unwrap(), "my-skill");
    }

    #[test]
    fn recursive_skips_internal_dirs() {
        let tmp = tempdir().unwrap();
        write_skill(&tmp.path().join(".git/bogus"));
        write_skill(&tmp.path().join("node_modules/pkg"));
        write_skill(&tmp.path().join(".hub/hidden"));
        write_skill(&tmp.path().join("real-category/real-skill"));

        let results = run(tmp.path());
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].file_name().unwrap(), "real-skill");
    }

    #[test]
    fn recursive_finds_deeply_nested_skill() {
        let tmp = tempdir().unwrap();
        let mut deep = tmp.path().to_path_buf();
        for _ in 0..16 {
            deep = deep.join("lvl");
        }
        write_skill(&deep);

        let results = run(tmp.path());
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].file_name().unwrap(), "lvl");
    }

    #[cfg(unix)]
    #[test]
    fn recursive_survives_symlink_cycle() {
        use std::os::unix::fs::symlink;

        let tmp = tempdir().unwrap();
        write_skill(&tmp.path().join("category/real-skill"));
        // Self-referential loop: `category/loop -> category`
        symlink(
            tmp.path().join("category"),
            tmp.path().join("category/loop"),
        )
        .unwrap();

        let results = run(tmp.path());
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].file_name().unwrap(), "real-skill");
    }

    #[test]
    fn flat_scan_requires_skill_marker() {
        let tmp = tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("not-a-skill")).unwrap();
        write_skill(&tmp.path().join("real-skill"));

        let adapter = tool_adapters::ToolAdapter {
            key: "test".into(),
            display_name: "Test".into(),
            relative_skills_dir: String::new(),
            relative_detect_dir: String::new(),
            additional_scan_dirs: vec![],
            override_skills_dir: Some(tmp.path().to_string_lossy().to_string()),
            is_custom: true,
            recursive_scan: false,
            project_relative_skills_dir: None,
            category: Default::default(),
        };

        let plan = scan_local_skills_with_adapters(&[], &[adapter]).unwrap();
        assert_eq!(plan.skills_found, 1);
        assert_eq!(
            plan.discovered[0].found_path,
            tmp.path().join("real-skill").to_string_lossy()
        );
    }

    #[test]
    fn additional_scan_dirs_scan_concrete_skills_roots() {
        let tmp = tempdir().unwrap();
        let primary = tmp.path().join("skills");
        let plugin_skills = tmp.path().join("plugins").join("vendor").join("skills");
        fs::create_dir_all(&primary).unwrap();
        write_skill(&plugin_skills.join("packaged-skill"));

        let adapter = tool_adapters::ToolAdapter {
            key: "test".into(),
            display_name: "Test".into(),
            relative_skills_dir: String::new(),
            relative_detect_dir: String::new(),
            additional_scan_dirs: vec![],
            override_skills_dir: Some(primary.to_string_lossy().to_string()),
            is_custom: true,
            recursive_scan: false,
            project_relative_skills_dir: None,
            category: Default::default(),
        };

        let adapter_with_extra = tool_adapters::ToolAdapter {
            additional_scan_dirs: vec![plugin_skills.to_string_lossy().to_string()],
            ..adapter
        };

        let plan = scan_local_skills_with_adapters(&[], &[adapter_with_extra]).unwrap();
        assert_eq!(plan.skills_found, 1);
        assert_eq!(
            plan.discovered[0].found_path,
            plugin_skills.join("packaged-skill").to_string_lossy()
        );
    }

    #[test]
    fn a_directory_shared_by_several_agents_is_listed_once() {
        // #641: Codex, GitHub Copilot, Pi and others all read
        // `~/.agents/skills`; one skill there was listed once per agent.
        let tmp = tempdir().unwrap();
        let shared = tmp.path().join("shared");
        write_skill(&shared.join("foo"));

        let adapter = |key: &str| tool_adapters::ToolAdapter {
            key: key.into(),
            display_name: key.into(),
            relative_skills_dir: String::new(),
            relative_detect_dir: String::new(),
            additional_scan_dirs: vec![],
            override_skills_dir: Some(shared.to_string_lossy().to_string()),
            is_custom: true,
            recursive_scan: false,
            project_relative_skills_dir: None,
            category: Default::default(),
        };
        // The third agent reaches the directory through an additional scan
        // dir, the way GitHub Copilot does.
        let elsewhere = tmp.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let via_extra_dir = tool_adapters::ToolAdapter {
            override_skills_dir: Some(elsewhere.to_string_lossy().to_string()),
            additional_scan_dirs: vec![shared.to_string_lossy().to_string()],
            ..adapter("c")
        };

        let plan =
            scan_local_skills_with_adapters(&[], &[adapter("a"), adapter("b"), via_extra_dir])
                .unwrap();
        assert_eq!(plan.tools_scanned, 3);
        assert_eq!(plan.skills_found, 1);
        assert_eq!(plan.discovered.len(), 1);
        assert_eq!(plan.discovered[0].tool, "a");

        let groups = group_discovered(&plan.discovered);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].locations.len(), 1);
    }

    #[test]
    fn grouping_keeps_same_name_different_fingerprint_separate() {
        let records = vec![
            DiscoveredSkillRecord {
                id: "1".into(),
                tool: "a".into(),
                found_path: "/tmp/one".into(),
                name_guess: Some("shared".into()),
                fingerprint: Some("hash-a".into()),
                found_at: 10,
                imported_skill_id: None,
            },
            DiscoveredSkillRecord {
                id: "2".into(),
                tool: "b".into(),
                found_path: "/tmp/two".into(),
                name_guess: Some("shared".into()),
                fingerprint: Some("hash-b".into()),
                found_at: 20,
                imported_skill_id: None,
            },
        ];

        let groups = group_discovered(&records);
        assert_eq!(groups.len(), 2);
    }

    #[test]
    fn grouping_keeps_equal_content_at_different_locations_separate() {
        let records = vec![
            DiscoveredSkillRecord {
                id: "1".into(),
                tool: "a".into(),
                found_path: "/tmp/one".into(),
                name_guess: Some("shared".into()),
                fingerprint: Some("hash-a".into()),
                found_at: 10,
                imported_skill_id: None,
            },
            DiscoveredSkillRecord {
                id: "2".into(),
                tool: "b".into(),
                found_path: "/tmp/two".into(),
                name_guess: Some("shared".into()),
                fingerprint: Some("hash-a".into()),
                found_at: 20,
                imported_skill_id: None,
            },
        ];

        let groups = group_discovered(&records);
        assert_eq!(groups.len(), 2);
        assert!(groups.iter().all(|group| group.locations.len() == 1));
    }
}
