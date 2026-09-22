# Codex Router 本地定制版

这是 [duolahypercho/codex-router](https://github.com/duolahypercho/codex-router) 的本地定制源码快照，用于在 Codex 与多个模型服务之间转换请求、工具调用、响应事件与模型目录。保留上游仓库的结构、MIT 许可证与 `NOTICE.md`，不是重新宣称上游实现为自有项目。

## 此副本包含的定制

- DeepSeek 模型目录与工具路由兼容调整。
- Codex 应用工具适配与相关测试。
- 缓存使用量、推理摘要、Responses 兼容处理。
- Xiaomi MiMo 模型目录与协议适配，以及 OpenCode Go 配置预设。

本地源以基准提交 `b90aa60e257bbcc33855aad7d43954c1a09b1311` 为起点，包含公开时未提交的定制代码。详细命令与上游功能说明见 `README.upstream.md`；部分上游安装命令会下载上游最新版，并不会安装本仓库的定制内容。

## 项目结构

- `src/`：路由、协议兼容、模型目录和应用工具。
- `config/`：不含密钥的 provider/model 预设。
- `bin/`、`scripts/`：命令行入口和维护工具。
- `apps/`：控制中心与 macOS 界面源码。
- `test/`：路由、协议与 provider 的自动化测试。

## 本地开发

需要 Node.js 22.19 或更高版本。

```sh
npm ci
npm run check
./bin/model-router --help
```

完整测试入口是 `npm test`；单个文件可用 `node --test test/xiaomi-mimo.test.mjs`。安装服务、改写 Codex 配置或注册 provider 前，先查看本版本 `--help` 和上游文档。macOS 托盘界面还需要相应 Xcode/Swift 环境。

三份可选 live/probe 脚本的鉴权值通过 `CODEX_ROUTER_TEST_AUTHORIZATION` 提供；仓库不内置实际服务鉴权值。

凭据应通过项目已有的本机 credential 命令录入，不放入仓库、命令示例或 URL。公开源不含 `generated/`、个人模型启用状态、登录信息、API Key、服务日志、虚拟环境或安装应用；测试里的合成凭据只是固定测试夹具。

本副本用于复现和继续维护这些兼容修改，不保证所有外部服务、官方客户端版本或所有 provider 已实机验证。依赖与上游 API 变化后仍需要相应检查。
