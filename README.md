# WebZoom

WebZoom 是内网屏幕共享服务。浏览器只连接 HTTPS 和 WSS。
服务不使用 WebRTC、TURN、STUN、UDP 或独立的客户端 TCP 协议。

**当前状态：首版核心功能和本机自动化验证已完成。生产容量验收尚未完成。**
不要把本机测试结果视为“1000 名听众持续 30 分钟”的承诺。
完整结果和剩余验收项见 `docs/VERIFICATION.md`。

## 已实现

- Keycloak 兼容的 OIDC 登录。所有参与者都必须登录。
- 任意已登录用户创建会议，复制链接，并邀请同事。
- 固定主持人。主持人可以转交共享权、收回共享权和结束会议。
- 每场会议只有一名共享者。新共享者必须主动选择屏幕。
- WebCodecs VP8 编码和解码。服务仅转发压缩画面。
- 显示器、窗口或标签页共享。不采集音频、麦克风或摄像头。
- 自动重连、关键帧恢复、有界队列和可见的画质降级。
- Go 单实例服务、React/TypeScript 前端、Docker 和 OpenShift 配置。
- 所有前端资源均在镜像内。运行时不使用公网 CDN。

## 重要边界

1. 第一版面向桌面 Chrome 和 Edge。启动时检查 VP8 和屏幕帧读取能力。目标浏览器仍需实机验收。
2. 每个身份在同一会议只能打开一个连接。不同会议可以复用身份。
3. 会议状态和登录会话只在内存中。重启后需要重新登录和创建会议。
4. 会议最多持续 8 小时。空会议在 30 分钟后清理。
5. 会话在 ID token、access token 和 8 小时上限中，取最早的到期时间。
6. 当前不刷新令牌。短令牌有效期会提前中断长会议。到期后需要重新登录。
7. “退出”只退出本应用。当前未接入 Keycloak backchannel logout。
8. Keycloak 端撤销登录不会立即推送给本服务。最迟在本地令牌期限到达时失效。
9. 共享权限不是保密分组。任何已登录、持有链接的用户都可以加入。
10. 监听端口 8080 仅供内部代理。不能将其发布给终端用户。

HTTPS/WSS 本身使用 TCP/TLS。本项目限制的是应用协议，不是禁止 TLS 的底层 TCP。
代理到容器可以使用内部 HTTP。DNS 和服务器到 Keycloak 的流量由集群策略控制。

## 快速开始：Docker

必要条件：Docker Compose、内网域名、浏览器信任的证书，以及可用的 Keycloak 客户端。
不要使用测试身份服务处理真实会议。

1. 按 `docs/DEPLOYMENT.md` 配置 Keycloak。
2. 将 `.env.example` 复制为 `.env`。
3. 修改域名、证书路径和 Secret 文件路径。
4. 创建两个 Secret 文件。一个保存 OIDC 客户端密钥。另一个保存随机监控令牌。
5. 确保容器 UID 65532 能读取 Secret 文件。确保代理 UID 101 能读取证书和私钥。
6. 执行下列命令。

```sh
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build
```

7. 通过 `.env` 中的 `PUBLIC_URL` 打开应用。
8. 登录公司账号。
9. 点击“创建会议”。
10. 点击“共享屏幕”，并选择共享内容。
11. 复制会议链接并发送给同事。

只有代理发布宿主机 443 端口。不要为 app 服务增加 `ports`。
Keycloak 使用私有 CA 时，使用 `compose.ca.yaml`。具体步骤见部署说明。

## OpenShift

清单在 `deploy/openshift/`。
先替换域名、镜像地址和 Secret，再应用清单。
该 Deployment 固定为一个副本，并使用 Recreate 更新策略。
不要增加副本，不要启用 HPA。升级会中断现有会议。

## 开发与验证

必要条件：Go 1.26.8、Node.js 22、npm，以及桌面 Chromium 测试环境。
依赖安装需要网络或组织内部的软件镜像源。

```sh
go test -race ./...
go vet ./...
cd web
npm ci
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

浏览器测试使用真实 VP8 编解码，但用动画 Canvas 替代操作系统屏幕选择器。
测试 OIDC 服务仅通过 `testtools` 构建标签启用。它不会进入生产镜像。
不要直接运行 Vite HTTP 开发服务来验收屏幕采集。

```sh
# 从仓库根目录执行。先构建镜像，再运行临时容器测试。
docker build -t webzoom:local .
go test -tags deploymenttests -v ./internal/deploy

# 可选：10 秒、1000 名模拟听众、本机 TLS/WSS 转发试验。
WEBZOOM_LOAD_SMOKE=1 go test -run TestCapacitySmoke -v ./internal/loadgen

# 容量测试客户端。
go build -o bin/loadtest ./cmd/loadtest
```

代码修改采用 TDD：先观察失败测试，再实现，再执行回归测试，然后提交。

## 文档

- `docs/DEPLOYMENT.md`：Keycloak、证书、Docker、OpenShift 和监控。
- `docs/PROTOCOL.md`：接口、状态机和媒体封包。
- `docs/CAPACITY.md`：负载工具和生产容量验收。
- `docs/VERIFICATION.md`：已执行测试、结果和未验证项目。
- `THIRD_PARTY_NOTICES.md`：依赖、许可证和检查边界。
