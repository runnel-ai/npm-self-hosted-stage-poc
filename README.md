# self-hosted npm stage 最小复现

用自有 Linux 服务器的 GitHub Actions runner，在 Node 容器中上传一个无依赖的测试包；维护者在可信终端通过 2FA 批准，再验证公开安装。目标是确认这组服务器、npm 账号和权限配置下的发布链路可用。

组织仓库为私有的 [runnel-ai/npm-self-hosted-stage-poc](https://github.com/runnel-ai/npm-self-hosted-stage-poc)。2026-10-10 已在 `linux-runner-01` 的 Node 容器中完成首次 [pack](docs/validation-2026-10-10.md) 和真实 [stage 上传](docs/stage-validation-2026-10-10.md)：测试包为 `@airport233/ocr-stage-poc-test@0.0.1`，5 项测试通过，306 字节的 tarball 仅含两个文件、零依赖，批准前的精确版本未公开。用户已确认 npm 账号 `airport233` 启用了发布 2FA。**从 npm 独立下载比对、人工批准和公开安装验证尚未完成，不能据此宣称发布链路全部通过。** 后续顺序见[现场检查表](docs/tomorrow-checklist.md)。

## 实现范围

- 根 `package.json` 为 `private: true`，没有 npm 依赖；`scripts/probe.mjs` 只使用 Node 内置模块。
- 测试包只有 `package.json` 和 `probe.txt`，包名必须是 `@scope/ocr-stage-poc-xxx`，版本仅允许 `0.0.N`，默认 `0.0.1`。
- 一个 [工作流](.github/workflows/probe.yml)，仅支持手动 `workflow_dispatch`，模式为 `pack`、`stage`、`verify`。默认 `pack`，没有 push、PR 或 tag 触发。
- 使用容器自带的 Node/npm；不运行项目依赖安装、`setup-node`、apt 或自定义镜像构建。Actions 仅用 checkout 和 upload-artifact。
- registry 固定为 `https://registry.npmjs.org/`，发布通道固定为 `next`。不包含 Go 编译、七个生产包或 GitHub Release 集成。

`pack` 只封装，不需要真实 npm 包名或凭据。`stage` 是真实 registry 写入；新包首次 stage 会公开 `0.0.0-stage` 占位版本，本次测试版本等待批准。`verify` 会从 npm 真实安装这个微小测试包，并使用 `--ignore-scripts`。

## 运行前需要配置什么

先确认团队所说的“群组”是 GitHub organization、team、runner group，还是 npm organization。它们分别控制不同权限，不能互相替代。

在获准的 GitHub 仓库配置以下 Actions variables；工作流需先存在于默认分支，才能从 Actions 页面手动运行。

| Variable | 值与用途 |
| --- | --- |
| `POC_RUNNER_GROUP` | 必填：目标 self-hosted runner group 名称；需另行确认该仓库可使用它。未配置时 job 显示 skipped，不回退到其他 runner。 |
| `POC_RUNNER_LABELS` | JSON 数组，默认 `["self-hosted","linux","x64"]`；按目标 runner 的实际标签设置。 |
| `POC_NODE_IMAGE` | 可选，默认 `node:24.21.0-bookworm-slim`，官方源码对应内置 npm `11.19.0`；以实际运行日志为准。替换镜像须包含可用的 `npm stage`。 |
| `POC_PACKAGE_NAME` | 真实独立测试包，例如 `@your-test-scope/ocr-stage-poc-unique`；不要填七个生产包的名称。 |

仅为 `stage` 配置 Actions secret `NPM_STAGE_TOKEN`：选择 **Read and write (stage only)**，不勾 bypass 2FA，仅授权独立测试包或隔离测试 scope，使用短有效期。它只传入 stage 的执行步骤。

记录测试包的 Publishing access 设置和 token 授权范围。维护者须有该包的批准权限和可用的 2FA；维护者登录会话留在可信终端，不放入服务器或 Actions secret。

若新包尚未存在、token 页面无法选择它，先确认初始化方式：可由维护者在可信终端 stage 一个初始化版本，再为该测试包签发 token，服务器改用另一个未占用版本。初始化同样是真实 npm 写入，不要借用生产包或扩大到生产 scope。

本次用户在 token 页面找到个人 scope `@airport233`，并确认账号此前没有发布过包；按限该 scope、短期有效、stage-only、无 bypass 的指引创建并保存了 `NPM_STAGE_TOKEN`。服务器已使用该凭据首次 stage `@airport233/ocr-stage-poc-test@0.0.1`；仅核对了 Secret 元数据和上传结果，没有读取 token 值或独立审计其权限。scope 级授权会覆盖该 scope 下未来新增的包，验证完成后撤销。npm [2026-10-02 公告](https://github.blog/changelog/2026-10-02-npm-staged-publishing-now-supports-creating-new-packages/)明确支持此方式创建新的 public scoped 包，无须先手工发布。

## 执行流程

1. 在 Actions 选择 `pack`，版本可用默认 `0.0.1`。检查日志中的 Node/npm 版本，并下载 artifact 查看文件清单、tarball 和 integrity。这一步不验证 npm 发布权限。
2. 确认测试包、token 和未占用版本后，手动运行 `stage`。工作流先无凭据 pack，再上传同一 tarball；核对返回的 stage UUID、待批准记录及精确版本未公开状态。网络、认证或服务端错误不能当成“未公开”。保存**这次 stage** 的 artifact。
3. 维护者从该 artifact 的 `manifest.json` 取出包名、版本、`stageId`、`integrity`、目标 `next`，在可信终端审查 npm 中的待批准内容。
4. 完成下载、摘要和内容核对后，维护者通过 2FA 批准。
5. 手动运行 `verify`，版本与 stage 相同，`expected_integrity` 填写原 stage 的 `manifest.json` 中完整的 `sha512-…` 值。确认公开 metadata、实际安装内容、tarball integrity 和 `next` 都符合原始记录。

人工终端先用 `npm stage --help` 确认命令可用，再登录有权限的账号；仅看 npm 版本号不够。以下 `STAGE_ID` 应替换为原 stage 的真实 UUID：

```sh
npm stage --help
npm login --registry=https://registry.npmjs.org/
STAGE_ID='替换为实际-stage-UUID'
npm stage view "$STAGE_ID" --registry=https://registry.npmjs.org/ --json
npm stage download "$STAGE_ID" --registry=https://registry.npmjs.org/
```

用 Node 计算下载文件的 integrity；将示例路径替换为实际下载的 tarball：

```sh
node -e 'const fs = require("node:fs"); const crypto = require("node:crypto"); console.log("sha512-" + crypto.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"))' /path/to/downloaded.tgz
```

结果须与原 stage manifest 一致；同时检查包名、版本、`next`、文件清单及 `probe.txt` 内容。全部核对后再执行：

```sh
npm stage approve "$STAGE_ID" --registry=https://registry.npmjs.org/
```

批准时按提示完成 2FA。不要给 approve/reject 附加 `--dry-run` 来模拟；它们可能仍真实执行。

## 本地入口与证据

已有 Node 24+/npm 的本机可直接验证，不需要先执行 `npm install` 或 `npm ci`：

```sh
npm test
node scripts/probe.mjs pack
```

测试包含 5 项：包名/版本边界、stage 返回契约、原始 integrity 与无依赖约束、registry 404/错误区分，以及真实离线 `npm pack` 的文件清单和摘要。它们不访问 npm 发布接口。

2026-10-09 本机验证结果：5/5 测试通过，实际测试 tarball 为 303 字节；工作流通过 YAML 解析，匿名 registry GET 的 200/404 处理也已核实。Node 为 `v24.19.0`、npm 为 `11.17.0`，这些结果不代表容器内或真实发布已验证。该开发机的 npm stage 模块不完整，人工终端须先通过 `npm stage --help` 检查，或使用 npm 网页完成审查和批准；本次未更改本机 npm。

CLI 入口为 `node scripts/probe.mjs pack|stage|verify`，读取 `POC_PACKAGE_NAME` 和 `POC_VERSION`。本地 `stage` 要先用相同包名/版本执行 `pack`，再安全注入 `NPM_STAGE_TOKEN`；它消费现有 tarball。`verify` 必填 `POC_EXPECTED_INTEGRITY`。不要把 token 写进命令、源码或日志。

本地 `verify` 示例，变量值须来自原 stage 证据：

```sh
POC_PACKAGE_NAME='@your-test-scope/ocr-stage-poc-unique' \
POC_VERSION='0.0.1' \
POC_EXPECTED_INTEGRITY='sha512-替换为原stage的完整摘要' \
node scripts/probe.mjs verify
```

| 输出 | 用途 |
| --- | --- |
| `out/manifest.json` | 包名、版本、registry、dist-tag、integrity、Node/npm 版本、tarball 路径及 stage UUID 等；具体字段依执行模式而定。 |
| `out/package.tgz` | 实际封装、上传的测试包；审查时保留原文件。 |
| `out/stage-result.json` | 从上传结果保留的包名、版本、stage UUID 和 integrity 白名单字段。 |
| `out/stage-view.json` | 从待批准记录保留的身份、tag、shasum 等白名单字段。 |
| `out/verification.json` | 公开安装后的核验记录。 |

Actions 会上传可用的 `out/` 文件，artifact 保留 7 天，需及时另存。`pack` 遇到既有 `out/manifest.json` 会停止；保存旧证据并移走 `out/` 后才能准备另一个包。stage 会在原 manifest 记录上传尝试和结果，verify 写入独立记录；对比值必须来自原 stage，不能取线上版本重新生成。

## 运行边界与失败处理

- runner 程序和 Docker 仍安装在宿主机，container job 挂载工作目录；容器不是完整安全边界。先核对发布 runner 的访问范围和隔离方式。
- 第一次拉取 Node 镜像需要网络和时间，同一宿主机后续可复用 Docker 缓存；不是每次安装项目依赖。确认镜像仓库、GitHub Actions 与 npm registry 的网络都可达。
- npm 配置、缓存和凭据使用独立临时目录，脚本结束时清理；`out/` 保留不含凭据的证据。宿主机异常退出后的维护仍由 runner 管理者负责。
- 此 PoC 没有自动 stage 重试或恢复编排。上传断线、失败或结果不确定时，先查 artifact 和 npm 待批准列表，核对原 UUID；不要直接 rerun 同包同版本。
- stage 成功只说明上传待批准；只有人工批准后 `verify` 通过，才算本轮链路完成。本地测试或 pack 成功不能代替真实 npm 验证，也不能证明生产七包已经可迁移。
- 收尾时撤销测试 token，处理不用的待批准记录；已公开版本属于真实 registry 状态，不自动 unpublish。

参考：[npm staged publishing](https://docs.npmjs.com/staged-publishing/)、[npm stage 命令](https://docs.npmjs.com/cli/commands/npm-stage)。
