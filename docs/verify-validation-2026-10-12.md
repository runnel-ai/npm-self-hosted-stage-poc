# 人工批准与公开安装验收

2026-10-12，账号持有人完成 2FA 批准，`0.0.1` 正式公开；随后自有服务器在干净容器中完成匿名安装验收。**至此整条 staged publishing 链路全部通过。**

## 批准（可信终端，本人 2FA）

| 项目 | 证据 |
| --- | --- |
| 操作 | 本机重新完成 npm 浏览器登录（`whoami` 为 `airport233`），确认 stage `048c5e58-0d8d-4b61-a842-6c9ac1dd01e3` 仍处于 `staged` 后执行 `npm stage approve` |
| 2FA | npm 要求打开验证链接并完成 security key 确认；登录与批准是两次独立的本人验证 |
| 结果 | CLI 返回 `approved and published successfully`；`npm stage list` 为空 |
| 发布时间 | registry `time["0.0.1"]` 为 2026-10-12T02:31:38.593Z |

批准后 registry 状态：`0.0.1` 公开可查，`next` 指向 `0.0.1`，`latest` 仍指向 `0.0.0-stage` 占位（按 `next` 标签发布的预期行为）；`0.0.1` 的 integrity、shasum 与 stage 时完全一致，文件数 2。

## 安装验收（自有服务器，干净容器）

[verify 运行](https://github.com/runnel-ai/npm-self-hosted-stage-poc/actions/runs/38196193616)，2026-10-12 北京时间 10:32 触发并成功。参数为 `mode=verify`、`version=0.0.1`、`expected_integrity` 取原 stage manifest 的 sha512。Job 使用同一 runner group／容器镜像，pack 与 stage 步骤按设计 skipped。

日志确认：

```text
Verified anonymous installation of @airport233/ocr-stage-poc-test@0.0.1.
Original tarball integrity, installed package, probe.txt and next all match.
```

Artifact `npm-stage-poc-38196193616-1`（ID `11723835292`）中的 `verification.json` 记录：

| 字段 | 值 |
| --- | --- |
| `installedWithoutCredentials` | `true`（安装环境无任何 npm 凭据） |
| `integrity` | 与 stage manifest 逐字符一致 |
| `distTags.next` | `0.0.1` |
| `probeTextMatches` | `true`（安装后的文本与源文件一致） |
| `verifiedAt` | 2026-10-12T02:33:02.372Z |

## 结论

在 `runnel-ai` 组织、`linux-runner-01` 自有服务器、`@airport233` 账号这组配置下，**新政策兼容的发布链路成立**：

1. 自有服务器的容器用 stage-only、无 bypass 的 token 上传待审核版本，全程无需服务器 2FA；
2. 维护者在可信终端通过 security key 2FA 批准后版本公开；
3. 无凭据的干净环境可安装该版本，内容、integrity 与 dist-tag 全部与上传时一致。

该结论限于本次验证的账号、包与服务器配置。stage-only token 为 7 天短期凭据（2026-10-10 创建），验证结束后应在 npm 页面撤销；测试包可按需 deprecated 或保留作历史记录。
