# MySkillHub

MySkillHub 是一个开发中的跨 Agent 技能管理项目，以 Skills Manager 源码为起点，并保留原作者的 MIT 版权声明。目标是让使用者能够识别技能的来源、保留个人修改、合并上游变更，并在审阅后将版本分发给不同 Agent。

## 当前状态

本项目处于早期开发阶段，尚未发布可安装版本。应用身份、默认数据路径和原项目的更新源已做初步隔离，但桌面程序尚未构建验证；个性化合并工作流目前是独立的 CLI 原型，还没有接入桌面界面。请不要用此代码覆盖安装现有 Skills Manager。

- [开发状态和后续工作](MY_SKILL_HUB.md)
- [技能维护 CLI 原型](tools/maintenance/README.md)
- [原项目说明](README.upstream.md)
- [MIT 许可证](LICENSE)

## 开发验证

需要 Node.js 22、npm、Rust 和 Tauri 所需的系统依赖。

```shell
npm ci
npm test
npm run build
python -m unittest discover -s tools/maintenance -p "test_*.py"
```

该仓库不包含用户的技能文件、凭据或本机配置。原项目地址：[xingkongliang/skills-manager](https://github.com/xingkongliang/skills-manager)。
