# GitHub Actions 与镜像发布

## 1. 发布流程

工作流文件：`.github/workflows/container.yml`。
镜像地址：`ghcr.io/bobbynie/webzoom`。
首次发布只构建 `linux/amd64`。ARM64 节点不能直接使用此镜像。

1. 拉取请求执行 Go、前端、浏览器、工作流和容器测试，不发布镜像。
2. 推送到 `main` 或推送 `v*` 标签执行相同检查。
3. 所有检查成功后，发布任务下载本次运行中已经测试的镜像。
4. 发布任务校验镜像 ID 和默认用户，然后推送到 GHCR。

手动运行也受分支限制。只有 `main` 或 `v*` 标签可以发布。
发布任务不重新构建镜像。其他分支的手动运行只执行检查。

检查包括 Go race、go vet、govulncheck、前端测试、生产构建、npm audit、
七项 Chromium 测试、三项容器测试、Compose 配置和工作流策略测试。
这不是目标 OpenShift 集群验收，也不是正式容量验收。

## 2. 标签

| 标签 | 更新条件 |
|---|---|
| `sha-<完整提交 SHA>` | 对应提交通过发布检查 |
| `main` | `main` 分支成功发布 |
| `latest` | `main` 分支成功发布 |
| `v*`，例如 `v0.1.0` | 对应版本标签成功发布 |

版本标签发布不会修改 `latest`。
SHA 标签便于追溯，但注册表标签本身不是不可变对象。生产部署应使用镜像摘要。
发布任务的 Summary 显示镜像地址和摘要。

## 3. 权限和访问

工作流的默认权限只有 `contents: read`。
只有发布任务拥有 `packages: write`。它使用 GitHub 提供的 `GITHUB_TOKEN`。
无需保存个人访问令牌。第三方 Actions 固定到完整提交 SHA。
拉取请求不使用 `pull_request_target`，也没有包写入权限。

首次创建的 GHCR 包可能是私有包。公开源码不等于允许匿名拉取镜像。
在 GitHub 包设置中检查可见性。私有包需要部署环境的只读拉取凭据。
OpenShift 使用 `imagePullSecret`。不要把凭据写入仓库或部署清单。
内网无法访问 GHCR 时，先把已验证镜像复制到内部镜像仓库。

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

1. 从成功发布的 Actions Summary 复制镜像摘要。
2. 将 `deploy/openshift/deployment.yaml` 的占位镜像替换为以下形式。

```text
ghcr.io/bobbynie/webzoom@sha256:<已验证的摘要>
```

3. 按 `docs/DEPLOYMENT.md` 配置 Keycloak、Secret、证书和 Route。
4. 在目标集群执行服务端 dry-run 和安全约束检查。
5. 部署一个副本，验证登录、共享和重连。
6. 按 `docs/CAPACITY.md` 执行正式容量验收。

Docker Compose 默认使用本地构建。若改用 GHCR 镜像，替换 app 的 `image`，
移除 app 的 `build`，并保留现有的非 root 和只读设置。
不得给 app 增加宿主机发布端口。客户端仍只通过 HTTPS/WSS 访问代理。

## 6. 本地验证工作流

```sh
python3 -m venv /tmp/webzoom-workflow-venv
/tmp/webzoom-workflow-venv/bin/pip install -r .github/tests/requirements.txt
/tmp/webzoom-workflow-venv/bin/python -m unittest discover -s .github/tests -v
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -color
docker build -t webzoom:local .
go test -count=1 -tags deploymenttests -v ./internal/deploy
```

工作流策略测试先以缺少工作流的状态失败，再加入实现并通过。
容器测试验证已有的非 root 运行能力，不代表已经在真实 OpenShift 集群运行。
