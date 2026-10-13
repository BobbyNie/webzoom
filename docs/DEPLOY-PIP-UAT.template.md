# WebZoom 纯网页反馈小窗 UAT：部署与回退

- Release 标签：`__RELEASE_TAG__`
- 提交：`__COMMIT__`
- 分支：`feature/presenter-feedback-pip`，不是正式 stable，不改 main。
- 已测试镜像 config ID：`__IMAGE_ID__`（不是推送后 registry manifest digest）
- 平台：linux/amd64；归档中标签：`webzoom:local`。
- 构建与检查：__RUN_URL__

本版不需要下载 EXE、浏览器插件或新建 SSO。升级会中断现有会议，请安排空闲时段。只更新既有 UAT 的镜像，不重建 namespace、Secret、SSO client、Route 或证书。

## A. 能访问外网的公司 Linux：下载 Release 镜像

沿用已批准的 Podman，不需要在公司 Windows 装 Docker。不要下载 GitHub 自动生成的 Source code ZIP 来代替镜像。

```bash
set -euo pipefail
mkdir -p ~/webzoom-__RELEASE_TAG__
cd ~/webzoom-__RELEASE_TAG__
BASE='https://github.com/BobbyNie/webzoom/releases/download/__RELEASE_TAG__'
curl -fL "$BASE/webzoom.tar.gz" -o webzoom.tar.gz
curl -fL "$BASE/image-id.txt" -o image-id.txt
curl -fL "$BASE/SHA256SUMS.txt" -o SHA256SUMS.txt
grep -E '  (webzoom.tar.gz|image-id.txt)$' SHA256SUMS.txt | sha256sum -c -
podman load -i webzoom.tar.gz
podman image inspect docker.io/library/webzoom:local --format '{{.Id}} {{.Os}}/{{.Architecture}}'
ACTUAL=$(podman image inspect docker.io/library/webzoom:local --format '{{.Id}}')
EXPECTED=$(tr -d '\r\n' < image-id.txt)
test "${ACTUAL#sha256:}" = "${EXPECTED#sha256:}"
```

如果公司 Linux 不能直接访问 GitHub Release 的附件地址，在可访问电脑下载这些文件并按公司批准方式传入，再校验并 load。不要关闭 HTTPS 校验来绕过 GitHub 证书问题。

## B. 推到公司 JFrog

下面两个占位符替换成原先成功推送的仓库；不要把 Access Token 写进文档、命令历史或 GitHub。

```bash
REGISTRY='你的JFrog域名'
REPO="$REGISTRY/你的Docker仓库/webzoom"
TAG='__RELEASE_TAG__'
IMAGE="$REPO:$TAG"
podman login "$REGISTRY"
# Username 输入实际账号，Password 提示中输入 JFrog Access Token。
podman tag docker.io/library/webzoom:local "$IMAGE"
podman push --digestfile=webzoom-new-digest.txt "$IMAGE"
DIGEST=$(tr -d '\r\n' < webzoom-new-digest.txt)
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]
printf '%s@%s\n' "$REPO" "$DIGEST" | tee webzoom-new-image.txt
```

保留 `webzoom-new-image.txt`。OCP 使用这里的完整 `仓库/webzoom@sha256:...`，不是上面的镜像 config ID。

JFrog 私有 CA：优先配置 IT 批准的信任链；普通用户可以使用已批准的用户目录 CA：

```bash
# 目录由 IT 准备批准的 ca.crt；必要时也包含获批的客户端证书。
podman login --cert-dir="$HOME/company-registry-certs" "$REGISTRY"
podman push --cert-dir="$HOME/company-registry-certs" --digestfile=webzoom-new-digest.txt "$IMAGE"
```

只有公司明确批准此特定内网仓库临时不校验证书时，才在该仓库的 login/push 增加 `--tls-verify=false`。不修改全局配置，不对 GitHub/SSO/OCP关闭校验；该参数也不会改变 OCP 节点拉镜像时的证书信任。

## C. 已登录 OCP 的电脑：先保存回退信息（PowerShell）

以下沿用 namespace `webzoom-uat`、Deployment 和容器 `webzoom`。若由 GitOps 管理，请修改相应副分支配置并走平台流程，不直接覆盖。

```powershell
oc whoami
oc project webzoom-uat
$dep = oc get deployment webzoom -n webzoom-uat -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '无法读取 Deployment' }
$dep.spec | Select-Object replicas,strategy
oc get hpa -n webzoom-uat
if ($dep.spec.replicas -ne 1 -or $dep.spec.strategy.type -ne 'Recreate') {
    throw '请先按平台流程确认单副本 / Recreate；不要直接继续升级'
}
$oldImage = ($dep.spec.template.spec.containers | Where-Object name -eq 'webzoom').image
if (-not $oldImage) { throw '未找到 webzoom 容器，请核对名称' }
$oldImage | Set-Content -Encoding utf8 webzoom-before-pip-image.txt
oc get pods -n webzoom-uat -o custom-columns='POD:.metadata.name,IMAGE:.spec.containers[*].image,IMAGEID:.status.containerStatuses[*].imageID' | Tee-Object -FilePath webzoom-before-pip-pods.txt
oc rollout history deployment/webzoom -n webzoom-uat
```

确认没有针对 webzoom 的 HPA。记录旧镜像对应的实际 repository manifest digest，并确认旧版本在 JFrog 仍可拉取。若 Pod `imageID` 是完整 `repo@sha256:...`，可去掉 `docker-pullable://` 等前缀后作为不可变回退地址；不要把仅有的 config ID 当作 manifest digest。只有 tag 的回退依赖该 tag 未被覆盖，更新前先确认。

## D. 更新镜像（PowerShell）

将 Linux `webzoom-new-image.txt` 内容粘贴到变量。不应用旧整份 Deployment 清单，避免覆盖现有 SSO/Secret/CA 配置。

```powershell
$newImage = '这里粘贴实际推送后的完整仓库镜像地址，含@sha256:'
if ($newImage -notmatch '@sha256:[0-9a-f]{64}$') { throw '请使用实际推送得到的完整 digest 地址' }
oc set image deployment/webzoom "webzoom=$newImage" -n webzoom-uat
if ($LASTEXITCODE -ne 0) { throw '镜像更新失败' }
oc rollout status deployment/webzoom -n webzoom-uat --timeout=300s
if ($LASTEXITCODE -ne 0) { throw '上线未成功，请先诊断，不要开始验收' }
oc get pods -n webzoom-uat
oc logs deployment/webzoom -n webzoom-uat --tail=100
oc get route -n webzoom-uat
```

## E. 怎么用、怎么验收

1. 关闭旧 Windows 批注助手；刷新 WebZoom，必要时 `Ctrl+F5`。
2. 主持人创建会议，共享者选择业务窗口/标签页或整个屏幕。
3. 共享者点击“打开反馈小窗”，把小窗放在方便看到的位置。
4. 第二台电脑用不同账号加入，主持人点击该用户旁边的“允许批注”。
5. 对方选“画笔”或“指示光标”。共享者切回业务应用，看小窗中的圈、光点和姓名。
6. 用“跟随指示 ×2”放大查看，用“完整画面”恢复全景。
7. **整屏可能把小窗也共享出去并导致套娃**：优先共享业务窗口/标签页或把小窗移到未共享屏幕；必要时选择“仅标注”（无业务画面，只提供位置示意）。网页不能保证排除小窗。
8. 关闭小窗后共享应继续；停止/转交/结束/断线后小窗应关闭。撤权后对方不能继续标注。
9. 原应用中不会直接覆盖笔迹。快速滚动/切页时先停下来确认指示，清除旧笔迹；光点不会控制你的鼠标。

完整边界和验收表在 `PRESENTER_FEEDBACK.md`。自动测试并未证明公司浏览器的真实整屏排除、系统置顶或 SSO 策略兼容，必须实机验收。

## F. 回退

仍可回退。优先使用更新前确认的不可变旧镜像地址，不要默认回退到 v0.1.1，也不要覆盖旧 tag。

```powershell
$rollbackImage = '这里粘贴更新前确认仍可拉取的旧镜像完整地址'
oc set image deployment/webzoom "webzoom=$rollbackImage" -n webzoom-uat
if ($LASTEXITCODE -ne 0) { throw '回退请求失败' }
oc rollout status deployment/webzoom -n webzoom-uat --timeout=300s
```

若更新前保存的旧 tag 确认未被覆盖，也可从 `webzoom-before-pip-image.txt` 读取使用。无数据库迁移、无客户端安装，但回退同样会中断会议，不能恢复内存中的旧会议。`oc rollout undo` 会回退整个 Pod 模板，本步骤仅替换镜像，避免意外回退其他配置。
