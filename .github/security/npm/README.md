# 构建用 npm 的依赖锁

此目录只用于 Docker 构建。它不进入应用运行镜像，也不改变前端应用的锁文件。

`package.json` 来自官方 `npm@12.2.0` 发行包。保留 CLI 元数据、运行依赖和许可证。
本项目删除 `bundleDependencies`、工作区、开发依赖、测试脚本和测试元数据。
本项目增加五个 `overrides`，固定扫描后核对的修复版本。
CLI 源代码没有修改。原始 Artistic-2.0 许可证保存在 `LICENSE`。

npm 发行包自带的依赖不会自动采用外层项目的 `overrides`。
Dockerfile 先安装官方 npm，然后在 npm 的目录内运行 `npm ci --ignore-scripts`。
该命令用此锁文件替换原有依赖。每个下载包都有完整性校验值。
不要删除有漏洞的包来伪造扫描结果。不要添加漏洞忽略记录。

## 更新

必要条件：Node.js 满足本目录 `engines` 的要求。扫描工具和漏洞数据库可用。

1. 核对官方 npm 发行包和安全公告。
2. 更新此目录的依赖版本。
3. 生成锁文件。

```sh
npm install --prefix .github/security/npm --package-lock-only --ignore-scripts
npm audit --prefix .github/security/npm --audit-level=low
```

4. 构建 `webzoom:frontend` 和 `webzoom:local`。
5. 扫描实际镜像。
6. 执行前端、浏览器、工作流和非 root 容器测试。

完整范围和剩余风险见 `docs/SECURITY.md`。
