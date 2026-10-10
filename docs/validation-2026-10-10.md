# 首次 self-hosted 容器打包验证

2026-10-10，北京时间 11:13:37–11:15:17，[首次运行](https://github.com/runnel-ai/npm-self-hosted-stage-poc/actions/runs/38019810925)成功。触发参数为 `mode=pack`、`version=0.0.2`；使用示例包名 `@example/ocr-stage-poc-example`，没有创建或发布该 npm 包。

| 项目 | 证据 |
| --- | --- |
| 源码提交 | `23df0aeb1a931e04995048d3b1c2e1fed5caa78a` |
| Job ID | `114118097679` |
| 实际 runner／group | `linux-runner-01`／`build-and-release` |
| Labels | `self-hosted`、`Linux`、`X64`、`build` |
| Runner 版本 | `2.337.0` |
| 容器镜像 | `node:24.21.0-bookworm-slim` |
| 实际 Node／npm | `v24.21.0`／`11.19.0` |
| 自动测试 | 5 项通过，0 失败 |
| 阶段结果 | 容器初始化、checkout、测试、离线 pack、artifact 上传全部通过；stage 和 verify 明确 skipped。 |
| 清理 | 日志确认任务容器和本次专属 Docker network 已删除。 |

本次镜像 digest：

```text
sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
```

Artifact 为 `npm-stage-poc-38019810925-1`，ID `11657995917`，ZIP 为 1287 字节，保存至 2026-10-17。原始 artifact 已另存并核验，下载 ZIP 的 SHA-256 与 GitHub 返回的 digest 一致：

```text
sha256:9d891db5b817a149e40f94533a4c13c2046f26a1f5c201bfa7273d5f8e0ba5e3
```

ZIP 中只有 `manifest.json` 和 `package.tgz`。实际 tarball 为 303 字节，包内只有 `package.json` 和 `probe.txt`；版本为 `0.0.2`，没有依赖或安装脚本，文本内容为 `self-hosted staging probe`。本地重新计算的 SHA-512 与 manifest 一致：

```text
sha512-f+dSTMfkUODYcqBoRcnIIaibc6pdtqxeq5CdVGdu/4Bxr5naXyKFvlk4Nb3zIwAkJUh0GZBmSycxpry+tblGkw==
```

这次确认了目标服务器可接收新仓库的任务，并在容器中正确封装测试包。尚未验证 npm 账号、token、stage、人工批准和公开安装，不能把本结果写成 npm 发布成功。

实际运行还显示：runner 自动向容器挂载了宿主机 Docker socket，虽 workflow 没有声明这个挂载，也不能据此宣称容器完全隔离宿主机。两项 action 声明的 Node20 被当前 runner 自动改用 Node24，产生弃用提示，本次未影响运行结果。

后续执行 `stage → 人工批准 → verify`。下一轮审查必须使用真实 stage 那次生成的 artifact，不能使用本次示例包的摘要。

## npm 账号准备进度

同日，用户确认 npm 账号为 `airport233`，账户页面显示 `Enabled for authorization and publishing` 和 `1 security key`，并确认没有发布过包。token 创建页面可选择个人 scope `@airport233`。这些账号状态来自用户的页面反馈，不是实际 npm 上传结果。

已配置并通过 GitHub API 读取确认新测试仓库的 `POC_PACKAGE_NAME=@airport233/ocr-stage-poc-test`。计划创建限 `@airport233`、无 bypass 2FA、短有效期的 stage-only token，由用户直接存入仓库的 `NPM_STAGE_TOKEN` secret；当前 secret 尚未配置。该 token 为 scope 级授权，验证结束后撤销。

首次真实 stage 计划使用 `0.0.1`，执行前检查版本状态。npm 已明确支持 stage-only token 创建新 public scoped 包，因此本次无须先在本机发布初始化版本；首次 stage 的 `0.0.0-stage` 占位仍属于真实公开写入。当前尚未登录 npm CLI、创建包或上传候选版本。
