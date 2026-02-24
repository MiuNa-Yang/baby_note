# 育儿指南本地维护说明

## 目录结构
- `index.json`：指南目录与顺序
- `*.md`：每个指南的正文（支持标题、列表、段落）
- `media/`：图片和视频素材

## 支持的文档语法
- 标题：`#` `##` `###`
- 无序列表：`- 项目`
- 有序列表：`1. 步骤`
- 图片：`![说明](media/feeding/step-1.jpg)`
- 视频：`@[video](media/feeding/demo.mp4)`

## 建议维护流程（本地迭代）
1. 先在 `*.md` 写 SOP 文本。
2. 把照片/视频放到对应 `media/<guide>/` 目录。
3. 在 markdown 中插入图片和视频引用。
4. 刷新页面查看效果。

## 新增一个指南
1. 新建一个 markdown 文件，例如 `solid-food.md`。
2. 在 `index.json` 的 `guides` 数组中新增一项，并指向该文件。
3. 如需媒体，新建 `media/solid-food/` 并放入素材。
