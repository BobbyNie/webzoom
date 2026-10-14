# 公司 OCP 测试版发布与部署手册

这是后续维护者/编码代理必须先读的防错清单，不是重建部署模板。
实际环境的内部地址和可复制命令保存在用户工作区的本地部署记录，不上传公司凭据/私有部署导出。

## 已确认的协作约定

- 固定使用 `feature/presenter-feedback-on-leader-main`，不要每改一次就开一个分支。
- 领导 main 基线目前为 `2fc30468751a6802a934208fecbcdfb9f6cd3974`（2026-10-14 核实）。以后发布必须重新 fetch 核对。
- 测试版本使用独立后缀，目前申请批注候选版本是 `pip-uat-main-2fc3046-r2`。领导的正式 `v*`/`latest` 不动。
- 不要把“本地通过”“CI 已开始”“Release 已发布”“JFrog 已上传”“OCP 已部署”混为一谈，逐项报告实际完成状态。

## 两台机器，不要搞混

1. 能访问外网的公司 **Linux + Podman**：下载 GitHub Release 镜像包，核验、load、tag、push 到 JFrog。用普通用户，沿用该用户的镜像仓库，不加 sudo。
2. 公司 **Windows + PowerShell + oc**：更新现有 OCP Deployment。不能发 Bash 的 heredoc、反斜杠续行或 `export`。

用户已确认 JFrog 的 Podman login 和 push 都须带 `--tls-verify=false`；仅在本公司已批准的 registry 搬运步骤沿用，不推广为其他 TLS 检查的默认做法，也不修改 OCP 全局信任。用户私下输入账号和 Access Token，不能把 token 写入命令、文档或聊天。

## 发布闸门（必须全部完成）

1. 检查工作树和分支；明确 push 到上述功能分支。普通功能分支 push 不会自动触发 `container.yml`，须手动 dispatch 该分支。
2. 现有工作流原样执行：`Go, browser and workflow checks` 和 `Build and test non-root image` 均须成功。
   包含全量 Go race/vet/govulncheck、前端单测/构建/audit、Chromium、Trivy 及容器部署测试。
   Windows 的 POSIX 权限差异测试失败不能冒充 Linux 全量通过，须以 Linux CI 补齐；不能屏蔽测试或降低扫描门槛。
3. 只下载该最终提交同一成功运行的 `tested-container`：`webzoom.tar.gz` 和 `image-id.txt`。不要本地重建另一个镜像代替。
4. 核验 CI head SHA、两个 job、每个归档 blob SHA-256、config ID、revision/source labels、Linux/amd64、非 root `65532:65532`、内置前端测试版本。
5. 建立独立 prerelease，`--latest=false`，tag 指向通过的完整提交。附件保留归档、image ID、SHA256SUMS、release-metadata.json、ci-run.json、UAT-README.md。
6. Release 发布后再次核对目标提交、prerelease/非 latest 和附件。不得覆盖已发布 r1 归档或用源码 ZIP 冒充镜像。

镜像 config ID 不是 registry manifest digest。GitHub 测试版发布不表示它已在 JFrog 或 OCP。

## Linux 搬运

- 使用独立版本目录，避免误用旧归档。
- 从本版 Release 下载 `webzoom.tar.gz`，以本版核实过的 SHA-256 检查后才 load。
- load 后用本版精确 config ID inspect / tag，不依赖可被别的 load 覆盖的 `webzoom:local` 标签，不猜拼写。
- login 和 push 按用户批准的公司流程带 `--tls-verify=false`。
- 使用唯一测试标签；确认 push 成功并保留输出中的 registry digest，才能进行 OCP 更新。
- 任何一步失败就停止，不继续执行后面的 Windows 更新。

## Windows OCP：只换镜像

目前成功部署为 namespace `webzoom-uat`、Deployment/container `webzoom`。
每次实际部署仍读取现场状态，不把历史值当事实。

1. `oc whoami` 成功后确认目标 Deployment；身份失效先重新登录，不重新建资源。
2. 升级会中断当前会议，选择空闲窗口。要求旧 rollout 先健康，否则先诊断。
3. 用 `oc get ... -o json` + `ConvertFrom-Json` 解析，避免 Windows JSONPath 引号问题。每次 oc 非零退出必须停止。
4. 验证单副本/Recreate，容器唯一、`/data` 可写并连到既有 PVC；不自动修补或重建。
5. 读取当前**实际镜像**保存到 Windows 用户目录的本版专用 `.image.txt`。有备份则停止，不能覆盖；目标镜像已经健康时可幂等退出。
6. 只执行 `oc set image`，然后 rollout 等待，失败读取 pods/events/logs。不要为了修复拉镜像、挂载或登录问题重套旧 YAML。
7. 保留全部现有 SSO/client secret、ADMIN_USER_IDS、CA 挂载、Service/Route、pullSecret、环境变量、安全上下文、PVC。
   `/data` 的带宽持久化配置可能覆盖环境默认值，不能因升级重置。
8. 回退只读刚保存的真实镜像引用，再 set image + rollout。要求旧镜像仍存在且旧 tag 没被覆盖。

**镜像引用备份不是 PVC/业务数据备份。** 如有数据迁移，另做存储备份及兼容性评估。本次 r2 不改存储格式。
不要上传完整私有 Deployment 导出、Secret、SSO sub 或管理员名单。

## 公司验收（不能由合成测试代替）

- 确认页面版本；主持人 + A/B/C 三名观众，A/B 申请，主持人看到两人。
- 单独同意/拒绝/取消；一键同意只批准当前申请者，C 和后来的申请者不自动获权。
- 未授权不能画；获批后笔迹/姓名指示光标同步；撤权立即生效。
- 共享者主动“打开反馈小窗”，切回 Excel/PPT 看反馈。主持人审批在主会议页，不在小窗内。
- 小窗、停止/转交共享、SSO 续期、管理员页、带宽持久化和重启均回归。
- 小窗不是原应用透明覆盖层；要求可信 HTTPS 和浏览器策略允许 Document PiP。整屏共享存在小窗入镜风险。

## 分支清理审计（2026-10-14）

已核对以下四个分支的专有提交均由本轮用户的开发账号 HissRC 创建，而非领导分支：

| 旧分支 | 历史保留方式 |
| --- | --- |
| `feature/screen-annotation` | 既有 `annotation-uat-106e3b8` tag/Release |
| `feature/presenter-overlay` | 既有 `presenter-overlay-uat-fb123eb` tag/Release |
| `feature/presenter-feedback-pip` | 既有 `pip-uat-1c8fe6f` tag/Release |
| `docs/lan-relay-design` | 三份 LAN_RELAY 文档原样保留到当前分支；本地 Git bundle 保留完整分支历史 |

删除前须生成并校验本地 Git bundle，再验证远程 tip 没有在审计后变化。只删上述确认为废弃的分支名，不删 tags/Releases，不删当前分支/main。
LAN_RELAY 文档是早期设计归档，不是本版已经实现/验证的功能，不用于替换当前部署。
