# MySkillHub 开发说明

MySkillHub 以 [Skills Manager](https://github.com/xingkongliang/skills-manager) 的源码为初始版本，保留原作者版权和 MIT 许可证，不继承其 Git 提交历史。目标是在现有技能安装和分发能力之上，支持确认来源、维护本地定制、检查并合并上游更新，以及审阅后发布到指定 Agent。

## 当前状态

目前是开发中的源码与独立维护 CLI 原型，**还不是可以安全安装的 MySkillHub 桌面版本**。应用标识、中央库默认路径及上游更新源已改动，但尚未经过桌面构建和运行验证，不应覆盖安装现有应用。维护 CLI 说明见 `tools/maintenance/README.md`。

后续需要：验证并完成应用数据隔离、品牌和更新通道；可视化扫描和归属识别；安全接管现有技能；完整的三方合并与冲突审阅界面；跨平台打包与升级验证。

## 仓库和许可证

`origin` 是 MySkillHub 项目仓库。原作者版权和 MIT 许可见 `LICENSE`。由于本项目不继承原提交历史，未来参考原项目的新功能时需要比较并有选择地移植，不能直接依赖共同的 Git 祖先合并。不应把原项目发布包当作 MySkillHub 更新安装。
