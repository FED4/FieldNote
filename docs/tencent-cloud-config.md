# 腾讯云服务变量约定

应用统一使用以下服务端环境变量，浏览器端变量禁止使用 `NEXT_PUBLIC_` 前缀，避免密钥进入前端 JavaScript。

```bash
export TENCENT_CLOUD_SECRET_ID='你的 SecretId'
export TENCENT_CLOUD_SECRET_KEY='你的 SecretKey'
export TENCENT_CLOUD_APP_ID='你的腾讯云 AppID'

export TENCENT_ASR_REGION='ap-guangzhou'
export TENCENT_ASR_ENGINE_MODEL_TYPE='16k_zh'
export TENCENT_ASR_VOICE_FORMAT='pcm'

export TENCENT_TIIA_REGION='ap-guangzhou'
export TENCENT_VITA_API_KEY='你的 VITA API Key'
```

变量职责：

- `TENCENT_CLOUD_SECRET_ID`、`TENCENT_CLOUD_SECRET_KEY`：腾讯云 API 身份凭证，由后端和音频 Agent 使用。
- `TENCENT_CLOUD_APP_ID`：实时语音识别 WebSocket 请求使用的腾讯云 AppID。
- `TENCENT_ASR_*`：实时语音识别参数；默认面向 16kHz 中文 PCM 会议音频。`VOICE_FORMAT` 使用 `pcm`、`wav`、`mp3` 等接口支持的字符串，不使用数字枚举。
- `TENCENT_TIIA_REGION`：图像分析服务区域。
- `TENCENT_VITA_API_KEY`：VITA 服务管理页面单独签发的 API Key；它与腾讯云 `SecretId/SecretKey` 是两套鉴权信息，只允许后端读取。
- `TENCENT_HUNYUAN_MODEL`：可选；将来用于对图片信息和 Transcript 做联合推理。TIIA 本身主要提供视觉标签，不等同于多模态总结模型。

将 `export` 写入 `~/.bashrc` 后，新终端需要执行：

```bash
source ~/.bashrc
```

注意：由 systemd、Docker Compose 或进程管理器启动的服务通常不会自动读取 `.bashrc`。正式部署时应将同名变量配置到服务的 `EnvironmentFile` 或容器 secrets 中。

建议为本项目创建最小权限的腾讯云子账号/API 密钥，只授权所需的 ASR、TIIA 服务，不使用主账号永久密钥。
