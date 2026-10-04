# Changelog

## [Unreleased]

## [1.0.0-lystar.2] - 2026-10-02

## [1.0.0-lystar.1] - 2026-10-01

### Added

- 合并 Pi 1.0.0 的持久化 agent harness、异步 SQLite 存储、扩展与会话级 Agent、任务图和工具注册接口。

### Changed

- 旧实验性 harness 的 LYStar 编辑匹配规则迁移到 `pi-durable`，保留显式缩进、Unicode 字素边界、批量冲突诊断和未修改文本的原始字节，并继续拒绝无内容变化的编辑。

## [1.0.0] - 2026-10-01

### Added

- Initial release of `@earendil-works/pi-durable`, a durable agent harness. See the [README](README.md) and the [design document](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md).
