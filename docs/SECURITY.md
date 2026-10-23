# 安全检查与 CVE 修复

## 2026-10-21 本地续查与 Go 补丁（当前分支）

下文 2026-10-12 表格是历史结果，不能解释为 Go 1.26.9 在今天仍无已知漏洞。Go 官方漏洞库于 2026-10-21 00:27:29 UTC（澳门时间 08:27:29）发布 `GO-2026-6809` / `CVE-2026-111943`，涉及 `crypto/x509` 对已失信中间证书的处理；Go 1.26 分支修复版本为 `1.26.10`。

本轮显式指定 `GOTOOLCHAIN=go1.26.9` 的 `govulncheck v1.8.0` 报告该可达标准库问题。仓库的 `go.mod` 工具链和 Dockerfile 后端编译器均已更新为 Go `1.26.10`；官方 `golang:1.26.10-alpine` 清单原始字节的 SHA-256 与 registry 返回的摘要一致，并确认包含 Linux/AMD64。Dockerfile 固定摘要为 `sha256:9ce231b28998b32e116927c61aa5c406183061d4f3f2d61b292c88e7f6bdf7ca`，未猜测镜像哈希。

随后使用实际 Go `1.26.10 windows/amd64`：全部 8 个应用包测试、`go vet ./...` 和 `govulncheck v1.8.0 ./...` 通过，后者报告未检出已知漏洞。两套 npm 锁文件审计均为 0；发布规则检查 37 通过、1 项因缺真实 Trivy 跳过；actionlint 通过。

**本次只更新源码与构建配置，没有构建、扫描或发布新容器镜像，没有更新任何运行中的服务。** 不能用源码扫描代替 Linux/AMD64 候选镜像扫描，也不能据此说已运行服务的漏洞已修复。原生 15 分钟长测在更新 Go 之前执行；新工具链的回归结果单独记录。

本地原始证据位于 Git 忽略目录 `artifacts/relay-native-endurance-20261021/`，包含官方漏洞库 JSON、官方镜像索引、旧工具链检出报告与新工具链复扫结果。更多验证边界和长测发现见 [本地就绪检查](BROWSER_RELAY_LOCAL_READINESS_UAT.md)。

## 2026-10-12 历史检查

检查日期：2026-10-12。CVE 是公开漏洞的统一编号。
此报告区分源码依赖、构建工具、运行镜像和独立测试身份服务。
“未检出”仅表示本次扫描未匹配已知记录，不表示没有漏洞。

## 1. 结果

计数按不同漏洞编号去重。相同 CVE 可影响多个包，原始报告的记录数会更多。

| 范围 | 检查前 | 修复后或本次检查结果 |
|---|---:|---:|
| Go 源码，Go 1.26.9 | 未检出 | 未检出 |
| 前端应用依赖，包含开发依赖 | 0 | 0 |
| 项目锁文件，包含新增构建工具和 Python 依赖 | 0 | 0 |
| 原 Debian Node 构建基础镜像 | 132 | 新前端构建镜像 0 |
| 原 Debian Go 构建基础镜像 | 2775 | 新后端构建镜像 0 |
| Nginx 代理 | 2 | 新代理镜像 0 |
| 本机旧应用，Go 1.26.8 | 13 | 新应用镜像 0；旧运行容器未升级 |
| 本轮之前发布的应用，Go 1.26.9 | 0 | 未检出 |
| 独立测试 Keycloak 26.8.0 | 40 | 官方重建镜像仍有 34 |

原构建基础镜像为 AMD64。本机新应用、构建阶段和代理镜像为 ARM64。
GitHub Actions 另行扫描实际 Linux/AMD64 候选镜像，通过后才允许发布。
测试 Keycloak 的重建镜像已分别扫描 ARM64 和 AMD64。两者均为 64 条记录、34 个不同 CVE。
不要用一个架构的本机结果替代另一个架构的发布检查。

机器可读清单：`docs/security/2026-10-12-inventory.json`。
清单记录镜像 ID、架构、报告时间、报告 SHA-256、旧运行镜像问题和 Keycloak 剩余问题。
原始扫描 JSON 保存在被 Git 忽略的 `artifacts/security/`。它们不包含真实登录令牌或会话导出。

## 2. 已实施的修复

### 应用和构建镜像

- 应用保持 Go 1.26.9，最终镜像仍为 `scratch`。
- 原 Debian 构建镜像改为官方、digest 固定的最小 Alpine 镜像。
- 此更改移除不需要的构建系统包。它不表示逐项修补了所有原 Debian 包。
- 两个构建阶段安装 `zlib>=1.3.2-r1`。
- npm 固定到 `12.2.0`。它自带的依赖仍有漏洞，单独升级 npm 不足以通过镜像检查。
- `.github/security/npm/` 保留 npm 原始运行依赖，并单独锁定以下替换版本。

| 构建工具依赖 | 固定版本 |
|---|---|
| brace-expansion | 5.0.12 |
| http-cache-semantics | 4.3.0 |
| ip-address | 10.7.4 |
| postcss-selector-parser | 7.1.6 |
| undici | 6.28.1 |

Dockerfile 在 npm 的安装目录内使用该锁文件重新安装依赖。
每个下载包都有完整性校验值。没有删除有漏洞的依赖来伪造扫描结果。
前端应用依赖和会议功能没有改变。实际前端构建镜像复扫为 0 项。
CA 信任库的 MPL-2.0 声明随最终镜像交付。许可证记录见 `THIRD_PARTY_NOTICES.md`。

### Nginx

- 原代理包含 TIFF `CVE-2026-4775` 和 zlib `CVE-2026-85091`。
- 新官方基础 digest 已更新 TIFF。它仍需安装 zlib 修复包。
- `Dockerfile.proxy` 构建已修复的 `webzoom-proxy:local`。
- 代理最终用户为 `101:101`。安装补丁时使用的 root 不属于运行权限。
- Compose 使用该代理构建，不再直接运行原有未修复的 upstream 镜像。
- Docker Hub 自动发布的仍只有应用镜像。Compose 代理须按仓库配置单独构建。

### 旧运行应用

旧 `webzoom:local-demo` 容器使用 Go 1.26.8，有 13 条标准库 CVE 记录。
仓库和新构建镜像使用 Go 1.26.9。新镜像复扫未匹配这些记录。
本轮没有重启旧服务，所以不能把新镜像的结果用于证明旧服务已经修复。

## 3. Keycloak 剩余风险

本机测试清单更新到官方 Keycloak 26.8.0 重建 digest：

```text
sha256:27b3230fbabb8c9ff3c66c864cf09dcd8a41aca82e5100679d109ef0eeb05741
```

此重建移除原扫描中 6 个 glibc CVE 编号。仍剩 34 个不同编号：

- HIGH：3 个。
- MEDIUM：19 个。
- LOW：12 个。

剩余记录涉及 pcre2、glibc、OpenJDK、libgcc、sqlite 等系统组件。
所扫描镜像和当前数据库没有标注这些记录的修复版本。Java 应用依赖未检出。
这不等于这些漏洞一定可被 Keycloak 登录请求利用，也不等于风险可以忽略。
包存在性扫描不完成调用路径或利用条件分析。

全部编号、受影响包、版本、严重程度和官方公告引用见机器可读清单。
没有添加忽略列表，没有使用 nightly，也没有自行替换 Keycloak 的 Java 依赖。

此 Keycloak 只用于隔离的本机测试。入口保持 `127.0.0.1:8443`。
它不是用户已有的生产 Keycloak，不能保存真实敏感数据，也不能作为生产部署模板。
维护人员应继续核对供应商补丁，并在更新官方稳定镜像后重新扫描。
如果组织策略拒绝这些风险，应停止本机 Demo 身份服务。
生产环境继续连接组织维护的 Keycloak。该外部服务的实际版本和漏洞状态未在本轮验证。

## 4. 扫描和发布门槛

- Go：官方 `govulncheck@v1.8.0`。检查源码依赖和可达调用。
- npm：官方 `npm audit --audit-level=low`。应用和构建工具锁文件均检查。
- Trivy：固定 `0.75.0`。下载后先校验固定 SHA-256，再执行二进制。
- 镜像扫描：应用、前端构建阶段、后端构建阶段和代理。
- 严重级别：UNKNOWN、LOW、MEDIUM、HIGH、CRITICAL。
- 源码补充扫描包含开发依赖。镜像扫描检查实际安装的依赖。
- 扫描不跳过无补丁记录。扫描不使用隐式工作目录配置或漏洞忽略文件。
- 发现漏洞或扫描工具失败均阻止发布。某个镜像失败后仍继续检查其余镜像。
- 数据库下载失败会使任务失败。不存在离线失败后按“零发现”放行的流程。
- Actions 无论扫描成功或失败都尝试保存 `security-reports`，保留 14 天。
- 发布任务使用通过检查的同一个应用镜像，不重新构建。

外部测试 Keycloak 不在应用发布的零发现门槛中。
它未进入应用镜像，不是自动发布到 Docker Hub 的产物。
它的剩余风险在此报告中单独列明，不能把本门槛称为“全部测试环境无 CVE”。

GitHub 官方 Actions 公告分页检查共返回 56 条公告，覆盖工作流使用的 8 个不同 Actions。
匹配到 `GHSA-cxww-7g56-2vh6`。它涉及 `actions/download-artifact >=4.0.0,<4.1.3`。
本项目固定 v8.0.2 的完整 SHA，不在该公告的版本范围内。
此核对不覆盖 GitHub 运行器系统、整个 Action 的全部传递依赖或供应链攻击。

## 5. 重现检查

必要条件：Docker、Go 工具链、满足项目要求的 Node.js，以及可访问漏洞数据库的构建环境。
以下安装脚本只适用于 Linux/AMD64。其他主机须下载官方匹配架构的 Trivy，并校验其官方 SHA-256。
先按 `docs/CI.md` 安装 Python 测试依赖。
以下命令从仓库根目录运行，不会更新正在运行的服务。

1. 构建待测镜像。

```sh
docker buildx build --load --tag webzoom:local .
docker buildx build --load --target frontend --tag webzoom:frontend .
docker buildx build --load --target backend --tag webzoom:backend .
docker buildx build --load --file Dockerfile.proxy --tag webzoom-proxy:local .
```

2. 安装并核对扫描工具。

```sh
bash .github/scripts/install-trivy.sh /tmp/webzoom-trivy
TRIVY_BINARY=/tmp/webzoom-trivy/trivy python3 -m unittest discover -s .github/tests -p test_security.py -v
```

3. 扫描四个实际镜像。

```sh
python3 .github/scripts/scan_images.py /tmp/webzoom-trivy/trivy artifacts/security/recheck
```

4. 检查源码依赖。

```sh
go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...
npm audit --prefix web --audit-level=low
npm audit --prefix .github/security/npm --audit-level=low
/tmp/webzoom-trivy/trivy fs --scanners vuln --include-dev-deps --config '' --ignorefile /dev/null \
  --skip-dirs artifacts,web/node_modules,.git,.secrets --format json \
  --output artifacts/security/source-recheck.json --exit-code 1 .
```

5. 检查独立测试 Keycloak。当前快照预计会返回非零结果；不要忽略该结果。

```sh
/tmp/webzoom-trivy/trivy image --scanners vuln --config '' --ignorefile /dev/null \
  --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL --exit-code 1 --format json \
  --output artifacts/security/keycloak-recheck.json \
  quay.io/keycloak/keycloak:26.8.0@sha256:27b3230fbabb8c9ff3c66c864cf09dcd8a41aca82e5100679d109ef0eeb05741
```

6. 按 `docs/VERIFICATION.md` 执行功能和容器测试。

## 6. 更新正在运行的服务

**警告：服务重启会清空内存会议和登录会话。参与者会断开连接。**
本轮只构建、扫描和测试临时容器，没有更新正在运行的本机服务。

1. 确认所有会议已结束，并通知测试人员。
2. 更新代码和固定镜像配置。
3. 在构建和扫描成功后重新创建测试服务。

```sh
docker compose -f deploy/local/compose.yaml up -d --build --force-recreate
```

4. 重新登录测试账号。
5. 验证共享、听众播放、登录续期和管理员页面。

生产 OpenShift 只需部署通过发布门槛的应用镜像，并继续使用组织的生产 Keycloak。
目标集群的系统、网关、证书、浏览器和生产 Keycloak 不在本次本机漏洞扫描范围内。
本轮未执行生产容量验收、真实利用测试或完整人工安全审计。
