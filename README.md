# WebZoom

WebZoom 是内网屏幕共享服务。浏览器只连接 HTTPS 和 WSS。
服务不使用 WebRTC、TURN、STUN、UDP 或独立的客户端 TCP 协议。

**当前状态：首版核心功能和本机自动化验证已完成。生产容量验收尚未完成。**
不要把本机测试结果视为“1000 名听众持续 30 分钟”的承诺。
完整结果和剩余验收项见 `docs/VERIFICATION.md`。

## 已实现

- Keycloak 兼容的 OIDC 登录。所有参与者都必须登录。
- 任意已登录用户创建会议，复制链接，并邀请同事。
- 首页列出“我创建的会议”。主持人可直接进入、复制链接或结束会议。
- 默认不限制会议数量或听众人数。页面不显示会议数量或登录人数统计。
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
4. 会议最多持续 8 小时。空会议在 30 分钟后清理。停止共享或离开页面不会结束会议。
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

听众点击画面右下角的“全屏观看”，进入浏览器全屏。
全屏时隐藏会议侧栏，并按原始比例放大画面。比例不同时会保留黑边，不裁切画面。
点击右下角的“退出全屏”，或按 Esc，恢复会议页面。

只有代理发布宿主机 443 端口。不要为 app 服务增加 `ports`。
Keycloak 使用私有 CA 时，使用 `compose.ca.yaml`。具体步骤见部署说明。

## 生产环境 OIDC 配置

OIDC 是 OpenID Connect 身份认证协议。本机 Demo 使用独立测试 Realm，不是公司的 SSO。
生产环境必须使用公司的 Keycloak 和正式客户端密钥。不要复用测试账号或测试密钥。

1. 在公司的 Keycloak Realm 中创建 OpenID Connect 客户端。
2. 开启 Client authentication 和 Standard Flow。
3. 关闭 Implicit Flow、Direct Access Grants 和 Service Accounts。
4. 将 PKCE 方法设为 `S256`。
5. 设置精确回调地址：`https://webzoom.example.intranet/auth/callback`。
6. 将以下示例域名和 Realm 名称替换为生产值。
7. 将客户端密钥保存到 Secret 文件，不要写入 Git。

```dotenv
PUBLIC_URL=https://webzoom.example.intranet
OIDC_ISSUER=https://keycloak.example.intranet/realms/company
OIDC_CLIENT_ID=webzoom
OIDC_CLIENT_SECRET_FILE=./.secrets/oidc_client_secret
```

| 配置 | 要求 |
|---|---|
| `PUBLIC_URL` | 用户访问的 HTTPS origin；不能包含路径。使用非默认端口时必须包含端口。 |
| `OIDC_ISSUER` | Keycloak Realm 的 issuer URL；不是登录页面 URL，也不是回调地址。 |
| `OIDC_CLIENT_ID` | 与 Keycloak 中的客户端 ID 完全相同。 |
| `OIDC_CLIENT_SECRET_FILE` | Docker 宿主机上的 Secret 文件路径；Compose 将其挂载到容器。 |
| `OIDC_CLIENT_SECRET` | OpenShift Secret 可注入此变量；不能与 `_FILE` 同时设置。 |

回调地址必须与 `PUBLIC_URL` 加 `/auth/callback` 完全相同。不要使用通配回调地址。
浏览器和后端都必须能访问 issuer，并信任其证书链。私有 CA 配置见部署说明。
默认 Compose 和 OpenShift 清单只启用一个应用副本。不要增加副本。
本版不刷新令牌。登录到期后会中断媒体连接，用户必须重新登录。
“退出”只删除本应用会话，不结束 Keycloak SSO 会话。
详细配置、证书和 Secret 权限见 [部署说明](docs/DEPLOYMENT.md)。

## 容量限制与压力测试

日常部署默认不启用会议数量或听众人数限制。`5 × 200` 是压力测试目标，不是业务上限。
没有固定上限不代表容量无限。内存、带宽和网关仍需要监控，并按实际负载配置。
服务器继续执行会议过期清理、会话认证、媒体速率保护和有界队列。
页面不显示会议数量或登录人数统计。监控接口仍可供授权的维护人员使用。

`LOAD_TEST_MAX_ROOMS` 和 `LOAD_TEST_MAX_VIEWERS` 仅用于隔离的压力测试环境。
未配置或设为 `0` 表示不限制。正整数分别限制保留的会议数量和每场听众容量。
不要在日常部署中设置正值。测试结束后移除这些值并重新部署。
配置示例和测试步骤见 [容量验收](docs/CAPACITY.md)。

## 本机 Docker 测试

可启动独立的 Keycloak、WebZoom 和 HTTPS 代理。入口只绑定本机 8443 端口。
测试账号、证书生成和浏览器验证步骤见 [本机测试说明](deploy/local/README.md)。
不要将该配置用于生产或改为对外监听。

## OpenShift

清单在 `deploy/openshift/`。
先替换域名、镜像地址和 Secret，再应用清单。
该 Deployment 固定为一个副本，并使用 Recreate 更新策略。
不要增加副本，不要启用 HPA。升级会中断现有会议。

## 自动构建与镜像发布

GitHub Actions 对拉取请求执行检查。`main` 分支和 `v*` 标签通过检查后发布到
`ghcr.io/bobbynie/webzoom`。首次发布架构为 `linux/amd64`。
发布任务使用已经通过容器测试的同一个镜像，不重新构建。
镜像默认使用 `65532:65532`，并支持 OpenShift 分配的任意非 root UID。
发布标签、访问权限和部署步骤见 [CI 说明](docs/CI.md)。

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
