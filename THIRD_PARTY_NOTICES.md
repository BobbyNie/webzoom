# 第三方组件

核对日期：2026-10-08。版本以 `go.mod`、`go.sum` 和 `web/package-lock.json` 为准。
本项目代码采用 MIT 许可证。第三方组件保留各自的许可证。

## 运行时组件

| 组件 | 版本 | 许可证 |
|---|---|---|
| Go 标准库及运行时 | 1.26.9 | BSD-3-Clause |
| github.com/coder/websocket | 1.8.15 | ISC |
| github.com/coreos/go-oidc/v3 | 3.21.0 | Apache-2.0 |
| github.com/go-jose/go-jose/v4 | 4.1.4 | Apache-2.0 |
| golang.org/x/oauth2 | 0.37.0 | BSD-3-Clause |
| React / React DOM | 19.3.0 | MIT |
| scheduler | 0.28.0 | MIT |

原始许可证保存在 `licenses/`，并随应用镜像交付。
Go 模块图还包含 `cloud.google.com/go/compute/metadata v0.3.0`。
它不在 `cmd/webzoom` 的编译依赖中。

## 构建与测试组件

- Vite 8.3.4：MIT。
- Vitest 5.0.3：MIT。
- TypeScript 5.9.3：Apache-2.0。
- Playwright 1.64.0：Apache-2.0。
- 类型定义包：MIT。精确版本在锁文件中。
- Go 漏洞检查工具：`golang.org/x/vuln/cmd/govulncheck@v1.8.0`。
- 构建镜像与 Nginx 代理镜像均固定到 manifest digest。
- 构建镜像不随应用运行时镜像交付。
- Nginx 是独立镜像。使用者须保留该镜像提供的许可证。
- CA 证书包保留 Debian 包的 copyright 文件。

已读取直接运行时组件的许可证，并核对安装包元数据。
本次 npm 漏洞检查报告为 0 项。Go 检查结果见验证报告。
这些检查不能证明代码没有漏洞，也不能保证未来维护状态。
离线发布前应重新扫描镜像，并由组织完成许可证合规审查。
