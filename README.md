# MOSS-Image 提示词工作台 · 静态版

独立的 React + Vite 静态页面。无需登录、后端、数据库、Worker 或代理；拿到公开网址的人都可以使用。源码仓库可以保持私有，发布的网页和浏览器代码仍然公开可访问。

## 本地运行与构建

需要 Node.js 22.13+。依赖精确版本与 `package-lock.json` 已锁定。

```sh
npm ci
npm run dev
npm run check  # TypeScript、自动测试、静态构建
npm run preview
```

`npm run build` 只生成 `dist/` 下的 HTML、CSS、JavaScript 和静态许可文件，不生成服务器入口。生产环境只需托管 `dist/`。资源使用相对路径，支持根域名和子目录部署。不要上传 `node_modules/`。

### Cloudflare Pages

- 连接自己的私有 GitHub 仓库，只授权该仓库即可。
- Framework preset：Vite（或 None）。
- Production branch：实际生产分支，例如本仓库的 `master`。
- Build command：`npm run build`。
- Build output directory：`dist`。
- Node 版本：22.13 或更高，例如环境变量 `NODE_VERSION=22`。
- 不需要 Functions、Workers、D1、模型 API 环境变量或服务器密钥。

也可以将构建完成的 `dist/` 作为静态资产部署。公开访问由托管平台控制；本应用没有登录门槛。此代码仓库本身不创建、发布或修改任何站点。

## 每个人用自己的 API

打开「模型设置」，选择预设或自定义公网 HTTPS OpenAI Chat Completions 基础地址，填写自己的 API key 和模型 ID，然后保存。

- 端点、密钥和模型仅保存在**当前来源、当前浏览器的 localStorage**，使用 `moss-prompt-static.settings.v1`。不在不同设备或浏览器间同步；同一浏览器配置也不是按人隔离。
- localStorage **并非加密保险库**。共享设备使用后点击「清除本机配置」，这会删除本应用所有端点配置，不影响其他应用的数据或当前画布。
- 配置按规范化后的完整端点隔离。切换端点不会转发原端点的 key；切回已保存端点可继续使用它自己的 key 和模型。密码框不回显已保存 key。
- 保存、打开页面、切换端点都不会请求模型。点击「获取模型」才会浏览器直连该端点的模型列表；点击增强才发送文本输入和参考规则，并消耗该用户 API 额度。
- 请求只直达用户选定端点，不经过本站服务器；不发送 Cookie、不跟随重定向。没有分析、追踪、远程字体或第三方脚本。
- 禁用、已满、损坏或不兼容的本地存储会显示明确错误，不会假装保存成功或偷偷换用其他端点密钥。
- 预设包括 DeepSeek、OpenAI、通义千问、Moonshot/Kimi、智谱 GLM 和 SiliconFlow；模型列表不可用时可手填模型 ID。服务商需支持浏览器跨域调用；不提供代理或绕过方案。

## 保留的功能

- 普通提示词为第一项且默认打开；增强按钮旁切换普通文本 / 模型自行生成的 Layout JSON。
- 写实、二次元、跨次元；尺寸预设和 64–4096、16 倍数的自定义尺寸。
- 严格校验模型 JSON、bbox 坐标、字段、文字、重复键与截断输出，错误时不应用半成品。
- Bbox 画布：点「添加区域」后单次画框并回到选择模式；「退出」/ Escape 取消；移动、缩放、键盘、最多 24 色独立区域、原样文字。
- 拖放/选择本地底图，浏览器 object URL 预览；不上传、不发送给模型、不写入 JSON。
- 不配置 API 也可直接生成、复制、下载合法布局 JSON。
- 同一页面切换工作模式保留草稿；刷新清空草稿和结果，已保存 API 配置保留。

## 验证和来源

`npm test` 使用测试密钥和模拟传输，不调用真实模型服务。
自动测试覆盖布局、画框、颜色、底图、普通/JSON 输出、存储隔离及失败、浏览器直连、错误与取消。

规则内容沿用既有项目；作者、许可和适配记录见
[`PROVENANCE.md`](PROVENANCE.md)、[`vendor/moss/`](vendor/moss/) 与
[`public/NOTICE.md`](public/NOTICE.md)。
