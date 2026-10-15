# LAN UAT 交付与部署

版本：lan-uat-20261015-r1。只有 Release 附件中的成功 CI 记录及校验和能证明对应二进制已通过检查；本文中的版本字样不是发布成功声明。

## 交付组成

- 同一提交、同一次成功 CI 的 Linux/amd64 非 root 服务端镜像归档 webzoom.tar.gz 与 image-id.txt。
- 同轮 Windows CI 的 WebZoom-LAN-Setup.exe，内含 Chrome MV3 扩展和 native helper。现场配置版，不是禁止安装的 TestOnly 包。
- SHA256SUMS、release-metadata.json、ci-run.json、部署与回退脚本及说明。
- 企业私有地址、现场部署导出、凭据不进入公开仓库或附件；公司专用指令另存用户本地。

## 正确顺序

1. 公司 Linux/Podman 机器下载并核对本版 Release 校验和；按 image-id.txt 指定的精确 config ID 检查 Linux/amd64、65532:65532、revision；再搬运到公司测试仓库。config ID 不是 registry manifest digest；保留 push 输出中的 digest。
2. 公司 Windows PowerShell 已登录 oc、当前没有会议时，运行配套 Deploy-LanUat.ps1，传入刚推送的独立测试镜像、唯一备份路径和 -EnableLan。脚本实际读取并检查旧部署，只原子更新镜像及显式请求的 LAN_RELAY_ENABLED=true。不会重新 apply YAML、改 Route/SSO/CA/PVC/安全策略。省略 -EnableLan 就是纯镜像更新。
3. 所有试点电脑安装同一份 EXE，填写相同的实际 HTTPS 网站来源和 IT 批准的 UDP 端口。空白配置不能安装；没有凭据输入。只接受一个活动 IPv4 广播网卡，多网卡/VPN 情况让 IT 处理，不关闭强制安全措施。
4. 经 IT 批准加载安装后的 Chrome 扩展目录（安装器有打开按钮），插件本机检查通过后再测会议。受管 Chrome 禁止本地扩展或未签名 EXE 时由 IT 批准试点渠道，不绕过策略。辅助程序是每用户安装，无系统服务、无管理员权限。

## 回退

同一 Windows 账号运行 Deploy-LanUat.ps1 -Rollback -BackupPath 同一个备份文件。脚本恢复实际旧镜像与本次改动前的 LAN 开关，保留其他现有配置。即使新 rollout 不健康也能发起回退；若 Deployment 被重建、镜像或 LAN 设置已被他人改动则拒绝覆盖。旧镜像必须仍在仓库，备份不可覆盖，镜像/开关记录不是 PVC 数据备份。冲突/失败后保留备份并先诊断，不反复重建部署。

## 三台公司电脑快速验收

- A：普通模式创建会议并共享，不勾 LAN。B/C：同一获批局域网、各自账号入会，勾选「使用局域网 UDP 分流」。
- 页面底部必须显示本版版本。B/C 应出现一个中继与一个接收端，二者能看到 A 的实时画面。若二者各自中继或探测失败，不能认为广播分流成功。
- 真实操作 PPT/Excel，确认画面、申请/撤销批注、主持人小窗及 SSO/admin 正常；检查服务端媒体订阅及出口是否符合实际组数。
- 让中继退出，观察剩余端重新探测/选举、画面恢复或明确失败；不能出现所有端静默转为直连。
- 本机检查不发广播；其通过不代表上述跨机链路通过。大帧、丢包、跨 VLAN、总出口、人数、长时间稳定性仍需按原验收门槛测试，不能以本次 CI 代替。

## 范围

这是可部署到已批准 UAT 的试点包，不是公司全员生产发布。EXE 未签名，当前 overlay 包不支持后补 Authenticode 签名；需要签名分发时须另做格式支持并重测。服务端只通过 HTTPS/WSS 到达客户端，OCP 不向办公网发 UDP；UDP 在获批客户端网段内使用。默认开关关闭，测试脚本显式开启。LAN 默认媒体预算 16 Mbps，不能据此宣称所有协议及公司出口总流量已验收低于 20 Mbps。
