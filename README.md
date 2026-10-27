# LibreTV Revival

[![CI](https://github.com/wxst/LibreTV/actions/workflows/ci.yml/badge.svg)](https://github.com/wxst/LibreTV/actions/workflows/ci.yml)

LibreTV 是一个轻量级的在线视频搜索与观看工具，适合个人学习、自部署和私有使用。本仓库是对已归档上游 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) 的维护续作，重点放在可部署、可维护、可验证，而不是运营公开影视服务。

English positioning for GitHub search: LibreTV Revival is a maintained self-hosted fork of archived LibreSpark/LibreTV, focused on Cloudflare Pages, Pages Functions proxy, PWA installability, MacCMS VOD API sources, source health checks, diagnostics, and playback URL fixes.

当前维护版已经修复和补齐：

- Cloudflare Pages 根目录静态部署与 Pages Functions 代理。
- 默认视频源筛选、无效源移除、播放直链优先选择。
- 封面图片规范化、无 referrer 加载和代理 fallback。
- 可安装 PWA 与离线应用壳。
- 源健康检查、播放错误分类、诊断页和首次使用引导。
- 版本化配置导入导出，支持旧配置迁移。
- 自动化测试和版本规则。

如果你来自上游仓库，建议先阅读 [MIGRATION.md](MIGRATION.md)。它覆盖没源、不能播放、Cloudflare Pages、密码和代理等常见迁移问题。本仓库只把用户导向代码和文档，不提供公开演示站点。

## 上游迁移入口

- 迁移 FAQ: [MIGRATION.md](MIGRATION.md)
- 讨论入口: [GitHub Discussions](https://github.com/wxst/LibreTV/discussions/9)
- 可复现问题: [GitHub Issues](https://github.com/wxst/LibreTV/issues)
- 最新版本: [GitHub Releases](https://github.com/wxst/LibreTV/releases)

建议先在 Discussions 里确认部署、源和代理配置问题；确认是代码缺陷后再开 Issue。提交问题时不要粘贴密码、令牌、私人源、完整代理链接或公开视频实例地址。

## 重要声明

- 本项目只提供视频搜索与播放工具代码，不存储、上传、分发任何视频内容。
- 本项目仅供学习、研究和个人自部署使用，不建议公开运营实例。
- 部署时必须设置 `PASSWORD` 或 `PASSWORD_HASH`，避免实例被他人公开访问。
- 所有第三方 API 源的可用性、合法性和内容风险由部署者自行判断。
- API、代理、m3u8、视频分片保持 network-only，不做离线视频缓存。

## 快速开始

### 本地开发

```bash
npm install
npm run dev
```

默认访问 `http://localhost:8080`。完整播放和图片代理功能需要使用 `npm run dev` 或 `npm start` 启动 Node.js 服务；简单静态服务器无法提供代理能力。

### Cloudflare Pages

1. Fork 或克隆本仓库。
2. 在 Cloudflare Pages 中连接仓库。
3. 构建设置保持静态根目录部署：
   - Build command: 留空
   - Build output directory: 留空
   - Root directory: 留空
4. 在 Pages 环境变量中设置：
   - `PASSWORD`：普通密码，部署端会注入前端并用于代理鉴权。
   - 或 `PASSWORD_HASH`：SHA-256 哈希形式，适合不暴露明文密码的部署。
5. 如果不想暴露非生产预览入口，将 Preview deployments 设置为 `None`，并关闭 PR comments。
6. 部署后检查：
   - `/VERSION.txt`
   - `/manifest.json`
   - `/service-worker.js`
   - 未授权访问 `/proxy/...` 应返回 401。

### Docker

```bash
docker run -d \
  --name libretv \
  --restart unless-stopped \
  -p 8899:8080 \
  -e PASSWORD=your_password \
  bestzwei/libretv:latest
```

### Docker Compose

```yaml
services:
  libretv:
    image: bestzwei/libretv:latest
    container_name: libretv
    ports:
      - "8899:8080"
    environment:
      - PASSWORD=your_password
    restart: unless-stopped
```

## 默认源策略

默认源只保留通过近期检查的标准 MacCMS VOD API 源。当前默认选中：

- 影视工厂
- 极速资源
- 无尽资源
- 猫眼资源

其他已验证但未默认选中的源会保留在资源列表中，方便用户手动切换。每次调整默认源都需要：

- 验证搜索、详情和至少一个直接可播放 m3u8。
- 移除明显无效、403、返回 HTML 或不支持搜索的源。
- 更新测试和版本号。

## PWA

LibreTV 可以安装为 Web App。安装后会以 standalone 窗口打开。离线时只提供应用壳和离线提示页，搜索、详情、代理和播放仍然需要网络。

PWA 相关文件：

- `manifest.json`
- `service-worker.js`
- `offline.html`
- `image/icon-192.png`
- `image/icon-512-maskable.png`

## 源健康与诊断

设置面板可以检测全部内置源和自定义源的搜索、详情和 m3u8 可访问性，并缓存一份本地报告。诊断页位于 `/diagnostics.html`，用于检查密码保护、代理状态、PWA 状态和源状态，不显示密钥、令牌或密码。

配置导出格式当前为 `LibreTV-Settings` `2.0.0`。导入旧版 `1.0.0` 配置时会校验哈希、过滤未知字段，并提示迁移结果。

## 版本和发布规则

每次用户可见变更都必须同时更新：

- `package.json`
- `package-lock.json`
- `SITE_CONFIG.version` in `js/config.js`
- `VERSION.txt`
- `CHANGELOG.md`

版本语义：

- Patch：修复、源调整、文档和部署维护。
- Minor：用户可见功能新增。
- Major：破坏性配置、部署或数据结构变更。

## 维护路线

短期工作见 [ROADMAP.md](ROADMAP.md)。当前阶段：

1. 已完成公开维护基础：README、CHANGELOG、ROADMAP、模板和 CI。
2. 已完成源健康检查：检测搜索、详情、m3u8 可用性。
3. 已完成播放错误体验：区分源失效、代理失败、浏览器不支持等。
4. 已完成首次使用和诊断页：帮助自部署用户发现环境问题。
5. 正在做 GitHub 仓库优先的低风险引流：上游归档只读时，通过仓库元数据、release、本仓库 Discussions 和 Issues 承接迁移用户；若上游线程可回复，只在相关 issue 中透明说明维护 fork。

## 开发检查

```bash
npm test
node --check js/config.js
node --check js/api.js
node --check js/config-manager.js
node --check js/source-health.js
node --check js/app.js
node --check js/player-errors.js
node --check js/player.js
node --check js/diagnostics.js
node --check js/pwa-register.js
node --check service-worker.js
git diff --check -- . ':(exclude)package-lock.json'
```

页面样式里的 Tailwind 类已预先编译到 `css/tailwind.css`（随仓库提交，Pages 无需构建）。在 HTML 或 JS 里新增、修改 Tailwind 类后运行 `npm run build:css` 重新生成；类名要完整写出（不要拼接成 `bg-${color}`），否则扫描不到。`npm test` 会检查该文件是否过期。

CI 会在 push 和 pull request 上运行测试、JS 语法检查和基础静态检查。
公开维护时建议使用分支和 PR 合并流程，`main` 只作为通过 CI 后的生产部署分支。

可选浏览器 smoke 检查：

```bash
npm run smoke:browser
```

## 贡献

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、[ROADMAP.md](ROADMAP.md) 和 [CHANGELOG.md](CHANGELOG.md)。提交 PR 前请确认：

- 不包含密钥、密码、令牌或私人源。
- 不引入视频内容缓存或内容分发能力。
- 用户可见变更已更新版本号和 changelog。
- `npm test` 和 JS 语法检查通过。

维护者做上游 issue 回复或发布说明时，请遵守 [docs/UPSTREAM_OUTREACH.md](docs/UPSTREAM_OUTREACH.md)：只回复直接相关问题，不批量刷屏，不公开部署地址。

## 许可证

本项目继承 Apache-2.0 许可证。贡献代码即表示同意按 Apache-2.0 分发。
