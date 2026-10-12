# 部署说明

## 1. Keycloak

必要条件：浏览器和 Go 服务都能通过 HTTPS 访问同一个 Realm issuer。
`PUBLIC_URL` 必须是 HTTPS origin，不包含路径、查询参数或片段。

1. 创建 OpenID Connect 客户端，名称设为 `webzoom`。
2. 开启客户端认证。保存客户端 Secret。
3. 开启 Standard Flow，即授权码流程。
4. 关闭 Implicit Flow、Direct Access Grants 和 Service Accounts。
5. 将 PKCE 方法限制为 `S256`。
6. 设置精确回调地址：`https://你的域名/auth/callback`。
7. 不要使用通配回调地址。
8. 如需配置 Web Origins，仅填写本应用 origin。应用不需要跨域 API 权限。
9. 保留 `openid` 和 `profile` scope。
10. 将 `OIDC_ISSUER` 设置为 `https://Keycloak域名/realms/Realm名称`。

本应用不读取自定义角色。所有完成登录的用户均可创建会议。
后端验证 ID token 的签名、issuer、audience、nonce，以及登录回调 state。
客户端 Secret、授权码交换和 PKCE verifier 均留在服务端。

### 活跃会话自动续期

后端保存 refresh token（刷新令牌）。浏览器只持有应用会话 Cookie。
共享者和听众参加会议时都自动保活，包括没有鼠标操作的听众。
首页只有最近 60 秒内的真实操作才保活。闲置首页不会无限刷新。
前端最多间隔 30 秒检查一次状态，并在当前期限剩余 60 秒内发送受 CSRF 保护的续期请求。
短期令牌使用更短的检查间隔。续期不会重新建立媒体连接。

1. 确认客户端允许使用 refresh token，且授权码交换返回刷新令牌。
2. 检查 Realm 的 `SSO Session Idle` 和 `SSO Session Max`。
3. 检查客户端或 Realm 的 `Client Session Idle` 和 `Client Session Max`。
4. 让 Idle 期限覆盖正常刷新间隔。让 Max 期限覆盖组织允许的会议时长。
5. 如启用 `Revoke Refresh Token`，保留轮换策略。服务会保存新令牌并串行刷新同一会话。
6. 保留组织批准的 access token 有效期。不要用延长 access token 代替刷新。
7. 升级应用后重新登录一次。旧会话不能补出刷新令牌。

刷新请求会更新 Keycloak 的 Idle 计时，但不能越过其 Max 期限。
本应用也保留登录时确定的 8 小时绝对上限。每次刷新不会重置该上限。
本应用不请求 `offline_access`，也不会在会话已经到期后恢复它。
若身份服务不提供刷新令牌，会话仍按原令牌期限到期。
Keycloak 参考：[Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/index.html#_timeouts)。

临时网络错误或身份服务 503 不立即撤销尚未到期的会话。页面提示失败并重试。
刷新被拒绝或返回无效身份令牌时，服务撤销会话并关闭对应媒体连接。
已到期、已退出和已达绝对上限的会话仍需重新登录。

压力测试浏览器使用相同的保活流程。仅使用 WSS 的负载工具不会自动更新 Cookie。
此类工具须使用受保护的 `/auth/refresh` 并保存响应 Cookie，或由真实浏览器维护相同测试会话。
不要把加长生产令牌期限作为容量测试的默认前提。

浏览器只持有 Secure、HttpOnly、SameSite=Lax 的会话 Cookie。
HTTP 变更操作要求同源 Origin 和 CSRF token。
WSS 握手要求会话 Cookie 和精确 Origin。会议链接不是登录凭证。

## 2. Docker Compose

Compose 使用 Docker Secret 文件，不把客户端密钥写入镜像。
OpenShift 则通过 Secret 注入环境变量。
后端支持 `OIDC_CLIENT_SECRET` 或 `OIDC_CLIENT_SECRET_FILE`，但不能同时设置两者。
`METRICS_TOKEN` 也支持相同的 `_FILE` 形式。

1. 创建 `.secrets` 目录，并限制宿主机目录权限。
2. 将 OIDC 客户端密钥写入 `.secrets/oidc_client_secret`。
3. 将足够长的随机值写入 `.secrets/metrics_token`。
4. 将完整证书链和私钥放在 `.env` 指定的位置。
5. 设置 `.env`。
6. 运行 README 中的 Compose 命令。

Secret 文件需要可被 UID 65532 读取。
本地 Compose 的文件型 Secret 可能不执行 uid/gid 转换。
一种可用方式是：宿主机 `.secrets` 目录为 0700，两个文件为 0444。
文件仍由受限目录保护，容器通过只读挂载访问。
不要将 `.secrets`、`.env`、证书私钥或会话导出文件提交到 Git。
代理私钥也必须能被 UID 101 读取。请通过组织认可的文件权限或 Secret 管理器配置。

私有 CA 示例：

```sh
# 在 .env 中另外设置 OIDC_CA_BUNDLE，指向完整可信 CA bundle。
docker compose --env-file .env -f compose.yaml -f compose.ca.yaml config --quiet
docker compose --env-file .env -f compose.yaml -f compose.ca.yaml up -d --build
```

不要关闭 TLS 证书校验。
应用镜像使用 scratch，没有 shell。诊断应通过日志、健康接口和外部工具进行。
应用以 UID 65532 运行，也支持其他非 root UID。文件系统可以只读。

## 3. OpenShift

必要条件：已有项目命名空间、镜像仓库、可信 Route 证书，以及集群网络管理员确认。
以下命令会修改指定的集群项目。执行前核对当前集群和项目。

1. 构建镜像并推送到组织镜像仓库。
2. 将 Deployment 的镜像地址替换为已发布的版本，生产环境优先固定镜像 digest。
3. 修改 ConfigMap 中的 `PUBLIC_URL`、`OIDC_ISSUER` 和 `OIDC_CLIENT_ID`。
4. 将 Route host 设置为相同的应用域名。
5. 通过 Secret 管理系统创建 `webzoom-secrets`。
6. 在 Secret 中配置 `OIDC_CLIENT_SECRET` 和 `METRICS_TOKEN`。
7. 将私有 Keycloak CA 添加到组织批准的集群信任配置。
8. 确认 `webzoom-trusted-ca` ConfigMap 已注入 `ca-bundle.crt`。
9. 执行服务端 dry-run。
10. 应用清单。

```sh
oc project 你的项目
oc apply --dry-run=server -k deploy/openshift
oc apply -k deploy/openshift
oc rollout status deployment/webzoom
oc get route webzoom
```

`secret.example.yaml` 只是结构示例，不在 Kustomize 资源列表内。
不要原样应用其中的占位值。
Route 使用 edge TLS 终止，并拒绝非 TLS 入口。
证书默认来自集群 Ingress。自定义证书应按组织的 Route 证书管理流程配置。

Deployment 不指定固定 UID，以适配 OpenShift 分配的任意 UID。
配置包含非 root、只读文件系统、禁止提权、丢弃 capabilities，以及禁用 ServiceAccount token 挂载。
资源 requests/limits 只是试验起点，不是容量保证。
禁止使用多个副本、HPA 或会启动重叠实例的滚动升级。

NetworkPolicy 只允许 Ingress namespace 访问应用端口。
请核对目标集群是否使用 `network.openshift.io/policy-group: ingress` 标签。
平台可能需要为健康探针、路由器或监控组件配置额外规则。
出站 DNS 和 Keycloak HTTPS 由现有集群策略控制。
应用需要 DNS，但不会通过 DNS 发送媒体。

## 4. 网关要求

- 用户入口仅开放 HTTPS/WSS。内部端口不能发布给用户。
- 网关必须允许 WebSocket Upgrade、长连接和二进制帧。
- 保留原始 Host，包括非默认端口。
- 不要缓存或缓冲媒体流。
- Nginx 的 WebSocket 读取超时为 3600 秒。
- OpenShift Route 同时声明普通超时和 tunnel 超时。必须在目标版本核对注解是否生效。
- 服务每 15 秒发送 ping。浏览器也发送时钟控制消息。
- 中间设备的空闲超时必须大于心跳间隔。
- 禁止日志记录 Cookie、Authorization、OIDC 授权码和完整回调查询参数。
- 网关带宽、TLS CPU、文件描述符和连接数都必须纳入容量测试。

## 5. 健康与监控

`/healthz` 和 `/readyz` 为轻量健康接口。
启动成功表示 OIDC discovery 已通过。
就绪检查不持续探测 Keycloak，也不代表媒体容量或前端兼容性已经达标。

`/metrics` 要求 `Authorization: Bearer <METRICS_TOKEN>`。
未配置令牌时，该接口返回 404。
不要把监控令牌放入 URL。不要将它发给普通会议用户。

| 指标 | 含义 |
|---|---|
| `webzoom_rooms` | 当前会议数 |
| `webzoom_connections` | 当前媒体连接数，包括共享者 |
| `webzoom_queued_frames` | 当前应用队列中的帧数 |
| `webzoom_ingress_bytes_total` | 收到的媒体封包字节 |
| `webzoom_egress_bytes_total` | 成功写出的媒体封包字节，不含 TLS/IP 开销 |
| `webzoom_dropped_frames_total` | 拒绝入队的媒体帧计数，不等于最终画面丢帧总量 |
| `webzoom_congestion_reports_total` | 合并后的拥塞反馈次数 |
| `webzoom_active_rooms_by_quality{level="0..4"}` | 各画质档位的活动会议数 |

CPU、RSS、容器网络流量、重启和网关指标由平台采集。
退出应用会删除当前会话，并撤销该会话的媒体连接。
没有会议持久化或备份恢复功能。升级、重启和 OOM 都会中断会议。

## 6. 日常容量与压力测试配置

日常部署默认不限制会议数量和每场听众人数。页面不显示这些数量统计。
维护人员仍可使用认证的 `/metrics` 检查资源负载。
不要把默认无限制理解为无限的处理能力。根据实际带宽、内存和代理负载配置资源。

`LOAD_TEST_MAX_ROOMS` 和 `LOAD_TEST_MAX_VIEWERS` 仅用于压力测试。
不设置或设为 `0` 时禁用限制。正整数分别限制保留会议数量和每场连接容量（听众值加一名共享者）。
应用在启用测试限制时输出启动警告。非法值会使启动失败。
生产 OpenShift 清单不设置这些变量。Docker 示例默认传入 `0`。
隔离测试配置和测试后清理步骤见 `docs/CAPACITY.md`。

## 独立管理员总览

访问 `https://<PUBLIC_URL 的主机>/admin`。此页面复用现有 HTTPS 入口和 SSO 登录。
不需要新增端口、Keycloak 角色或管理员密码。普通首页和会议功能不变。

### 配置管理员

1. 使用目标管理员账号登录 WebZoom。
2. 在该页面的浏览器开发者工具控制台执行：

   ```js
   (await (await fetch('/api/me', {credentials: 'same-origin'})).json()).user.id
   ```

3. 复制返回的用户 ID。它是当前 OIDC 签发者提供的 `sub`，不是用户名、邮箱或显示名。
4. 在启动环境中配置 `ADMIN_USER_IDS`。使用逗号分隔多个 ID。

   ```dotenv
   ADMIN_USER_IDS=first-user-sub,second-user-sub
   ```

   Docker `run` 命令增加以下参数，保留原有 OIDC、证书和非 root 配置：

   ```sh
   -e ADMIN_USER_IDS='first-user-sub,second-user-sub'
   ```

   Docker Compose 使用项目 `.env` 中的同名配置。生产和本机测试 Compose 均支持该配置。
   OpenShift 修改 `deploy/openshift/config.yaml` 中 `webzoom-config.data.ADMIN_USER_IDS`。
   使用字符串值，例如 `ADMIN_USER_IDS: "first-user-sub,second-user-sub"`。

**警告：配置仅在进程启动时读取。重建容器或滚动更新会清除内存中的会议和登录会话。**
在无会议时应用配置并重新启动服务。修改 OpenShift ConfigMap 后还需要重新启动 Deployment。
随后重新登录并访问 `/admin`。本机测试用户也必须填写实际 `user.id`，不要直接填写 `alice` 或 `bob`。

空值默认禁用管理员访问。服务忽略列表项周围空格、空项和重复项，并区分 ID 大小写。
未登录请求返回 401；已登录但未配置的用户返回 403。
管理员可以查看总览，并批量结束所选会议，包含其他用户创建的会议。
管理员不能通过此页面转交共享权或改变会议限制。普通用户的权限不变。
页面可见时会自动续期会话，仍受身份服务期限和应用 8 小时上限约束。
页面隐藏时不主动延长空闲会话；会话失效后清空总览并要求重新登录。

### 数据定义

- **有效会议**：未结束、未到期且尚未超过 30 分钟空闲期限的会议。包含暂时无人参加的会议。
- **参与人数**：当前未关闭的会议 WebSocket 连接数，包含共享者。同一人在多个会议中分别计数。
- **入口累计**：服务接受的屏幕二进制消息字节数。非法或被拒绝的画面不计入。
- **出口累计**：服务成功写入听众 WebSocket 的屏幕二进制消息字节数。未发送或丢弃的队列帧不计入。
- **流量范围**：包含应用画面帧头；不包含 HTTP、JSON 控制消息、TLS、WebSocket 帧头或网络重传开销。
- **速率**：相邻成功采样之间的平均 Mbps，通常间隔 5 秒。不是网卡带宽计量，也不表示浏览器已经解码。
- **单位**：1 MB = 1,000,000 字节；1 Mbps = 1,000,000 比特/秒。
- **累计期限**：服务总量从启动开始累计，包含已结束会议。每场会议从创建开始累计。进程重启后归零。

首次采样和进程重启后的首次采样不计算速率。并发发送时，各计数器分别采样，瞬间可能存在细小差异。
总览查询不清理会议、不创建媒体连接，也不改变人数或会议数量限制。
网络或服务错误时，页面清空旧数据并显示错误。轮询请求 15 秒超时后重试。
总览 API 为 `GET /api/admin/overview`。它校验会话和管理员 ID，并禁止响应缓存。
它不返回参与者名单、会话令牌、CSRF 值或 OIDC 令牌。`/metrics` 保留原有独立凭据保护。


### 批量结束会议

**警告：结束会议会停止共享，并断开所有参与者连接。原链接将失效。此操作不能撤销。**

必要条件：当前账号的 OIDC `sub` 已包含在 `ADMIN_USER_IDS` 中。

1. 打开 `/admin`。
2. 勾选需要结束的会议。使用“全选当前会议”可选择当前列表。
3. 点击“批量结束会议”。
4. 检查确认框中的会议 ID。
5. 点击“确认结束选定会议”。点击“取消”或按 Escape 不会提交请求。
6. 检查操作结果。展开“查看逐项结果”可读取每场会议的状态。

提交期间，页面禁止重复提交和更改选择。轮询新增会议不会自动加入选择。
确认前，若所选会议从列表消失，页面会关闭确认框。请检查选择后重新确认。
服务重启或登录失效时，页面清空选择。临时总览错误也会取消尚未提交的确认。

结果有三种：

- **已结束**：服务确认执行了结束操作。
- **已结束或已过期**：服务已找不到该会议，无需再次结束。
- **结果未确认**：请求失败、超时或响应无效。会议可能已结束，也可能仍在运行。

若结果未确认，先检查刷新后的会议列表，再选择仍存在的会议并重试。
页面会停止后续批次，并保留先前批次的已确认结果。它不会把请求超时当作成功。
批量操作不是跨请求事务。先前已经结束的会议不会恢复。

接口为 `POST /api/admin/rooms/end`：

```json
{"roomIds":["<会议 ID>","<另一会议 ID>"]}
```

成功响应返回逐项结果。`ended` 表示已结束。`not_found` 表示已结束或已过期。

```json
{"results":[{"id":"<会议 ID>","status":"ended"},{"id":"<另一会议 ID>","status":"not_found"}]}
```

接口验证有效会话、管理员 ID、同源 `Origin` 和 `X-CSRF-Token`。
请求体上限为 16 KiB，每次最多接受 100 个会议 ID。页面会自动拆分更多选择，并顺序提交。
服务先验证完整请求，再修改会议。无效请求返回 400，不会部分结束会议。
同一请求中的重复 ID 只处理一次。并发结束同一会议时，只有首次有效结束返回 `ended`。
这些限制只保护单次管理请求，不限制服务器会议数量。接口不增加端口，继续使用现有 HTTPS 入口。
