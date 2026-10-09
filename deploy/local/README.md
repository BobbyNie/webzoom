# 本机 Docker 测试

此配置使用生产应用 Dockerfile、独立 Keycloak 和 Nginx TLS 代理。
它不会连接公司的身份服务，也不会修改系统证书信任。

**警告：此环境包含公开的测试账号和客户端密钥。只供本机测试。**
**不要改为 `0.0.0.0` 监听。不要用于生产或保存真实敏感信息。**

## 1. 启动

必要条件：Docker Compose、OpenSSL，以及空闲的本机 8443 端口。
以下命令从仓库根目录运行。

1. 创建本地证书目录。

```sh
mkdir -p .secrets/local
```

2. 生成七天有效的测试证书。已有证书仍有效时不要覆盖。

```sh
openssl req -x509 -newkey rsa:2048 -sha256 -days 7 -nodes \
  -keyout .secrets/local/privkey.pem -out .secrets/local/fullchain.pem \
  -subj '/CN=webzoom.localhost' \
  -addext 'subjectAltName=DNS:webzoom.localhost,DNS:localhost,IP:127.0.0.1'
chmod 755 .secrets/local
chmod 644 .secrets/local/fullchain.pem .secrets/local/privkey.pem
```

以上权限用于让非 root 代理读取测试私钥。`.secrets` 被 Git 忽略。
这不是生产私钥的权限配置建议。

3. 启动容器。

```sh
docker compose -f deploy/local/compose.yaml up -d --build
```

4. 等待 Keycloak 完成导入。首次启动期间应用可能重试并产生临时 502 错误。
5. 验证 HTTPS 就绪接口。

```sh
curl --resolve webzoom.localhost:8443:127.0.0.1 \
  --cacert .secrets/local/fullchain.pem \
  https://webzoom.localhost:8443/readyz
```

应用通过 TLS 验证测试证书，不关闭服务端证书校验。
Docker 内部通过网络别名解析 `webzoom.localhost`。Chromium 在宿主机上将它解析为回环地址。

## 2. 浏览器试用

地址：`https://webzoom.localhost:8443`。

| 用户名 | 显示名称 | 测试密码 |
|---|---|---|
| `alice` | Alice Local Demo | `Local-demo-only-2026!` |
| `bob` | Bob Local Demo | `Local-demo-only-2026!` |

以上是 `realm.json` 导入的全部测试用户。此配置没有创建 Keycloak 管理员账号。
测试 Realm 为 `webzoom-local`，客户端为 `webzoom`。
应用通过真实的授权码流程和 PKCE 登录，没有免认证入口。
自动化测试完成登录后，保留的浏览器可能仍有本应用 Cookie 和 Keycloak SSO Cookie。
因此，再次打开页面可能直接显示已登录状态。

点击“退出”只退出 WebZoom，不退出 Keycloak。再次登录可能自动使用相同身份。
测试两个用户时，请使用两个独立浏览器配置文件，或彼此隔离的隐私窗口。
同一浏览器的多个隐私窗口可能共享 Cookie，不能保证用户隔离。
本机凭据公开且只用于测试。不要将其用于生产。

1. 使用桌面 Chrome 或 Edge 打开地址。
2. 点击“使用公司账号登录”。
3. 使用上述测试账号完成本地 Keycloak 登录。
4. 创建会议。
5. 点击“共享屏幕”，自行选择屏幕、窗口或标签页。
6. 在另一个浏览器配置文件中使用另一账号登录，并打开会议链接。

普通浏览器会提示自签名证书不受信任。本配置不会自动绕过安全提示。
自动化测试只在独立的测试浏览器上下文中设置 `ignoreHTTPSErrors`。
需要普通浏览器无警告访问时，由用户或管理员配置可信的本地证书。
测试完成后不要把忽略证书错误的设置用于其他站点。

Keycloak 使用内存数据库。它重启后会重新导入测试账号。
WebZoom 重启后会议和应用会话失效。测试登录会话期限较短，到期后需重新登录。

## 3. 自动化验证

必要条件：按项目开发说明安装前端依赖和 Playwright Chromium，并启动本机容器。

```sh
cd web
npx playwright test --config playwright.local.config.ts --headed
```

此命令不会启动 Go 测试身份服务。它访问已启动的 Docker 环境。
测试使用真实 Keycloak Authorization Code + PKCE 登录。
屏幕源为 1920×1080 合成动画，实际执行 VP8 编码、代理 WSS 转发、解码和显示。
它不读取真实桌面，也不验证操作系统的屏幕选择弹窗。

2026-10-09 本机验证：两项测试通过。

- 登录、创建会议、听众接收画面、转交共享权、停止共享。
- 未登录 API 拒绝，以及采集取消后保持未共享状态。
- 采集参数为 `audio: false`。调用麦克风、摄像头或 WebRTC 会让测试失败。
- 观察到 65 个浏览器请求和 2 条 WebSocket 连接，均使用本机 HTTPS/WSS。
- 页面运行错误为 0。

截图保存在 `artifacts/local/docker-viewer.png`。
本次截图出现了自动降码率，显示 1080p、约 23fps。
此结果只确认功能链路，不证明 1080p30 或端到端延迟目标达标。
未执行 1000 名听众、30 分钟容量验收。

## 4. 状态与停止

```sh
docker compose -f deploy/local/compose.yaml ps
docker compose -f deploy/local/compose.yaml logs --tail 50
docker compose -f deploy/local/compose.yaml stop
```

恢复运行：

```sh
docker compose -f deploy/local/compose.yaml up -d
```

只有代理发布 `127.0.0.1:8443`。应用和 Keycloak 不发布宿主机端口。
应用默认 UID/GID 为 `65532:65532`，根文件系统只读，禁止权限提升并删除全部 capabilities。
代理和 Keycloak 同样使用非 root 用户。Keycloak 开发模式需要可写容器文件系统。

## 会议清理与测试隔离

首页“我创建的会议”只显示当前用户创建且未结束、未过期的会议。
共享权转交不会改变创建者。创建者可以在首页结束会议，不必先加入会议。
离开页面、关闭浏览器或停止共享都不会结束会议。
空会议在 30 分钟后清理；会议最长保留 8 小时。

应用默认不限制会议数量和听众人数。页面不显示数量统计。
`LOAD_TEST_MAX_ROOMS` 和 `LOAD_TEST_MAX_VIEWERS` 的正值只用于压力测试。
自动化测试必须只结束自己创建的会议，不能删除同一用户的其他会议。
重建或重启 app 会删除全部内存会议和本应用登录会话。Keycloak Cookie 可能仍有效。
