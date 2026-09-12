# Markdown 格式与开发

[返回首页](../README.md)

## Markdown 存储格式

```markdown
> [!ai-question|example-id] 提问
> 请解释这个概念。
>
> > [!ai-answer]- AI 答案
> > <!-- ai-answer:empty -->
```

- 固定问题类型为 `ai-question`，答案类型为 `ai-answer`。
- 竖线后为唯一标识，插入命令自动生成 UUID，用于安全定位写回。
- 空答案使用 `<!-- ai-answer:empty -->`，生成成功后替换成 Markdown 正文。
- 手写无 ID 的框可由批量命令补上 ID；普通问题复制产生的重复 ID 会修复。
- 问题正文在答案框之前，框结束后留空行再写普通正文。
- 新答案使用 `-`，兼容原生折叠。插件开启时统一默认收起，旧 `+` 标记也适用。

框内高亮使用 `aqb-highlights` 隐藏注释存储引用锚点，追问使用 `aqb-thread` 隐藏注释存储根问题 ID、回复对象 ID 和所选引用。注释内容为 Base64URL 编码的 JSON，并非加密。

追问在源码中仍为独立问题块，由渲染层关联进原框。生成器把它放在原问题及已有追问之后；请勿手动修改关联 ID，或只复制一部分带关联的追问链。

## 运行与构建

开发建议使用 Node.js 22 或更新版本。构建及测试没有第三方 npm 依赖；运行时使用 Obsidian 提供的 API、CodeMirror 模块以及桌面端 Node 内置模块。

```sh
npm test
npm run build
npm run check
```

构建生成 `main.js`。提交代码时应同时更新生成文件，再在测试仓库重新加载插件。普通使用者直接安装三个运行文件，无须安装 Node 或执行构建命令；Claude Code 自己的运行要求另行满足。

## 文件分工

| 文件 | 职责 |
| --- | --- |
| `main-source.js` | 命令、设置、任务管理、读写保护、阅读视图增强 |
| `core.js` | Markdown 解析、固定模板、唯一 ID、答案写回、基础提示词 |
| `bridge.js` | Claudian 配置解析、Claude 子进程、停止和超时 |
| `stable-view.js` | CodeMirror 稳定框、选区、高亮、追问和编辑窗口 |
| `annotations.js` | 高亮锚点、文本哈希、隐藏元数据编码 |
| `follow-up.js` | 追问插入排序、上下文、旧格式整理 |
| `styles.css` | 嵌套框、折叠、工具按钮和主题样式 |
| `build.js` | 本地 CommonJS 模块打包 |
| `tests/` | Node 内置测试运行器用例 |

## 测试与兼容范围

自动测试覆盖解析、嵌套 Markdown、代码围栏、CRLF、无末尾换行、重复 ID、冲突保护、取消、失败、超时、模型继承、高亮与追问元数据。

UI 验证需要真实 Obsidian：实时预览选字不变形、切换阅读视图、高亮恢复、右键选区追问、无选区追问、默认收起、点击展开及重新进入文章后收起。没有用纯逻辑测试冒充桌面 UI 验收。

Claudian 适配使用 `getResolvedProviderCliPath`、`getActiveEnvironmentVariables` 等运行时方法。遇到接口变化应明确报错，不静默改用另一个服务。修改桥接层时保留无 shell 执行、禁用工具与 hooks、无半截写回的约束。

## 发布内容

运行所需只有 `main.js`、`manifest.json`、`styles.css`。发布前同步 `package.json` 与 `manifest.json` 版本，并更新 `versions.json`、更新记录和验证记录。

不要提交 `data.json`、认证文件、真实用户笔记、`.obsidian` 配置或调试日志。仓库中的示例是专门撰写的演示材料。
