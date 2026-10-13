# 批注功能：副分支测试镜像与 OCP UAT

## 交付状态（2026-10-13）

- 功能与本地回归测试完成，代码位于 `feature/screen-annotation`。
- 当前改动尚未提交/推送，GitHub 上尚不能直接构建这些本地改动。
- 本机 Docker CLI 存在，但 Linux 引擎不可连接；没有启动 Docker、构建镜像或推送仓库。
- 因此下面是交付/验收步骤，不是已存在镜像的证明。不得直接填写一个猜测的标签去部署。
- 不能为了测试而合并 main、使用正式 `v*` Git 标签或覆盖现有稳定镜像标签。

## 为什么保持网页批注

核对日期：2026-10-13。已读取 Teams 官方正文：共享者可开启批注、选择仅自己或所有人可批注，参会人可请求开启批注，协作光标默认显示参会人姓名，并支持清除本人批注。各产品、平台和版本并非完全相同；这些交互原则不意味着网页具备原生客户端的系统桌面叠加能力。

WebZoom 参考上述交互原则，并按本项目需求由固定会议发起人逐个授权；逐人授权是本项目选择，不是宣称 Teams 采用完全相同的权限模型。当前不是这些产品所有功能的复刻，尤其不提供原生桌面叠加、系统级遥控或原文件编辑。

已读取正文的官方参考（下面的镜像发布策略与部署命令另外以本仓库实际配置为准，不假设公司的 OCP 版本）：

- Teams: https://support.microsoft.com/en-gb/teams/meetings-events/use-annotation-while-sharing-your-screen-in-microsoft-teams
- GitHub 手动选择分支运行工作流: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow

## A. 镜像制作（开发/发布人员执行）

有两条路径，都保持副分支不合并 main。

### 路径一：现有 GitHub Actions

1. 经授权，把已经检查的改动提交、推送到 `feature/screen-annotation`；不推正式版本标签。
2. GitHub Actions 选择 `Test and publish container`，点击 Run workflow，**明确选择 feature/screen-annotation**。
3. 等待 quality、image 两项都成功。image 会构建 Linux/amd64 镜像，并运行默认/任意 UID、HTTPS 代理的容器检查；quality 包含竞态检查。失败时不交付镜像。
4. 当前 `container.yml` 的 publish 仅允许 main 或 v* Git 标签。副分支手动运行的 publish 应跳过，不需要修改主分支或正式发布策略。
5. 下载该次运行的 `tested-container` artifact，含 `webzoom.tar.gz` 和 `image-id.txt`。当前保留期限 1 天，应及时转存公司批准的位置。
6. 在公司批准、可访问镜像仓库的机器上上传这份已经测试的镜像。**公司电脑不需要为此安装 Docker**：可以由批准的免安装 registry 客户端（例如 crane）上传 docker-save tar；或者由公司现有镜像导入流程处理。工具执行许可和仓库写权限仍是前提，不绕过终端安全策略。
7. 当前 artifact 是 `webzoom.tar.gz`：先去掉 gzip 外层得到 `webzoom.tar`，不是把镜像内部各层展开后随意重新打包，也不要把 `.tar.gz` 直接当作普通 tar 传给 crane。crane 官方 push 文档支持 docker-style tarball；已检查其 tarball 读取代码，普通 tar 读取器不负责解压整个 gzip 包。
8. 验证归档的 config hash 与 `image-id.txt` 一致，并在上传后核对远端 manifest 的 config digest；给镜像使用唯一 UAT 标签，记录远端 manifest digest。config/image ID 不是 registry manifest digest，两者不得混用。不得把 tar 当普通文件拖进 Docker 仓库后就认为它是可拉取镜像。
9. 如果受控机器已经有 Docker，也可使用 `docker load`、核对镜像 ID、tag/push；这是备用路线，不是公司电脑的必备条件。不要重建后冒充同一测试镜像。

已核对的免 Docker 上传工具参考：
- https://github.com/google/go-containerregistry/blob/main/cmd/crane/doc/crane_push.md
- https://github.com/google/go-containerregistry/blob/main/cmd/crane/doc/crane_auth_login.md
- https://github.com/google/go-containerregistry/blob/main/pkg/v1/tarball/image.go

crane 认证使用 `--password-stdin`，不要将 token 写进命令、日志或截图。没有凭据助手时会写入本地认证配置，须按公司要求保护并在操作后清理；`auth login` 写入凭据本身不能证明仓库鉴权和写权限成功。不要关闭 TLS 校验来解决公司 CA 问题。

手动运行需工作流在默认分支已配置 workflow_dispatch，并在界面选择待测副分支；本仓库已有该触发器。运行工作流需要仓库相应权限，镜像仓库写权限也须由公司批准；不把 JFrog token 或任何公司 Secret 配到公开示例、GitHub 文档或聊天中。

### 路径二：公司构建机

1. 从已经提交的副分支/固定提交构建，记录 commit SHA；不要从 main 构建而误以为包含新功能。
2. 运行项目检查。Linux 构建机应补齐 `go test -race ./...`，然后通过现有 Dockerfile 构建前后端一体镜像。
3. 对应现有 CI 的目标是 Linux/amd64；必须确认与实际 OCP worker 架构相符。其他架构不得未经容器测试就交付。
4. 候选本地标签可以使用 `webzoom:annotation-uat-<commit-sha>`。例如：

```sh
docker buildx build --platform linux/amd64 --load -t webzoom:annotation-uat-<commit-sha> .
# 容器测试当前固定检查 webzoom:local；只给同一镜像添加本地别名。
docker tag webzoom:annotation-uat-<commit-sha> webzoom:local
go test -count=1 -tags deploymenttests -v ./internal/deploy
```

`<commit-sha>` 是占位符，必须替换。容器检查会创建并清理测试专用容器，需要可用的 Linux Docker 引擎、空闲临时端口及下载测试代理镜像的权限；不在承载正式会议的机器上执行。Dockerfile 自带前端测试/构建和后端测试，但不等于完成竞态、完整浏览器和目标 OCP 验收。

5. 测试成功后把同一镜像 tag/push 到批准的公司仓库。使用一次性唯一 UAT 标签，交付完整镜像地址及仓库 digest，优先按 `@sha256:...` 部署。
6. 若交付的是镜像 tar，仍需由受控机器导入并推送 OCP 能拉取的仓库；不能把 tar 文件路径当作 Deployment image。

## B. 更新已有 UAT（OCP 操作人员执行）

前提：这是允许中断的 UAT，镜像已上传且可拉取。没有镜像时不要执行更新。若现有 UAT 有其他人会议，先预约空闲维护时间；需要完全保留旧 UAT 可另建隔离环境，但新的域名需要匹配 PUBLIC_URL 和 SSO 精确回调。

以下使用通用占位符，不是公司环境实际值。`<uat-namespace>`、`<deployment>`、`<container>`、`<actual-candidate-image>` 都必须替换。不要把占位符原样复制执行。

### 1. 只读预检和记录旧状态

```sh
oc whoami
oc get deployment <deployment> -n <uat-namespace> -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"="}{.image}{"\n"}{end}'
oc get deployment <deployment> -n <uat-namespace> -o jsonpath='{.spec.replicas}{" "}{.spec.strategy.type}{"\n"}'
oc rollout history deployment/<deployment> -n <uat-namespace>
```

记录旧镜像（最好是不可变 digest）和之前成功的 revision。只记录所需字段；不要公开导出 Secret 或整套可能含敏感环境值的配置。

保持项目单副本/Recreate设计，不能为避免中断而随意扩多副本。若实际对象是 DeploymentConfig、存在镜像变更触发器、GitOps 或流水线管理，先按照该管理流程更新，不能照抄下面的普通 Deployment 命令。

### 2. 仅更新镜像

```sh
oc set image deployment/<deployment> <container>=<actual-candidate-image> -n <uat-namespace>
oc rollout status deployment/<deployment> -n <uat-namespace> --timeout=300s
```

不覆盖现有 Route、TLS、SSO、Secret、镜像拉取凭据或资源配额。本功能没有新增环境变量、SSO client、realm role 或浏览器插件安装要求。

更新会重启进程，原会议与内存登录会话会消失；安排空闲时段并让测试用户重新登录。

### 3. 查看状态

```sh
oc get pods -n <uat-namespace>
oc get route -n <uat-namespace>
```

通过原 UAT HTTPS 地址重新登录并强制刷新网页，确保前后端来自同一新版本。rollout 成功只代表启动就绪，不代表功能验收。

若失败，先查看具体 Pod 的 Events；排查镜像不存在、拉取权限、镜像架构、启动及 OIDC discovery。日志/截图应脱敏，不提交 Cookie、令牌、授权码或 Secret。

## C. 手工测试（建议三个不同账号）

用三台电脑或三个独立浏览器用户配置，分别登录 A、B、C。不要用同一个 SSO 身份冒充多人；普通/隐私窗口可能复用或自动选择 SSO 身份，应确认页面显示的账号不同。

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | A 创建会议，分享静态 PPT/图片；B 加入 | A 可批注，B 只能观看 |
| 2 | A 对 B 点“允许批注” | B 出现画笔和指示光标工具 |
| 3 | B 画两笔，换颜色，移动指示光标 | A/B 同步看到画线和 B 的姓名 |
| 4 | C 在画线后加入 | C 可看到已有画线，但未授权不能画 |
| 5 | A 也画一笔；B 点“清除我的” | B 的画线清除，A 的保留 |
| 6 | A 点“清除全部” | A/B/C 的画线全部消失 |
| 7 | A 撤销 B；B 再尝试操作 | B 不可继续画；权限校验由后端执行 |
| 8 | 授权 B，改变浏览器大小、切全屏画线再退出 | 位置对应画面、不落在黑边；退出全屏按钮可用 |
| 9 | A 停止后重新共享 | 旧画线不残留；仍在线者的授权可保留 |
| 10 | 撤销 B，再把共享权转交给 B，B 开始共享 | B 不会因共享权自动获得批注权；A 仍可批注 |
| 11 | B 离开并重新进入 | 原授予 B 的批注权移除，需要重新授予 |
| 12 | 跨至少两个实际 SSO 短令牌周期持续使用 | 画面、登录和批注继续可用，或按组织 Max 策略结束 |

标注始终叠加在 WebZoom 网页共享画面上，不是固定在原文档内容上的批注；原窗口翻页/滚动后，应清除旧线再对新内容标注。共享者要看他人标注，应查看 WebZoom 预览；可以把原文档和网页分别放在两个屏幕/并排窗口，避免共享本应用画面造成镜像递归。

本机已通过浏览器测试，但本表仍需在目标 UAT 实测，特别是 Chrome/Edge、真实屏幕选择器、公司 SSO、多人并发与实际网络占用。

## D. 回退

只改镜像、没有其他部署更新时，可回到更新前记录的明确旧镜像（不要猜旧版本号）：

```sh
oc set image deployment/<deployment> <container>=<recorded-old-image> -n <uat-namespace>
oc rollout status deployment/<deployment> -n <uat-namespace> --timeout=300s
```

若用历史回退，应先核对 revision，再使用 `oc rollout undo deployment/<deployment> --to-revision=<recorded-revision> -n <uat-namespace>`；它回退整个 Pod 模板，不只是镜像，可能影响其他同期配置。回退也会中断会议和登录会话，并不能恢复原内存会议。
