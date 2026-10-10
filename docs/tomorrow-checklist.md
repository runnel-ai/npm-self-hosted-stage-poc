# 现场检查表

首次 self-hosted 容器 [pack](validation-2026-10-10.md) 和真实 [stage 上传](stage-validation-2026-10-10.md) 已通过。以下方框记录当前进度；npm 待审核 tarball 的独立下载比对、人工批准及安装验证仍待完成。

## 先确认执行对象

- [x] 说清“群组”属于 GitHub organization、team、runner group 还是 npm organization。
- [x] 确认独立测试仓库所在组织、操作人权限及仓库对目标 runner group 的访问权。
- [x] runner 为 Linux，Docker 可用，labels 与 `POC_RUNNER_LABELS` 匹配。
- [x] 确认发布 runner 的访问范围和隔离方式；实际容器挂载了 workspace 和 Docker socket，不能当作完整安全隔离。
- [x] 网络可访问 GitHub Actions、Node 镜像仓库及 `registry.npmjs.org`；首次 stage 已复用 Node 镜像缓存。
- [x] 测试 scope 为 `@airport233`，包为 `@airport233/ocr-stage-poc-test@0.0.1`，stage 前确认版本未公开，批准人为该账号持有人。
- [x] 用户确认 npm 账号 `airport233` 已启用 authorization and publishing 2FA，配置了 1 个 security key，且没有发布过包。
- [x] token 选择器可见个人 scope `@airport233`；测试包已配置为 `@airport233/ocr-stage-poc-test`，计划首次 stage 使用 `0.0.1`，执行前再次查版本。
- [ ] 批准人的 npm 发布权限、2FA 和可信终端可用；运行 `npm stage --help` 确认命令可用。
- [ ] 记录包级 Publishing access；测试 token 为 stage-only、无 bypass、限测试包/scope、短有效期。
- [x] 新包通过个人测试 scope 授权直接首次 stage，无须在本机另发初始化版本。

## 配置并先跑 pack

- [x] workflow 已在获准测试仓库默认分支；仅手动触发。
- [x] 配置并读取确认 `POC_RUNNER_GROUP=build-and-release`、`POC_RUNNER_LABELS=["self-hosted","Linux","X64","build"]`、`POC_PACKAGE_NAME=@airport233/ocr-stage-poc-test`。
- [x] 默认镜像为 `node:24.21.0-bookworm-slim`；首次拉取后记录实际镜像 digest 和 Node/npm 版本。
- [x] 以默认模式 `pack` 运行，记录 Node/npm 版本；不需要 npm token。
- [x] 下载 artifact，检查 `manifest.json`、`package.tgz`，确认包内只有 `package.json`、`probe.txt`。
- [x] 本次只完成封装，尚不能据此判定认证或发布可用。

## stage → 人工批准 → verify

- [x] 配置 secret `NPM_STAGE_TOKEN`，确认它只注入 stage 步骤；只读取 Secret 元数据，不读取其值。
- [x] 运行 `stage` 前核对包名、版本和目标 `next`；已完成真实 npm 上传。
- [x] stage 无需服务器交互 2FA，得到真实 UUID；已核对 `stage-view.json`，另存本次 artifact 和原始 integrity。
- [x] 精确测试版本在批准前尚未公开。初始 stage 状态为 `validating`，本轮即时查询尚未观察到公开占位，不能声称它已经出现。
- [ ] 若失败或断线，先查原 UUID/待批准列表与证据，不盲目重跑。
- [x] 可信终端 `npm stage download UUID`，检查 metadata、内容，并与原 manifest 的 integrity 比对：下载包与服务器 artifact 逐字节相同。
- [ ] 核对无误后 `npm stage approve UUID` 并完成 2FA；不要附加 `--dry-run`。
- [ ] 手动运行 `verify`，沿用包名/版本；`expected_integrity` 复制原 stage 的完整 `sha512-…`。
- [ ] 查看 `verification.json`：实际安装成功，package.json/probe.txt、integrity 和 `next` 均一致。

## 收尾与记录

- [ ] 保存 workflow run 地址、服务器/runner、镜像、Node/npm 版本和包级权限设置；artifact 7 天内另存。
- [ ] 保存包名、版本、stage UUID、原始 integrity、批准前后状态与批准人；不记录 token。
- [ ] 撤销测试 token，处理不再使用的待批准记录；不自动删除公开版本。
- [ ] 结论只覆盖本次服务器、工具和权限组合；七包、断线恢复、GitHub Release 留待下一轮。

| 记录项 | 现场填写 |
| --- | --- |
| GitHub 仓库 / workflow run | |
| runner group / labels / 镜像 | |
| Node / npm | |
| 测试包 / 版本 / Publishing access | |
| stage UUID / integrity | |
| 批准人 / 批准时间 | |
| verify 结果 / 剩余问题 | |
