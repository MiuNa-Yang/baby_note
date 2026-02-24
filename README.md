# 育儿笔记 (BabyNote)

本地部署的育儿事项记录与 AI 问答工具，支持局域网多人协作访问。

## 功能特性

### 记录功能
- **事项记录**：喂奶、换尿布、洗澡、黑白卡片、睡眠、用药
- **喂奶统计**：按日统计喂奶次数、奶粉量、母乳时长
- **睡眠记录**：记录睡眠开始和结束时间
- **成长记录**：体重、身高追踪
- **月龄提醒**：根据宝宝月龄自动计算下次喂奶/换尿布时间

### 数据展示
- **今日概览**：显示当日记录与提醒
- **历史记录**：按日期与类型筛选查看
- **统计图表**：喂奶、睡眠、体重统计

### 系统功能
- **提醒规则**：可自定义各月龄的提醒间隔
- **深色模式**：夜间使用更舒适
- **数据导出**：JSON 格式备份
- **AI 问答**：基于 RAGFlow 的智能育儿问答

## 快速启动

### 方式一：使用启动脚本（推荐）

```bash
# 生产模式启动（构建前端 + 启动服务）
start.bat

# 开发模式启动（热更新）
dev.bat
```

### 方式二：命令行启动

```bash
# 安装依赖
npm install
cd client && npm install && cd ..

# 开发模式（前后端同时运行，热更新）
npm run dev

# 生产模式（构建后单端口运行）
npm run build
node server/index.js
```

### 方式三：PM2 启动

```bash
# 全局安装 PM2（如未安装）
npm install -g pm2

# 启动服务
pm2 start server/index.js

# 查看状态
pm2 list
pm2 logs
```

### 访问地址

- 本地访问：http://localhost:3000
- 局域网访问：http://你的电脑IP:3000（如 http://192.168.1.100:3000）

## 项目结构

```
babynote/
├── client/                 # 前端 React 应用
│   ├── src/
│   │   ├── components/     # 公共组件
│   │   ├── pages/          # 页面组件
│   │   └── utils/          # 工具函数
│   └── dist/               # 构建输出
├── server/                 # 后端 Node.js 服务
│   ├── index.js            # 主入口
│   ├── db.js               # 数据库操作
│   ├── ragflow.js          # RAGFlow AI 集成
│   └── date-utils.js       # 日期工具
├── data/                   # 数据目录
│   ├── babynote.db         # SQLite 数据库
│   ├── guides/             # 育儿指南资料
│   └── ragflow/            # RAGFlow 配置
├── scripts/                # 辅助脚本
├── start.bat               # 生产模式启动脚本
├── dev.bat                 # 开发模式启动脚本
└── package.json            # 项目配置
```

## 数据存储

- **数据库**：SQLite，保存在 `data/babynote.db`
- **日志文件**：`server.log`（可通过 PM2 或其他方式管理）
- **配置文件**：`data/ragflow/config.json`（AI 问答配置）

## AI 问答功能 (RAGFlow)

本项目集成了基于 RAGFlow 的 AI 育儿问答功能。

### 配置说明

详见 [RAGFlow 配置指南](./RAGFLOW_SETUP.md)

### 配置 RagFlow

1. 部署 RagFlow 服务（详见官方文档）
2. 创建知识库，上传育儿资料
3. 创建 AI 助手，获取 API Key
4. 编辑 `data/ragflow/config.json`：

```json
{
  "base_url": "http://localhost:80",
  "api_key": "ragflow-你的API密钥",
  "chat_id": "你的助手ID",
  "assistant_name": "育儿AI问答",
  "dataset_ids": ["知识库ID"]
}
```

## 技术栈

- **后端**：Node.js + Express + SQLite (better-sqlite3)
- **前端**：React 18 + Vite + React Router
- **AI**：RAGFlow
- **部署**：支持 PM2 进程管理

## 许可

MIT License
