# 接口与媒体协议 v1

## 身份与状态

浏览器通过 Cookie 登录。会议 ID 使用 24 字节随机数的 base64url 编码。
会议 ID 不承担认证功能。所有会议接口都要求有效登录。
默认不限制会议数量或每场听众人数。正值容量限制只用于压力测试。
同一用户身份在一场会议中只能有一个连接。

主持人身份固定。只有主持人可以转交共享权或结束会议。
转交操作在一个互斥临界区内完成：撤销旧权限、增加 epoch、重置队列，再设置新共享者。
新共享者不会自动开始采集。
服务器只接受当前连接、当前共享者和当前 epoch 的媒体。
断线、停止、开始和转交都会重置共享状态。

## HTTP 接口

除健康检查、登录入口、回调和静态资源外，API 都要求会话。
变更操作需要 `Origin: <PUBLIC_URL>` 和 `X-CSRF-Token`。
通过 `GET /api/me` 获取 CSRF token。

| 方法 | 路径 | 输入 / 行为 |
|---|---|---|
| GET | `/auth/login?next=/m/<id>` | 跳转到 OIDC；next 只允许站内路径 |
| GET | `/auth/callback` | 校验 state、PKCE、签名和 nonce，创建会话 |
| POST | `/auth/refresh` | JSON `{}`；活跃会话续期，返回 `user`、`csrf`、`expiresAt` 并更新会话 Cookie |
| POST | `/auth/logout` | 删除当前应用会话，关闭相关媒体连接 |
| GET | `/api/me` | 返回 `user`、`csrf`、`expiresAt` |
| GET | `/api/rooms` | 当前登录用户创建的有效会议；按创建时间从新到旧排列；空列表返回 `[]` |
| POST | `/api/rooms` | 创建会议，返回 Snapshot |
| GET | `/api/rooms/<id>` | 获取 Snapshot |
| POST | `/api/rooms/<id>/actions` | JSON：`{"action":"start|stop|transfer|end","target":"用户ID"}` |
| GET | `/api/rooms/<id>/ws` | 带会话和 Origin 的 WebSocket Upgrade；连接即加入 |
| GET | `/api/admin/overview` | 管理员总览，含 `bandwidth`：`limitMbps`、`totalMbps`、`blocked`、`windowSeconds` |
| POST | `/api/admin/bandwidth` | 管理员保存上限，JSON：`{"limitMbps":200}`；返回当前 `bandwidth` 状态 |
| GET | `/healthz`、`/readyz` | 进程健康检查 |
| GET | `/metrics` | 独立 Bearer token 认证的监控接口 |

会议 Snapshot 字段：`id`、`ownerId`、`publisherId`、`epoch`、`active`、`quality`、`createdAt`、`expiresAt`、`participants`。
参与者字段：`id` 和 `name`。
只有已加入者可以 start、stop 或 transfer。固定主持人可以结束自己的会议。
会议不存在或已经结束时，返回 404。
容量限制返回 429。状态冲突返回 409。权限不足返回 403。未登录返回 401。

## 会话续期

`POST /auth/refresh` 必须携带会话 Cookie、同源 Origin 和正确的 CSRF token。
服务只在当前期限剩余 60 秒内尝试刷新。没有 refresh token 时不延长原期限。
令牌只保存在服务端。响应不包含 access token、ID token、refresh token 或客户端 Secret。
成功响应禁止缓存，并更新 Secure、HttpOnly、SameSite=Lax 的会话 Cookie。
并发请求串行处理同一会话的刷新令牌，避免令牌轮换竞争。
刷新不得复活已退出或已到期的会话，也不得突破初次登录的 8 小时上限。

- 成功或尚未进入刷新窗口：200，返回当前会话身份和期限。
- 当前会话不存在或到期：401。
- Keycloak 拒绝刷新或新身份校验失败：401，撤销会话并关闭媒体连接。
- Origin 或 CSRF 校验失败：403，不访问令牌端点。
- 身份服务临时故障：503，保留尚未到期的会话；前端提示并重试。

浏览器参加会议时自动保活。首页仅在近期真实操作时保活。
`GET /api/me` 只读取状态，不刷新令牌。闲置标签页用它确认其他标签页是否已经续期。
WSS 在当前到期计时器触发时重新读取最新会话期限。
有效续期只更新计时器，不关闭连接、重置解码器或重新请求采集权限。
WSS 媒体帧、clock 控制消息和 ping 本身不刷新 Cookie。

## 总流量接入策略

所有管理员接口继续要求有效会话和管理员 ID。变更接口要求同源 Origin 和 CSRF token。
上限范围为 1 至 1000000 的整数 Mbps，默认 200。保存成功后立即生效，服务重启后保留。
保存失败返回 503，正文为 `cannot save bandwidth configuration`，旧上限不变。
`GET /api/admin/overview` 返回的 `bandwidth.totalMbps` 是服务端最近 5 秒媒体入口与出口之和。
窗口精度为 100 毫秒。超过上限时 `blocked` 为 true，等于上限不阻止接入。

创建会议、会议详情预检和 WSS 握手被策略拒绝时，返回：

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 5
X-WebZoom-Error: bandwidth_limit

bandwidth limit exceeded
```

前端使用专用错误头识别此状态，不把其他 503 错误当作带宽超限。
会议接入每 5 秒重新预检，流量回落后恢复连接。这些等待不占普通重连次数。
已有连接不被断开，已有会议操作和管理员接口不受接入限制。
此规则不保证当前流量低于上限，不替代网络层限速。
持久卷和启动优先级见 `DEPLOYMENT.md`。

## WSS 控制消息

控制消息使用 JSON 文本。每条最多 4096 字节，每个连接每秒最多 20 条。

客户端发送：

- `{"type":"keyframe"}`：请求关键帧。
- `{"type":"feedback","level":1}`：上报拥塞。接受 1–3 档反馈。
- `{"type":"quality","level":0}`：共享者报告当前画质，范围为 0–4。
- `{"type":"clock","clientTime":毫秒时间戳}`：估算时钟偏移。

服务器发送：

- `{"type":"room","room":Snapshot}`：权威会议状态。
- `{"type":"keyframe"}`：要求共享者生成关键帧。
- `{"type":"congestion","level":1}`：通知共享者降低画质。
- `{"type":"clock","clientTime":原值,"serverTime":服务器毫秒时间戳}`。

关键帧请求每场至少间隔 500ms。拥塞反馈每场至少间隔 1 秒。
服务器每 15 秒发送 WebSocket ping。写入超时为 1 秒。
会话到期时主动关闭连接，不依赖客户端继续发送数据。

## 二进制画面

每条 WebSocket 二进制消息是一帧。消息总长度最多 1 MiB。
固定头部长度为 32 字节。数字使用网络字节序，即 big-endian。

| 字节偏移 | 长度 | 字段 |
|---|---:|---|
| 0 | 4 | ASCII `WZ01` |
| 4 | 1 | 关键帧标记：0 或 1 |
| 5 | 3 | 保留，必须为 0 |
| 8 | 4 | 共享 epoch，uint32 |
| 12 | 4 | 帧序号，uint32 |
| 16 | 8 | 采集时间，Unix 微秒，uint64 |
| 24 | 2 | 编码宽度，uint16 |
| 26 | 2 | 编码高度，uint16 |
| 28 | 4 | 保留，必须为 0 |
| 32 | 可变 | VP8 EncodedVideoChunk 数据 |

第一版 codec 固定为 VP8。封包头中的尺寸就是解码配置。
VP8 不需要单独发送 codec extradata。接收端必须等到同一 epoch 的关键帧后再解码。
共享开始时序号重新计数。服务器拒绝重复或倒退的序号。
接收端发现序号缺口时等待新关键帧。
服务不验证完整 VP8 位流，也不转码。它验证封包、大小、身份、epoch 和序号。
恶意或损坏的合法长度位流仍可能触发浏览器解码失败。接收端会重置解码器。

## 有界队列与恢复

- 每个听众队列最多 8 帧、2 MiB。
- 队列溢出时丢弃依赖链，并等待下一关键帧。
- 听众使用独立写循环。慢连接不会在网络写入时持有会议互斥锁。
- 服务共享不可变压缩帧的引用，但不能据此假设出口零复制。
- 服务每场媒体入口上限为每秒 16 MiB。
- 浏览器发送缓存超过 512 KiB 时暂停发送，并要求下一帧为关键帧。
- 编码排队上限为 2；解码排队阈值为 3。
- 超过 1 秒的旧帧会被接收端拒绝，并触发恢复。
- 共享者至少每秒生成一个关键帧。
- 听众最多进行 8 次连续重连尝试，退避上限为 10 秒。
- 共享者断线后不会自动重新授权采集。用户必须重新点击共享。
- 服务器检测到共享者离开时立即广播停止状态。
- 静默断网无法在断网发生的瞬间被服务器发现。听众约 3–6 秒未收到画面时清空画面并提示中断。

## 画质档位

| level | 上限 | 目标码率 |
|---:|---|---:|
| 0 | 1920×1080，30fps | 6 Mbps |
| 1 | 1920×1080，30fps | 4 Mbps |
| 2 | 1280×720，30fps | 3 Mbps |
| 3 | 1280×720，15fps | 1.8 Mbps |
| 4 | 1280×720，10fps | 1.2 Mbps |

不放大小于目标分辨率的采集源。保持宽高比，并将尺寸取为偶数。
拥塞降档最短间隔为 3 秒。连续稳定 30 秒后，最多恢复一档。
档位是目标，不是测得的分辨率或帧率。界面另行显示实际尺寸和处理帧率。
单个慢听众可能触发所在会议的公共画质降低，因为共享者只编码一路。
它不会通过阻塞写入拖住其他听众或其他会议。
任何 level > 0 都显示为降级。降级结果不能算正常质量验收通过。
