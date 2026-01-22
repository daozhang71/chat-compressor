# Chat Compressor

SillyTavern 聊天压缩插件 - 摘要 + 向量检索，让 AI 记住更多历史。

A SillyTavern extension for compressing chat history with summary and vector search.

## 功能特点 / Features

- **摘要压缩**: 用 AI 将旧消息压缩成精简摘要
- **向量检索**: 根据当前对话动态检索相关历史（使用 Google AI Embedding）
- **独立实现**: 不依赖酒馆内置的 Vector Storage，配置简单
- **Token 节省**: 可隐藏旧消息，只发送摘要+检索结果+最近消息
- **免费使用**: Google AI Studio 的 Embedding API 免费

## 两种使用模式

### 模式1：仅摘要（无需配置）
- 保持「跳过向量化」勾选
- 点击「压缩聊天记录」
- 插件用当前模型生成历史摘要

### 模式2：摘要 + 向量检索（推荐）
- 输入 Google AI API Key
- 取消勾选「跳过向量化」
- 点击「压缩聊天记录」
- 每次发消息时自动检索相关历史

## 工作原理

```
压缩时（一次性）:
  旧消息 → AI 生成摘要
  旧消息 → Google Embedding → 向量存储

聊天时（每次自动）:
  用户消息 → Google Embedding → 查询相似向量 → 找到相关历史
  注入给模型: [摘要] + [检索到的相关历史] + [最近消息]
```

## 安装方法

### 方法一：通过 Git URL 安装（推荐）
1. 打开 SillyTavern
2. 进入扩展面板 → 点击「Install Extension」
3. 输入本仓库 URL
4. 点击安装，完成后刷新页面

### 方法二：手动安装
1. 下载本仓库
2. 将 `chat-compressor` 文件夹复制到：
   ```
   SillyTavern/data/default-user/extensions/third-party/
   ```
3. 重启 SillyTavern

## 配置说明

### Google AI API Key（向量化必需）

1. 访问 [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. 创建免费 API Key
3. 在插件中输入 API Key，点击「测试」验证

### 设置项

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| 保留最近消息数 | 不被压缩的最近消息数量 | 10 |
| 摘要最大字数 | AI 生成摘要的字数限制 | 300 |
| 检索数量 | 每次检索返回的相关消息数 | 5 |
| 相似度阈值 | 只返回相似度高于此值的结果 | 0.3 |
| 跳过向量化 | 勾选则只生成摘要，不做向量检索 | 勾选 |
| 隐藏已压缩的消息 | 启用后旧消息不发送给模型 | 不勾选 |

### 模板变量

- `{{summary}}` - 摘要内容
- `{{retrieved}}` - 向量检索到的相关历史
- `{{words}}` - 摘要字数限制（用于摘要提示词）

## 使用建议

1. **聊天较长时压缩**: 当消息超过 20-30 条时进行压缩
2. **启用隐藏功能**: 勾选「隐藏已压缩的消息」才能真正节省 token
3. **检查摘要质量**: 压缩后可手动编辑摘要
4. **调整阈值**: 如果检索结果太少，降低相似度阈值

## 数据存储

- 摘要和向量数据都存储在聊天元数据中
- 随聊天自动保存
- 每个聊天独立存储

## 系统要求

- SillyTavern 1.12.0+
- 已配置 AI API（用于生成摘要）
- Google AI API Key（用于向量化，可选）

## 许可证

MIT License
