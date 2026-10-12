# 七包 staged publishing 彩排（高仿减负版）

镜像 `open-code-review` 生产发布的七包结构（1 主包 + 6 平台包），但内容为零负担的假产物：不编译 Go，平台"二进制"由脚本生成（linux/darwin 为可执行 shell 脚本，win32 为占位文本）。发布目标是测试 scope（默认 `@airport233`），版本 `0.1.0`，dist-tag `next`。

目的：在接近生产的编排复杂度下，验证第一轮单包实验（见 `../docs/`）尚未回答的问题。

## 与生产结构的对应关系

| 生产（`@alibaba-group`） | 彩排（`@airport233`） |
| --- | --- |
| `open-code-review` 主包 | `ocr-rehearsal`（bin 名 `ocr-rehearsal`） |
| `ocr-{darwin,linux,win32}-{arm64,x64}` 六个平台包 | 同名六包，仅 scope 不同 |
| Go 编译的裸二进制（构建矩阵产出） | 打包时生成的假文件（echo 平台名与版本） |
| `optionalDependencies` 精确锁定六平台包版本 | 相同，锁到同一彩排版本 |
| postinstall：先解析平台包，失败则回退 GitHub Release 下载 + sha256 校验 | 相同代码（`scripts/install.js` 原样复制）；回退 URL 指向本仓库（本轮不演练 Release 回退） |
| launcher `bin/ocr.js` spawn 二进制 | 原样复制，仅替换包名提示 |

`bin/ocr.js`、`scripts/install.js`、`scripts/platform.js`、`scripts/update.js`、`scripts/version.js` 复制自 open-code-review（Apache-2.0 头保留），仅将 `@alibaba-group` 引用替换为 `@airport233`。`platform.js` 的 `os/cpu` 过滤、`getPlatformPackageName` 的 optionalDependencies 后缀匹配等行为与生产一致。

## 关键实验：主包先行探针

生产七包改造必须先回答：**stage 主包时，npm 是否要求其 optionalDependencies 的版本已经公开？** `mode=stage` 故意在六个平台包公开之前先 stage 主包：

| 探针结果 | 含义 | 后续流程 |
| --- | --- | --- |
| A：接受 | stage 不校验依赖公开性 | 七个 stage 一次完成，按"先平台后主"批准 7 次 |
| B1：首次拒绝、平台包 staged 后重试接受 | 依赖版本处于 staged 即满足 | 同上，一次 stage 运行足够 |
| B2：首次拒绝、staged 后重试仍拒绝 | 依赖版本必须公开（批准） | 批准 6 平台包 → 再跑一次 `mode=stage`（幂等跳过已公开包）→ 批准主包 |

三种结果都是有效答案，脚本都会记录到 `rehearsal/out/rehearsal-stage.json`，不为探针"失败"而中断。

## 执行流程

1. `mode=pack`（无凭据）：生成七个 tarball 与 `rehearsal-manifest.json`（含每个包的 sha512 integrity）。`npm pack` 已实测字节级确定，verify 会独立重打包比对。
2. `mode=stage`（仅此步注入 `NPM_STAGE_TOKEN`）：主包探针 + 幂等 stage 六平台包 + 结果记录。每个新包首次 stage 会公开 `0.0.0-stage` 占位，属预期。
3. 人工批准（可信终端，每包一次 2FA）：先六平台包、后主包；批准前用 `npm stage download <id>` 抽查 tarball 与 manifest integrity 比对。
4. `mode=verify`（无凭据）：重打包比对七个公开 integrity 与 `next` 标签；干净目录真实 `npm install` 主包（postinstall 必须运行并命中"Binary provided by platform package"）；启动器输出须匹配当前平台与版本；lockfile 只含主包 + 当前平台包（验证 os/cpu 过滤）。

## 不在本轮范围

GitHub Release 回退下载链路、真实 Go 构建、生产 scope 迁移、`latest` 标签策略。结论只覆盖本测试 scope、本 runner 与本 token 配置。
