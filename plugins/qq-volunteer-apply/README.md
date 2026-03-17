# qq-volunteer-apply

基于 NapCat 的志愿者招募自动报名插件（单任务模式）。

## 功能

- 监听白名单群消息，识别志愿者招募关键词。
- 提取`活动内容`作为任务唯一键。
- 私聊管理员确认（30分钟窗口）：`是`、`否`、`补时 ...`。
- 任意时刻取消：`取消 活动内容`。
- 开始前2分钟进入监听，收到全员禁言关闭事件后立即发送报名。
- 开始后5分钟仍未发送则放弃。
- 网络错误发送重试3次。
- 持久化：`tasks.json`、`runtime-state.json`（首次运行自动创建）。

## 配置

编辑同目录 `config.json`：

- `adminQQ`：管理员QQ（必须）
- `whitelistGroups`：监听群号白名单（必须）
- `recruitKeywords`：招募关键词
- `defaultApplyText`：默认报名文本

## NapCat 配置示例

在 `config/napcat.json` 插件列表中增加：

```json
{
  "name": "qq-volunteer-apply",
  "enable": true,
  "path": "./plugins/qq-volunteer-apply/index.mjs"
}
```

## 指令

管理员私聊机器人：

- `是`
- `是 24计科1班张三`
- `否`
- `补时 2026-03-01 18:30`
- `取消 活动内容`
