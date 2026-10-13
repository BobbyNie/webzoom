# 本机 Docker 测试

此配置使用生产应用 Dockerfile、独立 Keycloak 和 Nginx TLS 代理。
它不会连接公司的身份服务，也不会修改系统证书信任。

**警告：此环境包含公开的测试账号和客户端密钥。只供本机测试。**
**不要改为 `0.0.0.0` 监听。不要用于生产或保存真实敏感信息。**

2026-10-12 安全检查：官方 Keycloak 26.8.0 重建镜像仍有 34 个不同 CVE，其中 3 个为 HIGH。
当前扫描数据库未标注这些记录的修复版本。此配置仅用于隔离的本机测试。
若组织策略拒绝这些风险，应停止 Demo 身份服务。详情见 `../../docs/SECURITY.md`。
应用和代理使用修复后的构建配置，但已有运行容器不会因配置更新而自动升级。

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
  -addext 'subjectAltName=DNS:webzoom.localhost,DNS:localhost,IP:127.0.0.1' \
  -addext 'basicConstraints=critical,CA:FALSE' \
  -addext 'keyUsage=critical,digitalSignature,keyEncipherment' \
  -addext 'extendedKeyUsage=serverAuth'
chmod 755 .secrets/local
chmod 644 .secrets/local/fullchain.pem .secrets/local/privkey.pem
```

以上权限用于让非 root 代理读取测试私钥。`.secrets` 被 Git 忽略。
这不是生产私钥的权限配置建议。

**警告：以下命令也会更新已有容器。更新会中断会议，并清空应用会话。**
先确认没有人在使用当前会议。

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

### 普通浏览器的证书信任（macOS）

必要条件：证书由你按上述步骤生成，或由组织批准的证书服务提供。
以下步骤仅适用于本机自签名测试证书。其他操作系统按组织的证书管理流程配置。
curl --cacert 成功不表示浏览器已信任证书。它只验证该次请求使用的指定证书。

**警告：添加信任会改变当前用户的 HTTPS 信任设置。先核对证书，不要信任来源不明的证书。**
不要关闭浏览器证书验证。不要把测试证书导入系统根证书库。

1. 查看证书指纹、有效期和扩展。

```sh
openssl x509 -in .secrets/local/fullchain.pem -noout -sha256 -fingerprint -dates -text
```

2. 记录 SHA-256 指纹。确认主机名包含 `webzoom.localhost`，证书未过期，且 `CA:FALSE`。
3. 打开 macOS“钥匙串访问”，选择当前用户的“登录”钥匙串。
4. 使用“文件 → 导入项目”导入 `.secrets/local/fullchain.pem`。不要导入私钥。
5. 双击导入的证书，核对指纹与第 2 步相同。
6. 展开“信任”，仅将“安全套接字层（SSL）”设为“始终信任”。其他用途保留默认值。
7. 关闭证书窗口，并按系统提示确认更改。
8. 使用系统 curl 验证 HTTPS。以下命令不指定额外证书，也不跳过验证。

```sh
/usr/bin/curl --fail --silent --show-error \
  --resolve webzoom.localhost:8443:127.0.0.1 \
  https://webzoom.localhost:8443/readyz
```

9. 在浏览器新标签页打开 `https://webzoom.localhost:8443/`，确认没有证书警告。
10. 如果仍有警告，退出并重新打开浏览器，再检查实际证书的指纹、主机名和有效期。

如果组织策略禁止手动信任，停止此操作，并申请组织批准的本机证书。
钥匙串操作参考 Apple《Change the trust settings of a certificate in Keychain Access on Mac》。

### 证书到期、更换与撤销信任

**警告：重新创建应用会中断会议，并清空应用登录会话。先结束测试会议。**
七天测试证书到期前必须更换。不要覆盖仍在使用的有效证书。

1. 在受限备份目录中保存旧证书和私钥，记录旧证书指纹。不要提交这些文件。
2. 按生成步骤在单独目录生成新证书，并检查有效期、主机名和 `CA:FALSE`。
3. 将新证书及匹配私钥替换到 `.secrets/local/`，保持非 root 代理所需的读取权限。
4. 按上述步骤核对并信任新证书。旧证书的信任不会自动转移到新证书。
5. 重新创建应用和代理，使应用读取新的信任文件，并使代理加载新的证书。

```sh
docker compose -f deploy/local/compose.yaml up -d --force-recreate app proxy
```

6. 重复严格 HTTPS 检查和浏览器检查，然后重新登录测试账号。
7. 在“钥匙串访问”中按旧指纹定位旧证书，将 SSL 信任恢复为系统默认，并删除该测试证书。

测试结束后，按同样方法撤销当前测试证书的信任。只操作已核对指纹的测试证书。
不要删除组织证书。不要删除 `app-data` 卷。证书更换不需要重启 Keycloak。

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
需要普通浏览器无警告访问时，先完成上文“普通浏览器的证书信任”步骤。
测试完成后不要把忽略证书错误的设置用于其他站点。

Keycloak 使用内存数据库。它重启后会重新导入测试账号。
WebZoom 重启后会议和应用会话失效。参加会议的共享者和听众会自动续期。
续期仍受 Keycloak 期限和应用登录 8 小时绝对上限约束。闲置首页不会无限续期。

### 总流量设置保存

本机 Compose 把 `app-data` 命名卷挂载到 `/data`。
初始值由 `TOTAL_BANDWIDTH_LIMIT_MBPS` 指定，默认 200 Mbps。
管理员在 `/admin` 保存的上限写入 `/data/bandwidth.json`，容器重启后保留。
已有文件时，保存值优先于启动环境变量。会议和登录会话仍在重启后失效。

不要执行 `docker compose -f deploy/local/compose.yaml down -v`，否则保存值会被删除。
不增加管理员时，`ADMIN_USER_IDS` 仍为空，测试账号没有管理员权限。
配置管理员必须填写实际 OIDC 用户 ID，不要填写 `alice` 或 `bob`。
权限、计量规则和恢复步骤见 `../../docs/DEPLOYMENT.md`。

## 3. 自动化验证

必要条件：按项目开发说明安装前端依赖和 Playwright Chromium，并启动本机容器。

```sh
cd web
npx playwright test --config playwright.local.config.ts --headed
```

此命令不会启动 Go 测试身份服务。它访问已启动的 Docker 环境。
套件包含真实 Keycloak 测试和接口模拟测试。两类结果必须分开记录。
真实登录测试使用 Keycloak Authorization Code + PKCE。
画面链路测试使用 1920×1080 合成动画。续期测试使用 1280×720、15fps 合成动画。
两项画面测试实际执行 VP8 编码、代理 WSS 转发、解码和显示。
它们不读取真实桌面，也不验证操作系统的屏幕选择弹窗。
续期测试使用真实时间。完整套件需要约六分钟。

只执行真实 Keycloak 的会话续期测试：

```sh
cd web
npx playwright test --config playwright.local.config.ts local-tests/session-renewal.spec.ts
```

共享者和被动听众必须保持连接，直到超过两人的首次登录有效期。
测试检查自动续期、画面持续更新和原媒体连接保持不变。
测试只清理自己创建的会议，不删除同一账号的其他会议。

2026-10-09 本机验证：两项测试通过。
这是当时运行镜像的历史结果，不是 2026-10-12 新 Keycloak digest 的登录验收。

- 登录、创建会议、听众接收画面、转交共享权、停止共享。
- 未登录 API 拒绝，以及采集取消后保持未共享状态。
- 采集参数为 `audio: false`。调用麦克风、摄像头或 WebRTC 会让测试失败。
- 观察到 65 个浏览器请求和 2 条 WebSocket 连接，均使用本机 HTTPS/WSS。
- 页面运行错误为 0。

截图保存在 `artifacts/local/docker-viewer.png`。
本次截图出现了自动降码率，显示 1080p、约 23fps。
此结果只确认功能链路，不证明 1080p30 或端到端延迟目标达标。
未执行 1000 名听众、30 分钟容量验收。

2026-10-12 新 Keycloak digest 仅完成漏洞扫描和非 root、只读容器的版本启动检查。
该检查确认 Keycloak 26.8.0 和 JVM 21.0.12.1 可以启动；它不验证完整登录链路。
2026-10-12 未重启当时的 Docker 服务。该历史检查不代表完整登录链路通过。


### 2026-10-13 更新后的验证

经用户确认，重新构建应用和代理，并重新创建全部本机 WebZoom 容器。
应用使用已发布修复源码 `6d43fc8`，在本机构建 ARM64 镜像。
本机未使用 Docker Hub 的 AMD64 发布镜像。
Keycloak 使用上述固定 digest。可信测试 CA 的 HTTPS 就绪检查通过。
更新清空了原会议和应用会话。用户需要重新登录。

完整套件 14 项通过，耗时约 5.4 分钟：

- 4 项访问真实 Docker 和 Keycloak，覆盖会议清理隔离、画面链路、采集取消和会话续期。
- 10 项使用接口模拟，覆盖全屏布局、错误处理和“我创建的会议”页面。

真实画面测试确认听众收到 VP8 画面、浏览器全屏后继续收帧、共享权转交和停止共享。
观察到 61 个浏览器请求和 2 条 WebSocket 连接，均使用本机 HTTPS/WSS。
真实时间续期测试持续 306 秒，超过共享者和听众的首次登录有效期。
两人各完成 1 次自动续期；两人各保持 1 条媒体连接。画面持续更新，未重新采集。
两个画面测试的页面运行错误均为 0。采集没有音频，也没有请求麦克风或摄像头。
续期截图为 `artifacts/local/docker-viewer-renewed.png`。

当前没有配置管理员。额外检查确认匿名管理员接口返回 401，普通用户返回 403。
普通用户打开 `/admin` 显示无权限。本次没有新增管理员，也没有验证真实 Keycloak 管理员操作。

应用和代理实际运行镜像的全部严重级别漏洞扫描均为 0 项。
测试 Keycloak 仍有 34 个不同 CVE：HIGH 3 个、MEDIUM 19 个、LOW 12 个。
它只用于隔离本机测试。此结果不表示环境没有漏洞。
详见 `../../docs/VERIFICATION.md` 的本日记录。

合成画面不代表操作系统屏幕选择器验收。
本次没有完成生产容量、1080p30 延迟目标或真实 OpenShift 验收。

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

## 管理员总览

使用测试账号登录后，通过 `/api/me` 获取 `user.id`。不要将用户名当作 ID。
启动 Compose 时设置 `ADMIN_USER_IDS=first-user-sub,second-user-sub`，即可访问 `/admin`。
默认没有管理员。配置方法和流量定义见 `../../docs/DEPLOYMENT.md`。
重新创建应用容器会中断当前会议。请先结束测试会议。
