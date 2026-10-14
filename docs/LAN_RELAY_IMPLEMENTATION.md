# LAN UDP 分流：基于当前代码的复核与试验实现

- 日期：2026-10-14。
- 分支：`feature/lan-udp-relay`（用户明确要求独立分支）。
- 开发基线：`db57caa`，包含共享者 PiP、申请批注及 r2 修复；当日已 fetch 核对远程。不是从旧方案的 `6b7f5b1` 直接开发。
- 状态：**服务端、网页、Chrome MV3 扩展与 Windows native helper 的试验代码已实现，默认关闭。尚未完成公司实机 G0–G4，不是生产可用性或 20 Mbps 验收声明。**
- 本轮没有安装客户端、修改注册表/防火墙、推送镜像或操作 OCP/SSO/PVC。旧版 [方案](LAN_RELAY_PROPOSAL.md)、[复核](LAN_RELAY_VERIFICATION.md)、[验收门槛](LAN_RELAY_ACCEPTANCE.md) 保留历史，不覆盖成成功报告。

## 1. 重新判断后的选择

仍采用 **每个实际可达接收组一个中继、真正的 IPv4 UDP 定向广播**。不改成 WebRTC 单播，不让 OCP 对办公网发广播。Chrome 扩展负责受限的网页到本地程序桥接，UDP 由用户级 Go helper 执行。

当前代码已经有可靠的 OIDC 会话续期、带宽观测、VP8/WZ01 帧、共享权 epoch、丢帧恢复及批注/PiP。因此保留这些机制，只新增媒体分发路径。所有参与者仍保留自己的认证 WSS 控制连接，批注、申请、共享权转交、管理员结束会议继续走原路径。

| 旧提案/待选项 | 本轮决定及原因 |
| --- | --- |
| 仅根据 IP/prefix 猜组 | 不采用；以服务端随机挑战经真实 UDP 传播、接收者通过各自认证 WSS 回报为依据。可达关系有方向、有期限，不假定传递性。 |
| 扩展直接提供通用 UDP 能力 | 不采用；扩展仅连接一个固定 Native Messaging host，不提供任意命令或目标地址接口。 |
| externally_connectable | 改为指定主机的隔离 content script + runtime.Port；background 再检查精确 HTTPS origin、顶层 frame、扩展 ID、会议路径。 |
| 全量传递最大帧 | 采用 32 KiB 二进制片段再 base64，单条 JSON 上限 64 KiB，逐块 ACK，避免 Chrome 消息超限和无界排队。 |
| 签名算法 | Go 标准库 ECDSA P-256/SHA-256；签名固定 64 字节，便于浏览器 WebCrypto 测试验证。没有复制第三方密码实现。 |
| 丢包恢复 | 初版丢弃残帧、请求关键帧，接入现有画质降级；没有实现 FEC/NACK 重传。 |
| 任意多网卡/多会议 | 先收紧为一台电脑一个 LAN 会议、一个获批 IPv4 地址；多网卡/VPN/端口占用明确拒绝，不偷偷换网卡或抢端口。 |
| 动态最优容量分配 | 先用保守的每订阅 8 Mbps 预留 + 全局出口令牌桶；没有宣称自适应按画质增加组数或最优公平调度。 |
| 先 G0 再做完整产品 | 按本次新指示先实现可测原型，但没有把尚未执行的公司 G0–G4 标为通过。 |

### 查阅的原始资料

2026-10-14 查阅官方文档/开源仓库原文；不把这些资料当成本项目的实测证据：

1. [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)：长连接、host 消息长度前缀、单条消息上限及 Windows 用户级注册。本实现选择更小的 64 KiB 应用上限。
2. [RFC 8085：UDP Usage Guidelines](https://www.rfc-editor.org/rfc/rfc8085.txt)：UDP 不保证交付，需要约束速率、报文尺寸和拥塞影响。本轮只面向获批有线广播试验，固定速率上限不等于通用互联网拥塞控制。
3. [udp-broadcast-relay-redux](https://github.com/udp-redux/udp-broadcast-relay-redux)：研究跨网络广播中继的边界；其 Linux/FreeBSD、raw socket/权限及跨接口转发路线不适合此处的普通用户 Windows 客户端，因此没有直接引入。

没有新增第三方运行库、复制上述项目源码或引入论文算法。本轮选择现有标准库和可审核的小协议；性能与网络适配仍须测量。

## 2. 实际数据路径

```text
共享者（普通模式或 LAN 模式）
  └─ 认证 WSS 上传原始 VP8/WZ01 一份
       └─ 服务端校验共享权、epoch、sequence，签名
            ├─ 每个获准 relay：WSS 一份签名媒体
            │    └─ 网页 → MV3 → native helper（分块/ACK）
            │         ├─ 验证来源后本机解码显示
            │         └─ AES-GCM 分片、限速 → 指定子网广播地址
            │              └─ receiver helper 验证/重组/验签
            │                   └─ MV3 → 原 WebCodecs Viewer
            └─ 明确选用普通模式的观众：预算内保留原 WSS 路径
所有参与者 ── 自己的认证 WSS ── 会话、会议控制、批注、时钟、反馈
```

LAN receiver 不收到自己的服务器二进制媒体副本；只收控制。中继也只接收一份服务器媒体，再本地播放和广播。不能据此声称控制/密钥流量与人数无关。

### 分组、租约及失败处理

- 每个 WSS 参与者有随机 node，每场会议有随机 room tag。服务端向候选 relay 单独下发随机 challenge；helper 广播，接收者回报 node/token，服务端验证令牌和当前成员关系。
- 使用确定性的贪心覆盖选择 relay，不按 IP 字符串分组。不声称求得最优组数。只有已选 relay 周期探测，避免所有观众持续广播。
- 约每 3 秒可发探测；证明 9 秒过期；native 心跳授权 6 秒；helper 配置租约 4 秒；服务端沿用认证 socket 的周期检查并全局节流。
- 拓扑/成员/epoch 变化、helper 新握手均生成新 generation 和组密钥，清空待发媒体，收到新配置 ACK 后才供流。正常续租不能重置 nonce。
- relay 退出/故障后重新选举。覆盖未知的成员不会直接继承旧组；必要时保持无画面，等待新的证明/预算。
- native 每秒复核获批网卡/地址/掩码，检测变动后终止；有检测窗口及在途包，不宣称网络变化的原子隔离。多接口支持仍需平台 packet-info 层及额外验收。
- helper 缺失、版本不兼容、端口占用、UDP 错误、租约失效、桥接超时均显示错误并停止 LAN 视频，**不自动回退所有人直连**。失败后需修复原因并刷新/重连。
- 明确选普通模式会重新建立普通 WSS；服务端启用 LAN 预算后，这类连接也占用预算。共享权转交若新增普通下行超过预留，先拒绝转交而不改变当前共享者。

## 3. 安全与资源边界

| 项目 | 当前实现 |
| --- | --- |
| 认证 | 原有 Cookie/Origin/会话校验不变；`/api/lan` 亦需认证。Cookie、OIDC token 不发给 helper。 |
| 启用 | 服务端默认关闭；网页每标签页通过 sessionStorage 显式选 LAN。只有同时开启才使用新路径。 |
| 扩展权限 | MV3，只有 nativeMessaging；生成时绑定主机与 /m/*。Chrome match pattern 不包含端口，后台再次按完整 origin（含非默认端口）限制。没有 all-sites 权限。 |
| Native host | `com.webzoom.lan`；验证 Chrome 调用扩展 ID、精确 HTTPS origin、protocol=1、批准地址/端口/速率；无本地 HTTP/TCP 监听。 |
| 帧来源 | WZS1 + room(16) + generation(16) + 原 WZ01 + ECDSA r/s(64)；helper 发前/收后均验签。 |
| 广播保护 | AES-256-GCM；WZU1 头 56 字节作为附加认证数据；组/代际/计数器/帧号/片号/总长均被绑定。 |
| nonce | 单发送者独占每代密钥，96-bit nonce 的低 64 位单调计数；重启重新向服务端取得新代际/密钥，不复用旧状态。 |
| 防重放 | 有界 4096 包窗口；解密成功不代表帧来源可信，验签和 epoch 校验后才推进签名帧 sequence。 |
| UDP 尺寸 | 每报文至多 1200 字节 UDP payload，片段数据 1128 字节；不支持 jumbo、IPv6 或跨广播域路由。 |
| 重组 | 最多 8 个未完成帧、8 MiB；有效片段间空闲超时 750 ms，单帧绝对寿命上限 10 秒（覆盖最低许可 1 Mbps 的最大帧序列化时间）；原始帧仍限 1 MiB，签名外壳额外 100 字节。 |
| IPC | 32 KiB 原始片段，64 KiB JSON 上限，1 秒 ACK/组帧期限；发送媒体队列 1 帧、接收 1 帧、控制输出 32 项。 |
| 限速 | helper 最多 8 Mbps（包含 UDP/IP 长度估算）；跨帧持续 pacing，10 ms 允许突发；接收包处理/探测回报有速率和大小上限。 |
| 系统权限 | HKCU 与 LOCALAPPDATA；不安装服务/驱动，不要求管理员，不改变防火墙或执行策略。 |

组密钥不能阻止已经获授权的人录屏/转发或恶意 DoS。服务端签名防止共享组密钥的接收者伪造画面来源，但不能抵抗被攻陷的获准网页、OS 或授权终端。可达证明也不抵抗串通参与者转递 challenge。需要独立安全审核，不能称“已密码审计”。

退出/撤权后，服务端轮换后续媒体的密钥；已收到内容不能撤回。SSO 撤销仍按原刷新/过期边界发现，不新增即时 backchannel logout。helper fail-closed 不替代服务端授权。

## 4. 20 Mbps 应如何解释

**现在无法确认公司 20 Mbps 是出口、入出口之和还是共享链路上限，因此不能声称已满足硬上限。**

当前配置：

| 配置 | 默认/范围 | 实际含义 |
| --- | --- | --- |
| `LAN_RELAY_ENABLED` | false；只接受 true/false | 关闭时原媒体分发路径不变。 |
| `LAN_MEDIA_BUDGET_MBPS` | 16；8–1000 整数 | 整个服务的应用媒体**出口**预算；不是链路线速。 |
| 每下行订阅预留 | 固定 8 Mbps | 默认最多同时预留两条 relay/普通下行流，跨会议统一计数。不是固定最多两个 LAN 节点，也不是只支持两种网段。 |
| `TOTAL_BANDWIDTH_LIMIT_MBPS` | 保持原有 200/持久设置 | 原有已测媒体入+出滚动接入门槛；不是强制限速，不能冒充 20 Mbps shaping。 |

服务端令牌桶限制入队媒体总字节，允许 1 秒 burst；慢队列/实际 socket 时序及 TCP 重传仍会改变瞬时线上速率。达到预算时整帧丢弃并请求关键帧/降低画质，不在全局锁内等待网络。签名也在 Hub 全局锁外计算，再复核授权状态。

只在确认“20 Mbps 为独占出口”后，16 Mbps 才能作为试验起点。若计入上传、多个共享者或其他业务，必须先扣除这些流量，再设预算或限制并发；必要时增加网络侧整形。不能用 6 Mbps × 2 组的算术代替真实链路测试，也不能承诺任意组数。

同一场会议仍只有一条编码画质，不为各组独立编码。IPC 丢帧/停止收到视频/出口预算不足会反馈到原降级机制。最慢组可能影响整场画质；公平调度、坏组隔离和按画质动态扩容未实现。

最大 1 MiB 帧的封包/IPC 边界有单测；最后复核修正了“750 ms 总寿命短于限速发送时间”的确定性问题，改为有效片段间空闲 750 ms、绝对寿命最多 10 秒，内存配额不变。以虚拟到达时钟驱动真实 pacer/codec，1 Mbps 与 8 Mbps 最大帧均可重组验签，持续零碎片段也不能绕过绝对寿命。**这不是最大帧实时传输通过的证据。** 8 Mbps 下最大帧序列化仍超过 1 秒，现有 Viewer 过期阈值和原验收 p95 门槛均未放宽；最大帧可能被 Viewer 丢弃，必须以真实 VP8 关键帧、最高目标码率及公司设备测 G1，必要时再优化编码/桥接路径，不能把有界重组通过冒充实时性能通过。

## 5. 构建和试点安装

### 5.1 可复制的本机测试构建

仓库根目录 PowerShell：

```powershell
.\scripts\Build-LanClient.ps1 -Origin https://127.0.0.1:8743
```

输出 `artifacts/lan-client/`：

- `extension/`：可供获批开发者加载/管理分发的 MV3 目录；不是已发布 Chrome Web Store 包。
- `native/webzoom-lan-host.exe`：Windows amd64 helper。
- `native/bundle.json`：origin、扩展 ID（无凭据）。
- `Install-LanHost.ps1`、`Uninstall-LanHost.ps1`。

此 origin 只供本机 fixture，**不能用于公司会议**。公司试点必须用批准的真实 HTTPS origin 重新构建，且保持与浏览器地址栏规范化 origin 一致，无结尾斜杠。

当前开发扩展 ID：`hmeoffkckocfjcblblfhpmjcighdehfa`。manifest 内是公开开发公钥，不是发布签名私钥。正式渠道必须重新确认固定 ID/签名和分发策略，并据此同时生成扩展与 helper allowlist；不将开发包称为已签名正式安装器。

### 5.2 获批后才能安装

1. IT 确认扩展分发、用户目录执行、nativeMessaging、指定程序/UDP 端口/接口的网络规则。不要关闭防火墙/EDR，不建议绕过执行策略。
2. 每台 LAN 收发端安装扩展 + helper；仅上传的共享者可以保持普通模式。
3. 在生成的包目录，用本机获批 IPv4 和统一获批 UDP 端口调用 `Install-LanHost.ps1 -InterfaceIP … -Port … -ApprovedByIT`。参数必须由现场确定，本文不虚构公司地址或端口。该开关只是确认，不等于取得 IT 审批。
4. 安装器仅写 `%LOCALAPPDATA%/WebZoomLAN` 和 `HKCU/Software/Google/Chrome/NativeMessagingHosts/com.webzoom.lan`。升级前退出 LAN 会议/Chrome host；在批准标准用户设备上另测升级和卸载。
5. 此试验仅支持**一个启用的非回环 IPv4 地址，掩码 /16–/30，有广播能力**；多网卡/VPN、IPv6-only、Wi-Fi、同机多个 LAN 会议和共享 UDP 端口不在支持范围。不能要求用户关闭公司强制 VPN 来迁就原型。
6. 经单独批准在隔离试验服务设置 `LAN_RELAY_ENABLED=true` 及核定预算。现有 Compose/OCP 配置没有被自动修改，单改示例 .env 不会把变量传入现有容器。
7. 登录会议，勾选“使用局域网…”；网页会刷新建立 LAN 控制连接。核对“中继/接收/不可用”状态、真实目的广播地址、每组服务器媒体数和退出停流。

回滚先暂停媒体、核算预算，再退出 LAN 模式或切回已验证版本，不能让全员瞬时恢复直连。卸载脚本只删除已确认注册位置和三份已知文件；扩展通过批准渠道另行移除。

## 6. 本轮验证记录

本段记录的是本机开发证据，不是公司验收。命令由仓库根目录执行，前端命令进入 web 目录。

| 项目 | 结果/范围 |
| --- | --- |
| 新路径 Go 包及相关服务测试 | `go test ./internal/lan ./internal/lanhost ./internal/meeting ./internal/server ./cmd/webzoom` 通过；覆盖 50 个模拟接收者只有一份 feed、挑战验证、密钥轮换、预算、转交、来源签名、认证 WSS、撤权。 |
| 真正 UDP socket | 新增 127.0.0.1 UDP 片段乱序重组、验签、重放/伪造拒绝测试通过；**不是两机广播测试**，没有向办公广播域发包。 |
| Go 静态检查 | `go vet ./...` 通过。 |
| 解析器短时模糊测试 | `FuzzDecode`、`FuzzNativeLength` 各 5 秒通过；仅是有限运行的开发测试，不等于协议安全审核。 |
| 最大帧限速/缓存边界 | 1/8 Mbps 虚拟到达时钟的最大帧重组验签、硬寿命、满容量探测缓存过期恢复测试通过；不是实际网络延迟测量。 |
| 全量 Go | Windows 下原有 `internal/bandwidth/TestFileStoreInitialConfigurationAndRestart` 因 POSIX 0600 与 Windows 权限表示不符失败；未屏蔽或修改该测试。Linux 全量/race/漏洞检查未在本轮远程执行。 |
| 前端类型/单测/构建 | 类型检查、36/36 项单测和生产构建通过；本机 Node 20.18 低于 Vite 建议 20.19+/22.12+，仍记录此警告。CI 保持 Node 22。 |
| 原有浏览器回归 | 62/62 通过，含批注请求、PiP、管理操作与会话续期。 |
| LAN 浏览器链路 | 2/2 模拟桥测试通过：真实测试 OIDC/TLS/WSS、真实 VP8/WebCrypto、选举与故障切换；native/广播为显式模拟。 |
| 扩展单测 | 3/3 通过：来源/顶层 frame/路径限制、端口生命周期、消息大小/命令限制。 |
| 真实 MV3 加载用例 | 已添加 `web/lan-tests/extension.spec.ts`；本机完整 Chromium 在 Node 20 与 bundled Node 24 下均在启动时返回 spawn UNKNOWN，未进入扩展加载断言。**未通过，未改成 skip 或模拟成功**；仍保留 Linux CI 检查。 |
| Windows helper 打包 | 本机测试 origin 可构建；没有安装、注册、签名发布或运行实际广播。 |
| PowerShell 脚本 | 构建/安装/卸载三份脚本 AST 语法检查通过；不等于安装、卸载或标准用户策略验收。 |
| 工作流/文档约束 | 本地现有 PyYAML 依赖下工作流安全规则 3/3、文档规则 3/3 通过；文档测试使用进程内 `PYTHONUTF8=1`，不修改系统编码。远程 CI 未执行。 |

新增 CI 检查保留原 race/vet/govulncheck/audit/镜像与漏洞发布门槛，并加 Windows helper 交叉构建、扩展单测与 LAN 浏览器测试。此处修改工作流**不等于已运行/通过远程 CI**。

## 7. 尚须完成、不得隐去的门槛

- **G0 未通过**：公司标准用户双机安装、真实广播、防火墙/EDR、接口变化、多 profile/端口占用；本轮只完成部分本地单测。
- **G1 未通过**：完整网页→真实 MV3→真实 helper→双机 UDP→WebCodecs；最高码率至少 30 分钟、最大帧、后台标签页、IPC 延迟、CPU/内存、短令牌长期续期。
- **G2 未通过**：独立封包安全审核、故障注入、实际网络丢包/乱序、应用获知撤权后的停流/换 key。FEC/NACK 未实现。
- **G3 未通过**：多广播域、真实 20 Mbps 计量、组/会议并发、中继故障恢复 p95、进退会风暴、公平性。现有监控保留实际 WSS 入出字节；专用 UDP/IPC/选举运维指标尚不完整。
- **G4 未通过**：审批的签名/分发/升级方案、两小时试点、接近 8 小时的会话到期、正式发布与回滚演练。

旧验收文档的 T01–T38 和原始性能门槛不放宽。后续应按其模板填写实际设备、版本、采样窗口、异常和证据。任一关键门槛失败就暂停上线，而不是把普通 TCP 回退或未审批的系统改动伪装成广播功能成功。

## 8. 主要源码位置

- `internal/meeting/lan.go`：分组、选举、租约、密钥、媒体准入。
- `internal/lan/`：签名封包、AEAD 分片、重组、防重放、IPC、pacing。
- `internal/lanhost/`、`cmd/lanhost/`：Windows helper 与 socket 边界。
- `clients/chrome/`：MV3、隔离桥、来源限制及单测。
- `web/src/lan.ts`：网页媒体桥/流控；`web/lan-tests/`：显式模拟链路及真实扩展加载用例。
- `scripts/Build-LanClient.ps1`、`Install-LanHost.ps1`、`Uninstall-LanHost.ps1`：构建和普通用户安装路径。
