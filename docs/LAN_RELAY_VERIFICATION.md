# LAN 中继方案：事实、可行性与逐项复核

> **2026-10-14 更新：** 本文保留 2026-10-12 的历史设计/计划状态。当前代码已在用户指定的独立分支实现试验版本，实际范围、测试结果和未通过的实机门槛以 [实现与重新评估](LAN_RELAY_IMPLEMENTATION.md) 为准；下文“尚未实现/未执行”描述当时状态，不代表新的验收结论。

- 日期：2026-10-12。
- 对应：[方案](LAN_RELAY_PROPOSAL.md)、[验收计划](LAN_RELAY_ACCEPTANCE.md)。
- 源码基线：`6b7f5b1c8b0ca11d954cc895b9745b3a6e58d225`。
- 本文是静态设计复核，不是独立第三方审计，也没有执行公司终端、真实 UDP 或生产容量试验。

## 1. 如何理解“可实现”

使用以下状态，避免把假设写成事实：

- **F：已确认事实**。从指定源码或官方文档中能直接确认，但不外推到用户环境。
- **D：拟议设计**。有可用技术基础，尚未实现或验证性能。
- **E：环境待验证**。取决于公司策略、设备、网络或部署条件。
- **G：上线门槛**。必须取得测试/审批证据；现在不能标记通过。

结论是 **“已有可行的技术路线，适合先做受控 PoC”**，不是“每个细节都已经在公司电脑上跑通”。任何文档都无法代替这些实测，也不能保证尚未编写的软件没有缺陷。

## 2. 当前项目事实

源码链接固定在上述提交，以避免主分支变化后证据漂移。行号为核对时位置，函数名是主要定位方式。

| 编号 | 断言 | 状态与证据 | 对方案的约束 |
| --- | --- | --- | --- |
| B01 | 原项目不使用 UDP/WebRTC | F；[README](https://github.com/BobbyNie/webzoom/blob/6b7f5b1c8b0ca11d954cc895b9745b3a6e58d225/README.md) | LAN 是新功能，不能用环境变量凭空启用 |
| B02 | 服务逐观众投递媒体 | F；[Hub.Publish，328–370行](https://github.com/BobbyNie/webzoom/blob/6b7f5b1c8b0ca11d954cc895b9745b3a6e58d225/internal/meeting/hub.go#L328-L370) | 必须改变 fan-out 对象，而非只改客户端 |
| B03 | 实际每个连接写 WSS 媒体 | F；[server.go](https://github.com/BobbyNie/webzoom/blob/6b7f5b1c8b0ca11d954cc895b9745b3a6e58d225/internal/server/server.go) `write`/`p.Media.Notify` | 普通成员只保留控制；中继才订阅媒体 |
| B04 | 最高目标是6 Mbps，最低现有档位1.2 Mbps | F；[quality.ts](https://github.com/BobbyNie/webzoom/blob/6b7f5b1c8b0ca11d954cc895b9745b3a6e58d225/web/src/quality.ts) | “每人1 Mbps”未测；不能当当前固定值 |
| B05 | 一身份同一会议只有一个 Peer | F；[Hub.Join，142–159行](https://github.com/BobbyNie/webzoom/blob/6b7f5b1c8b0ca11d954cc895b9745b3a6e58d225/internal/meeting/hub.go#L142-L159) | helper不能再带同用户身份连接现有会议WS |
| B06 | 原始完整帧最多1 MiB，头32字节 | F；[frame.go](https://github.com/BobbyNie/webzoom/blob/6b7f5b1c8b0ca11d954cc895b9745b3a6e58d225/internal/media/frame.go) | UDP和Native Messaging都需要独立分块 |
| B07 | 超过1000 ms的帧过期，序列缺口需关键帧恢复 | F；[protocol.ts](https://github.com/BobbyNie/webzoom/blob/6b7f5b1c8b0ca11d954cc895b9745b3a6e58d225/web/src/protocol.ts) | 无界重试/缓存会使现有解码路径失效 |
| B08 | 媒体队列初始8帧/2 MiB，写超时1秒 | F；[hub.go](https://github.com/BobbyNie/webzoom/blob/6b7f5b1c8b0ca11d954cc895b9745b3a6e58d225/internal/meeting/hub.go)、[server.go](https://github.com/BobbyNie/webzoom/blob/6b7f5b1c8b0ca11d954cc895b9745b3a6e58d225/internal/server/server.go) | pacing、IPC和关键帧突发要联合测试 |
| B09 | 客户端控制消息上限4096字节、每秒20条 | F；[PROTOCOL](https://github.com/BobbyNie/webzoom/blob/6b7f5b1c8b0ca11d954cc895b9745b3a6e58d225/docs/PROTOCOL.md) | 分组、探测、心跳不能无约束挤占控制通道 |
| B10 | 活跃会议可以续期，但无即时SSO backchannel logout | F；[PROTOCOL](https://github.com/BobbyNie/webzoom/blob/6b7f5b1c8b0ca11d954cc895b9745b3a6e58d225/docs/PROTOCOL.md)、README | 保持现有失效检测边界，不宣称新增即时撤销 |
| B11 | 单实例、Recreate、状态在内存 | F；[deployment.yaml](https://github.com/BobbyNie/webzoom/blob/6b7f5b1c8b0ca11d954cc895b9745b3a6e58d225/deploy/openshift/deployment.yaml)、README | 不增加副本；重启仍中断会议 |
| B12 | 当前仅共享屏幕、不采集音频 | F；[media.ts](https://github.com/BobbyNie/webzoom/blob/6b7f5b1c8b0ca11d954cc895b9745b3a6e58d225/web/src/media.ts) | 不把方案描述成已支持音视频会议 |

## 3. 浏览器和安装可行性复核

| 编号 | 核对问题 | 结论 | 依据/未决条件 |
| --- | --- | --- | --- |
| C01 | 纯普通MV3扩展能否直接使用旧UDP API？ | F：不能把Chrome Apps API当普通扩展API | [C6]标明旧Apps平台；新型[IWA：C7]是独立方案，不能混淆 |
| C02 | 扩展能否启动/连接本地辅助程序？ | F：有Native Messaging官方机制 | [C1]；程序须单独安装且可被政策允许 |
| C03 | 是否必须写HKLM或以管理员身份注册？ | F：官方支持HKCU用户级注册 | [C1]；E：企业可能禁用用户级host，仍需实机验收 |
| C04 | 网页能否向扩展建立连接并双向收发？ | F：允许的网页可通过外部消息机制连接 | [C3][C4]；D：精确origin、顶层页面和会议连接绑定 |
| C05 | 媒体能否直接作为ArrayBuffer跨Chrome扩展消息桥？ | F：Chrome消息API使用JSON序列化 | [C3]；D：采用base64分块，不宣称零拷贝 |
| C06 | 单条Native Messaging可否容纳最大媒体帧？ | F：host→Chrome上限1 MB；整帧base64会超限 | [C1]与B06；D：48 KiB原始块、96 KiB JSON上限 |
| C07 | 是否只要打开网页port就能让MV3永远运行？ | F：不能如此保证；native port有专门存活语义 | [C2]；D：`connectNative`、断开清理/重连；浏览器退出/崩溃仍会中断 |
| C08 | 普通用户可否双击公司自托管CRX正式安装？ | F：Windows/macOS自托管依赖企业策略 | [C8]；Web Store是另一条路线。开发者模式不是正式发布方案 |
| C09 | 插件和helper能否保证目标码率与低延迟？ | D/G：API可行不等于吞吐达标 | G1须真实VP8、后台运行、关键帧突发、资源测量 |
| C10 | helper是否需要公司SSO token或另开会议WS？ | D：本方案不需要 | 通过已有浏览器会话桥接媒体和控制；避免B05冲突 |
| C11 | 是否需要localhost TLS证书、禁用浏览器安全功能？ | D：所选桥方案不需要 | 未采用本地HTTP/WS服务器；替代通道需要另行评审 |
| C12 | Windows Native Messaging协议和LAN协议字节序相同吗？ | F：不能混用 | [C1]的32-bit长度使用native byte order；现有WZ01数字为网络字节序 |

## 4. 网络、容量与安全逐项复核

| 编号 | 核对问题 | 结论 | 依据/未决条件 |
| --- | --- | --- | --- |
| N01 | 广播是否可覆盖任意公司网段？ | F：不能这样推断 | [N1]；D：OCP为不同组分别供流，不要求跨网段广播路由 |
| N02 | 同一IP前缀就能判定互通？ | D：只作为候选，必须实测发送者→接收者 | 重叠地址、终端隔离、多网卡；小包可达≠视频容量达标 |
| N03 | 广播是否只到参会电脑？ | F：不是 | [N1]；媒体需加密；非参会设备和网络仍有处理成本 |
| N04 | 标准用户程序可使用UDP广播吗？ | F：Winsock提供datagram + SO_BROADCAST机制；不是raw socket方案 | [W2][W3]；E/G0：公司防火墙、EDR和应用策略是否允许 |
| N05 | 免管理员安装能否代替防火墙放行？ | F：不能 | [W1]；标准用户不能靠应用弹窗创建所需规则，应由IT预置 |
| N06 | 可以直接发1 MiB UDP包吗？ | F：不能按本方案这样发送 | [W3][N2]；D：1200字节payload上限、应用分片和有界重组 |
| N07 | 1200字节是否绝对保证不发生IP分片？ | D：只是试验起点，不是保证 | [N2]；G0/G3测接口MTU、丢包和封装影响 |
| N08 | IPv6-only是否也支持本广播方案？ | F：不支持IPv4广播的同一模型 | [W2]明确IPv6没有SO_BROADCAST；IPv6方案另立范围 |
| N09 | Windows多网卡是否可以明确接收接口？ | F：有WSARecvMsg/IP_PKTINFO能力 | [W5]；D/G0：具体Go实现、绑定和接口切换待测试 |
| N10 | 端口冲突能否用SO_REUSEADDR随便解决？ | F：不能把复用当独占和可靠分发保证 | [W4]；D：初版一个host独占，冲突可见 |
| N11 | 两组各多人是否只需两份OCP媒体？ | D：选择性订阅实现正确时成立 | 当前B02并不如此；G3用OCP计量点与每连接字节实证 |
| N12 | 总人数增加后系统网络流量完全不变？ | F：这种承诺不成立 | 媒体可按组增长；会议状态、组密钥、控制与重连仍随成员变化 |
| N13 | 20 Mbps能支持无限组/任意并发会议？ | F：不能 | 必须累加所有中继、回退、上传口径、控制与开销 |
| N14 | 编码器目标值就是网络硬上限？ | F：不是 | B04、关键帧突发与协议开销；D：准入+调度；硬线速需平台支持 |
| N15 | UDP会自动可靠重传并控制拥塞？ | F：不会 | [N2]；D：pacing、缺片恢复、反馈限流；G3质量门槛 |
| N16 | 只做AES组加密能证明画面来自共享者？ | F：不能，组员也持有对称密钥 | D：OCP验证发布权并对帧做独立源签名；安全审计G4 |
| N17 | GCM nonce能否在同一key下重复？ | F：不能 | [S1]；D：按generation换key、单调counter、重启换key |
| N18 | ECDSA/GCM是否已有标准实现？ | F：Go标准库提供相关原语 | [S1][S2]；D/G：封包、互操作、公司合规、实际性能未验证 |
| N19 | 只让旧客户端清屏是否足以撤销接收？ | D：不能作为安全机制 | 必须停止供流/轮换后续媒体密钥；无法撤回历史录包 |
| N20 | 全员持有会议链接是否等于审批制访问？ | F：当前不是 | B10对应文档明确当前访问模型；不凭空增加承诺 |
| N21 | 重新选举是否能保证没有一个旧UDP包？ | D：不能保证物理零残包 | generation/密钥隔离确保不接受旧流；切换流量仍需预算 |
| N22 | 切回旧版本是否可以让所有人立即直连？ | D：不能无条件这样回滚 | 应先停媒体、核实预算/人数，否则重新打满20 Mbps |

## 5. 复核中发现并修正的设计风险

以下不是“未来再想”，已落实到方案或验收门槛：

1. **纯扩展UDP假设**：改为用户级helper，明确Chrome Apps/IWA不是普通MV3接口。
2. **Windows扩展分发误解**：区分用户级helper安装、Web Store、企业自托管策略，不写“双击任意CRX即可”。
3. **最大帧超过Native Messaging限制**：定义双向base64分块和JSON硬上限；不直接透传最大帧。
4. **双连接踢人/冲突**：helper不另连原有会议WS，所有身份控制沿用浏览器已有连接。
5. **所有人仍接收OCP媒体**：必须修改服务端订阅/队列逻辑，不能只在UI切换播放源。
6. **组密钥伪造共享者内容**：引入独立来源签名，避免把保密与发布者认证混为一谈。
7. **撤权后旧key仍能解密**：把成员变化和重新选举的密钥轮换列为必须项，不仅清屏。
8. **IP前缀误分组**：采用实际可达性关系，换中继重新验证，不假设互通关系可传递。
9. **广播失败引发回退风暴**：默认拒绝无预算回退，兼容旧客户端不等于无限直连。
10. **全局锁里限速/签名**：规划异步分发和有界任务队列，不在Hub锁内等待；移出锁后须在投递前再次核对epoch/generation，防止转交竞态。
11. **新增封装突破读写限制**：上行WZ01保持1 MiB限制；下行LAN签名外壳有独立小额上限。更新对应接收代码/测试，不放宽所有接口限制。
12. **MV3后台/IPC被媒体淹没**：明确native port生命周期、credit流控和控制优先级；后台标签页列为G1阻断项。
13. **公网仓库泄漏环境信息**：文档仅含通用20 Mbps需求和公开依据，不发布内部域名、IP、账号、日志或凭证。

## 6. 尚不能验证的事项与责任

| 待确认项 | 谁提供证据 | 阻断阶段 |
| --- | --- | --- |
| 20 Mbps的计量点、方向、窗口、是否共享 | 网络/OCP运维 | G0和容量设计 |
| 托管Chrome版本、扩展发布途径、用户级host允许策略 | 终端IT | G0 |
| 用户可写目录可执行、签名/应用控制、无需UAC | 终端IT + 开发PoC | G0 |
| 广播/防火墙规则、批准接口和端口、终端隔离 | 网络/终端IT | G0 |
| 真实终端IPC/VP8吞吐、后台标签页、资源 | 开发 + 测试 | G1 |
| UDP丢包/恢复效果、多网卡、选举覆盖 | 开发 + 网络测试 | G2/G3 |
| 封包/密码格式、固定向量、nonce轮换、安全审计 | 开发 + 安全团队 | G2/G4 |
| 期望组数、人数、并发会议、画质、无线是否纳入 | 业务 + 运维 | G3/G4 |
| 大规模会议控制流量、密钥轮换风暴 | 开发 + 测试 | G3 |

不能用“领导允许普通用户安装”把整张表自动勾成已通过。该许可解决的是产品方向，不能代替策略与网络的实际效果。

## 7. 官方参考资料

以下页面在2026-10-12通过HTTPS实际读取。链接是证据索引，不表示官方为本项目性能或公司环境背书。只引用其明确范围；旧Chrome Apps页面的过期生命周期提示不作为当前支持日期依据。

- **[C1]** Chrome：[Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)。HKCU、allowed_origins、JSON/长度前缀及消息大小。
- **[C2]** Chrome：[Extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)。native port与生命周期；不是浏览器永不退出保证。
- **[C3]** Chrome：[Message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)。JSON序列化、网页与扩展消息。
- **[C4]** Chrome：[externally_connectable](https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable)。获准网页匹配。
- **[C5]** Chrome：[Alternative extension installation methods](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)。外部安装机制及其平台限制。
- **[C6]** Chrome Apps：[chrome.sockets.udp](https://developer.chrome.com/docs/apps/reference/sockets/udp)。仅用于辨别旧Apps API，不作为本项目实现依据。
- **[C7]** Chrome IWA：[Direct Sockets](https://developer.chrome.com/docs/iwa/direct-sockets)。不同应用模型的替代方向。
- **[C8]** Chrome：[Distribute your extension](https://developer.chrome.com/docs/extensions/how-to/distribute)。Windows/macOS自托管的企业策略前提。
- **[W1]** Microsoft：[Windows Firewall rules](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules)。标准用户、预置规则、策略合并和显式阻断。
- **[W2]** Microsoft：[Socket Options](https://learn.microsoft.com/en-us/windows/win32/winsock/socket-options)。SO_BROADCAST及IPv6边界。
- **[W3]** Microsoft：[sendto](https://learn.microsoft.com/en-us/windows/win32/api/winsock2/nf-winsock2-sendto)。广播socket选项、datagram大小、错误行为。
- **[W4]** Microsoft：[SO_REUSEADDR and SO_EXCLUSIVEADDRUSE](https://learn.microsoft.com/en-us/windows/win32/winsock/using-so-reuseaddr-and-so-exclusiveaddruse)。端口冲突与独占行为。
- **[W5]** Microsoft：[IP_PKTINFO](https://learn.microsoft.com/en-us/windows/win32/winsock/ip-pktinfo)。Windows接收包信息。
- **[N1]** RFC Editor：[RFC 919 — Broadcasting Internet Datagrams](https://www.rfc-editor.org/rfc/rfc919)。广播模型；不是当前公司网络配置的证明。
- **[N2]** RFC Editor：[RFC 8085 — UDP Usage Guidelines](https://www.rfc-editor.org/rfc/rfc8085)。拥塞、大小与分片等应用设计边界。
- **[S1]** Go：[crypto/cipher](https://pkg.go.dev/crypto/cipher)。AEAD/GCM和nonce要求。
- **[S2]** Go：[crypto/ecdsa](https://pkg.go.dev/crypto/ecdsa)。标准签名原语；不是自定义协议已经安全的证明。

## 8. 本次实际完成与未完成

已完成：读取上述源码；刷新远程main并固定基线；读取官方文档；核对设计与现有一用户一连接/续期/媒体边界；整理需求、方案、风险和验收清单。

未完成：客户端编码、签名安装包、真实Chrome扩展安装、普通用户UDP试验、跨网段会议、20 Mbps实测、漏洞/密码审计和公司审批。文档静态检查结果单独记录在交付说明，不能记为G0–G4通过。
