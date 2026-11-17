# 本地技能维护实验工具

这是 MySkillHub 的开发中 CLI 原型，帮助维护本地定制和合并 Git 上游；目前尚未集成桌面界面，也不是对所有用户的一键迁移工具。需要 Python 3.9+、Git 和兼容的 Skills Manager CLI。

默认从 `~/.myskillhub/maintenance/config.json` 读取配置；也可通过 `MYSKILLHUB_MAINTENANCE_HOME` 指定隔离目录。配置必须由已知来源、已经验证过本地内容及部署位置的迁移流程生成；不要仅因技能名称相同就猜测上游。当前版本没有自动注册或生成配置的命令。

可用命令：`status <skill|all>`、`check <skill|all>`、`merge <skill>`、`publish <skill> --reviewed-commit <完整SHA>`。`check` 仅获取和报告上游；`merge` 仅合并至维护仓库；`publish` 默认预览，额外指定 `--apply` 才会修改已发布目录和管理器部署。

发布前工具要求维护分支干净，已审阅 SHA 等于 HEAD，已发布目录、中央库和所有目标与上次发布一致。发布前保存本地副本和配置；中途失败时报告恢复目录，需要人工检查后恢复。不要对不可信的配置或未审阅的技能执行发布。Git 冲突应人工解决或通过 `git merge --abort` 放弃。

此原型来源于该项目创建前为用户本机建立的流程，已移除个人硬编码路径。尚不支持插件来源检测、可视化冲突处理、自动迁移或跨平台安装包。
