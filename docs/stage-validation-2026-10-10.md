# 首次真实 stage 上传验证

2026-10-10，北京时间 15:20:25 触发，[本次运行](https://github.com/runnel-ai/npm-self-hosted-stage-poc/actions/runs/38034087708)成功。触发参数为 `mode=stage`、`version=0.0.1`；目标包 `@airport233/ocr-stage-poc-test`，目标 dist-tag `next`。这是**一次真实 npm 写入**。

| 项目 | 证据 |
| --- | --- |
| 源码提交 | `3f40c15047ada09952a6a6930d454f7a1683ea3f` |
| Job ID | `114160817439` |
| 实际 runner／group | `linux-runner-01`／`build-and-release` |
| 容器镜像 | `node:24.21.0-bookworm-slim`（Node `v24.21.0`／npm `11.19.0`） |
| 凭据注入 | secret `NPM_STAGE_TOKEN` 只注入 stage 步骤；执行前通过 GitHub API 确认其元数据（`updated_at` 2026-10-10T07:19:52Z），未读取其值 |
| 阶段结果 | 容器初始化、checkout、测试、离线 pack、stage 上传、批准前可见性检查全部通过；verify 明确 skipped |
| 服务器交互 2FA | 无。stage 全程未要求服务器输入 2FA |

## stage 结果

服务器返回真实 stage UUID，stagedAt 为 2026-10-10T07:22:18.932Z（北京时间 15:22:18）：

```text
stageId:  048c5e58-0d8d-4b61-a842-6c9ac1dd01e3
package:  @airport233/ocr-stage-poc-test@0.0.1
dist-tag: next
```

上传时 `stage-view.json` 显示状态为 `validating`，shasum 与本地一致。批准前可见性检查结果为 `publicBeforeApproval=false`、`packageNamePublicBeforeApproval=false`。

实际 tarball 为 306 字节，包内只有 `package.json` 和 `probe.txt`，零依赖。Artifact `npm-stage-poc-38034087708-1`（ID `11662349124`，ZIP 2176 字节）中的 `manifest.json`、`stage-result.json`、`stage-view.json` 三处摘要互相一致；下载后在本机重新计算 tarball 摘要，与服务器记录一致：

```text
integrity: sha512-pw7SiEnFJOWedHMdldOhnOswQuu18P1Eb5SfGBN+EqltJwjufoSvs4wfyNQqwFlLHXxXLMXya1EU0FNOS9SEsw==
shasum:    77fbb82d81dde733c270db12a11da7bf3c5363f2
```

## npm registry 状态

北京时间 15:38 匿名查询 `registry.npmjs.org`：

- 包文档已公开，但**只有 npm 自动创建的 `0.0.0-stage` 占位版本**（`created` 2026-10-10T07:22:18.184Z，与 stagedAt 同一秒），`latest` 指向该占位；占位 tarball 的 integrity 与我们的包不同，属正常。
- 精确版本 `0.0.1` 仍返回 `404 "version not found"`，即**批准前真实版本未公开**，符合预期。
- 上传时即时查询尚未观察到占位，占位是在随后出现的；`next` dist-tag 在批准前尚不存在。

## 尚未完成

本次只验证了“自有服务器用 stage-only token 上传待审核版本”这一半。以下仍待执行，不能据此宣称发布链路全部通过：

1. 可信终端 `npm stage download 048c5e58-0d8d-4b61-a842-6c9ac1dd01e3`，独立下载待审核 tarball 并与上面的 integrity 比对（需要本机完成 npm 浏览器登录）。
2. 核对无误后由账号持有人 `npm stage approve` 并完成 security key 2FA。
3. 运行 `mode=verify`，填入 `0.0.1` 和上面的 integrity，确认干净环境可安装、内容与摘要一致、`next` 指向 `0.0.1`。
