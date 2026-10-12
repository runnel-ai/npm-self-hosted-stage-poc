# 七包彩排验证记录（2026-10-12）

高仿减负版彩排全流程通过。七包结构镜像 `open-code-review` 生产发布（1 主包 + 6 平台包、optionalDependencies 精确互锁、postinstall 平台解析逻辑原样复制），内容为脚本生成的假二进制；scope `@airport233`，版本 `0.1.0`，dist-tag `next`。

## 时间线（北京时间）

| 环节 | 时间 | 证据 |
| --- | --- | --- |
| 容器 pack | 11:24 | run [38199774231](https://github.com/runnel-ai/npm-self-hosted-stage-poc/actions/runs/38199774231)（首次 11:21 的失败为 job 级 env 冲突，见"踩坑"） |
| 七包 stage（含主包先行探针） | 11:28–11:29 | run [38199848697](https://github.com/runnel-ai/npm-self-hosted-stage-poc/actions/runs/38199848697) |
| 待审核包抽查 | 11:38 | linux-x64 与主包的下载 tarball 和服务器 artifact 逐字节相同 |
| 七次 2FA 批准（先平台后主） | 14:00–14:10 | 每包一次 `npm stage approve` + security key；registry 显示七包 `0.1.0` 公开、`next` 指向 `0.1.0` |
| 服务器干净容器 verify | 14:19 | run [38211875192](https://github.com/runnel-ai/npm-self-hosted-stage-poc/actions/runs/38211875192)（14:14 首次失败为 verify 脚本两处断言问题，见"踩坑"） |
| 本机 macOS 消费者复验 | 14:17 | darwin-arm64 匿名安装、启动器输出、磁盘仅 2 包，均符合预期 |

## 核心发现：主包先行探针答案 A

**npm stage 不校验依赖公开性。** 六个平台包尚未公开（甚至尚未 staged）时，主包 `ocr-rehearsal` 直接 stage 成功（`probe.result = accepted-without-public-deps`，stageId `32b0e443-e7a8-42d7-8518-d7a060327b97`）。

对生产流水线的含义：

1. 七个包可以在**同一次运行**中全部 stage，无须拆成"平台包批准后再 stage 主包"的两段式；
2. 但 stage 不做依赖检查意味着**编排正确性完全由流水线自己保证**：必须按"先平台后主"批准，且批准主包前须确认六个平台包已公开，否则用户安装主包时会拿到缺失依赖的版本。

七个 stageId 与各包 integrity 记录在 stage 运行的 artifact（`npm-rehearsal-38199848697-1`）中；抽查的两个待审核 tarball 与服务器产物逐字节一致。

## 批准负担实测

七个包 = 七次 `npm stage approve` + 七次 security key 验证，另有多次 npm 登录。CLI 的 2FA 验证链接有效期约两分钟，链接生成后必须立即完成；本次因用餐等原因过期四次，过期后重发即可，已 staged 的记录不受影响。批准期间 `npm stage list` 实时反映剩余数量，可作为断点续批的依据。

## 踩坑记录（对生产改造有参考价值）

1. **job 级 env 冲突**：rehearsal 工作流在 job env 设置 `POC_VERSION=0.1.0`，导致同仓库 probe 测试（要求 `0.0.x`）在共享的 `node --test` 步骤失败。修复：版本 env 收窄到具体步骤。
2. **npm 隐藏成功的生命周期输出**：verify 断言 postinstall 的"Binary provided by platform package"日志，但 npm 默认不回显成功脚本输出。修复：install 加 `--foreground-scripts`。
3. **lockfile ≠ 磁盘**：package-lock 记录全部 7 个 optionalDependencies（含 os/cpu 不匹配项），不能用来断言实际安装集。修复：改为读取 `node_modules` 实际目录（验证为恰好 2 包）。

## 最终验收结果

服务器干净容器（无 npm 凭据）：`npm install @airport233/ocr-rehearsal@0.1.0` 成功；postinstall 命中平台包（`postinstallUsedPlatformPackage=true`）；磁盘安装集恰好为主包 + `ocr-linux-x64`；启动器输出 `platform=linux-x64 version=0.1.0`；七个包的公开 integrity、`next` 标签与服务器打包的确定性重放全部一致；`expected_main_integrity` 与 stage manifest 原值一致。

本机 macOS 补充验证：darwin-arm64 平台包同样可被匿名安装并正确解析，输出 `platform=darwin-arm64 version=0.1.0`。

## 结论与边界

在这组配置下，**七包编排的 staged publishing 链路成立**：服务器一次 stage 七包、维护者按序七次 2FA 批准、消费者跨平台（linux-x64 容器、darwin-arm64 本机）均可通过 optionalDependencies + os/cpu 过滤获得正确的平台产物。结论限于本测试 scope、runner 与 token 配置；GitHub Release 回退链路、真实 Go 构建、生产 scope 迁移不在本轮范围。
