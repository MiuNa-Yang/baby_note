# RAGFlow 育儿知识库接入说明

## 1. 准备 RAGFlow

先按官方项目启动 RAGFlow（推荐 Docker 部署）：

- 项目地址：`https://github.com/infiniflow/ragflow`
- 确认可访问地址，例如：`http://127.0.0.1:9380`
- 在 RAGFlow UI 里创建 API Key

## 2. 配置环境变量

在项目根目录启动命令前，先设置：

```powershell
$env:RAGFLOW_BASE_URL="http://127.0.0.1:9380"
$env:RAGFLOW_API_KEY="<你的RAGFlow_API_KEY>"
```

可选变量：

- `RAGFLOW_DATASET_NAME`（默认：`美国儿科学会育儿百科_第7版`）
- `RAGFLOW_CHAT_NAME`（默认：`育儿AI问答`）
- `RAGFLOW_FORCE_REUPLOAD=1`（强制重新上传文档）
- `RAGFLOW_WAIT_PARSE=0`（不等待解析完成就退出）

## 3. 一键入库（EPUB -> Markdown -> RAGFlow）

```powershell
npm run ragflow:setup
```

脚本会自动执行：

1. 把 `data/raw_knowledge/美国儿科学会育儿百科（第7版）.epub` 转成 Markdown。
2. 在 RAGFlow 查找/创建 dataset。
3. 上传文档并触发解析。
4. 查找/创建 chat assistant。
5. 将结果写入 `data/ragflow/config.json`。

## 4. 启动项目

```powershell
npm run dev
```

打开“育儿指南”页面（现已改为 AI 问答窗口），即可直接提问。

服务端 API：

- `GET /api/guide-ai/status`：问答能力和文档解析状态
- `POST /api/guide-ai/chat`：向 RAGFlow 聊天助手提问
