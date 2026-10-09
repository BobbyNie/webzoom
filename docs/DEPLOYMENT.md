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

**有效期警告：**本版没有 refresh token 续期。
登录会话不超过 access token、ID token 或 8 小时上限。
在 Keycloak 中检查这些期限。不要为了演示而未经安全审批延长令牌期限。
容量测试所用会话必须覆盖连接准备时间和 30 分钟测量时间。

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
