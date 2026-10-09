# GitHub Actions、Docker Hub 与 GitHub Release

## 1. 发布流程

工作流文件：`.github/workflows/container.yml`。
镜像地址：`bobbynie/webzoom`，注册表为 Docker Hub。
首次发布只构建 `linux/amd64`。ARM64 节点不能直接使用此镜像。

1. 拉取请求执行 Go、前端、浏览器、工作流和容器测试，不发布镜像。
2. 推送到 `main` 或推送 `v*` 标签执行相同检查。
3. 所有检查成功后，发布任务检查 Docker Hub 凭据。
4. 发布任务下载本次运行中已经测试的镜像。
5. 发布任务校验镜像 ID 和默认用户。
6. 发布任务计算版本，并向 Docker Hub 推送同一镜像的标签。
7. 所有镜像推送成功后，发布任务创建或验证 Git 版本标签。
8. 发布任务创建 GitHub Release，并附上镜像摘要文件和自动生成的变更说明。

手动运行也受分支限制。只有 `main` 或稳定版本标签 `vMAJOR.MINOR.PATCH` 可以发布。
预发布标签和其他分支不能发布。其他分支的手动运行只执行检查。
发布任务不重新构建镜像。发布任务串行执行，避免同时分配同一版本。
旧提交不能创建新的 `main` 发布。请对当前 `main` 提交运行工作流。

检查包括 Go race、go vet、govulncheck、前端测试、生产构建、npm audit、
Chromium 测试、容器测试、Compose 配置和工作流策略测试。
这不是目标 OpenShift 集群验收，也不是正式容量验收。
旧 GHCR 镜像不自动删除。新流程不再向 GHCR 发布。

## 2. 自动版本和镜像标签

首次自动版本为 `v0.1.0`。后续自动版本在已有最高稳定版本上递增补丁号。
例如，最高版本为 `v0.1.0` 时，下一次成功发布使用 `v0.1.1`。
版本比较使用数字顺序。非稳定版本标签不参与自动版本计算。
主版本和次版本需要手动指定稳定版本标签。

| Docker Hub 标签 | 更新条件 |
|---|---|
| `vMAJOR.MINOR.PATCH`，例如 `v0.1.0` | 自动版本或手动稳定版本发布成功 |
| `sha-<完整提交 SHA>` | 对应提交通过发布检查 |
| `main` | 当前 `main` 提交成功发布新版本 |
| `latest` | 当前 `main` 提交成功发布新版本 |

Git 标签、Docker 版本标签和 GitHub Release 使用同一版本号。
手动 Git 标签发布不修改 Docker 的 `main/latest`，也不标为 GitHub 的 Latest Release。
既有 Git 标签必须指向本次测试的提交。发布任务不会覆盖其他提交的标签。

重跑已完成发布的同一提交时，流程复用原版本，不推送镜像，也不修改 Release。
镜像推送失败时，不创建 Git 标签或 Release。已成功推送的部分镜像标签可能仍然存在。
镜像全部推送成功后，如果 GitHub 操作失败，可以重跑以完成发布。
若失败操作遗留了草稿 Release，流程会停止。请先检查并处理该草稿，再重跑。

SHA 标签便于追溯，但注册表标签本身不是不可变对象。生产部署应使用镜像摘要。
发布任务的 Summary 和 Release 附件 `image-digest.txt` 显示已推送的准确镜像摘要。

## 3. 配置发布凭据

必要条件：你可以管理 GitHub 仓库 `BobbyNie/webzoom` 和 Docker Hub 仓库 `bobbynie/webzoom`。
Docker Hub 与 GitHub 的账号关联用于源码访问。它不能代替 Actions 的 Docker Hub 推送凭据。

警告：不要把令牌写入代码、部署清单、工作流日志或聊天内容。

1. 在 Docker Hub 确认目标仓库 `bobbynie/webzoom` 已建立。
2. 在 Docker Hub 账号设置创建 Personal Access Token（PAT，个人访问令牌）。
3. 给该令牌镜像读取和写入权限。发布流程不需要删除权限。
4. 打开 GitHub 仓库的 `Settings → Secrets and variables → Actions`。
5. 新建仓库 Secret `DOCKERHUB_USERNAME`，值为 `bobbynie`。
6. 新建仓库 Secret `DOCKERHUB_TOKEN`，值为 Docker Hub PAT。
7. 对当前 `main` 手动运行工作流，或重跑失败的发布任务。

缺少凭据或用户名不匹配时，发布任务明确失败，不创建 Git 标签或 Release。
此工作流使用仓库 Actions Secrets，不使用未声明的 Environment Secrets。

工作流的默认权限只有 `contents: read`。
只有发布任务拥有 `contents: write`，用于创建 Git 标签和 GitHub Release。
GitHub 操作使用本次运行的 `GITHUB_TOKEN`，无需另存个人 GitHub PAT。
使用该令牌创建的 Git 标签不会再次触发本工作流的 push 运行。
第三方 Actions 固定到完整提交 SHA。
拉取请求不使用 `pull_request_target`，也不访问 Docker Hub 推送凭据。

公开源码不等于允许匿名拉取镜像。在 Docker Hub 检查仓库可见性。
私有镜像需要部署环境的只读拉取凭据。不要把 CI 写入令牌用于生产拉取。
OpenShift 使用 `imagePullSecret`。不要把凭据写入仓库或部署清单。
内网无法访问 Docker Hub 时，先把已验证镜像复制到内部镜像仓库。

## 4. 非 root 运行

最终镜像使用 `scratch`，默认用户为 `USER 65532:65532`。
最终镜像不包含 shell、包管理器或编译工具。
构建阶段不属于部署镜像；构建阶段使用 root 不会使应用以 root 运行。

容器测试使用以下两种身份：

- 镜像默认的 UID/GID `65532:65532`。
- 任意 UID `1001230000`，GID `0`。

两种身份均在只读根文件系统、删除全部 capabilities、禁止权限提升的条件下运行。
GID `0` 表示组，不表示 UID `0`。应用不需要 root 用户。

OpenShift 清单不指定固定 UID，让集群分配允许范围内的 UID。
保留 `runAsNonRoot: true`、`readOnlyRootFilesystem: true`、
`allowPrivilegeEscalation: false` 和 `capabilities.drop: [ALL]`。
不要授予 `anyuid` 或 `privileged` SCC，也不要通过 UID `0` 修复文件权限问题。
外部 Secret 和证书必须对实际容器身份可读。

## 5. 使用发布镜像

必要条件：镜像已经发布，节点为 AMD64，并且集群能够读取该镜像。

1. 从成功发布的 Actions Summary 或 GitHub Release 复制镜像摘要。
2. 将 `deploy/openshift/deployment.yaml` 的占位镜像替换为以下形式。

```text
bobbynie/webzoom@sha256:<已验证的摘要>
```

3. 按 `docs/DEPLOYMENT.md` 配置 Keycloak、Secret、证书和 Route。
4. 在目标集群执行服务端 dry-run 和安全约束检查。
5. 部署一个副本，验证登录、共享和重连。
6. 按 `docs/CAPACITY.md` 执行正式容量验收。

Docker Compose 默认使用本地构建。若改用 Docker Hub 镜像，替换 app 的 `image`，
移除 app 的 `build`，并保留现有的非 root 和只读设置。
不得给 app 增加宿主机发布端口。客户端仍只通过 HTTPS/WSS 访问代理。

## 6. 本地验证工作流

先安装 ShellCheck 并确认它在 `PATH` 中。Actionlint 在找不到 ShellCheck 时会跳过 shell 检查。
GitHub 托管运行器包含 ShellCheck；本地检查必须包含同一检查阶段。
以下命令从仓库根目录执行。

```sh
python3 -m venv /tmp/webzoom-workflow-venv
/tmp/webzoom-workflow-venv/bin/pip install -r .github/tests/requirements.txt
/tmp/webzoom-workflow-venv/bin/python -m unittest discover -s .github/tests -v
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -color
docker build -t webzoom:local .
go test -count=1 -tags deploymenttests -v ./internal/deploy
```

版本分配、发布权限、错误保护和重跑行为使用测试驱动开发。
测试覆盖版本排序、旧提交拒绝、标签冲突、annotated tag、摘要校验和已发布版本的只读重跑。
容器测试验证已有的非 root 运行能力，不代表已经在真实 OpenShift 集群运行。
