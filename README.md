# Creator Feed Hub - 跨平台创作者动态追踪展台

基于现代化浏览器扩展（Manifest V3）与全屏展示台构建的独立追踪工具。专为高品质订阅与创作者多平台归集设计。

---

## 🌟 核心特性

1. **零 Cookie 输入 (天然利用浏览器会话)**：
   - 无需手动抓包复制敏感的 `_session_id`、`auth_token`、`SESSDATA`。
   - 只要当前浏览器登录了对应网站，插件自动在后台携带 Cookie 进行无感抓取。
2. **多平台同一博主归集 (1对多关联)**：
   - 一个创作者（例如：爱丽丝 / Alice）名下可同时绑定 TA 在 B站、YouTube、Twitter/X、Fantia、Pixiv、Rplay、Withny、抖音 等平台的多个账号。
3. **被动更新式设计 (点击即查，零后台冗余请求)**：
   - 告别 24 小时不间断的无意义轮询与封号风险。
   - 提供「检查全部更新」或「单独刷新某位博主」，仅在你有需求时触发精准增量更新。
4. **一键快速关注捕获 (Popup)**：
   - 在任意受支持平台浏览创作者主页时，点击浏览器右上角插件图标，秒级识别博主信息，一键入库或关联至已有博主。
5. **全屏独立展台 (Dashboard)**：
   - **聚合动态瀑布流 (Timeline)**：统一卡片式排版，多图画廊灯箱查看，自带 `no-referrer` 防盗链绕过，外链原帖直达。
   - **博主档案管理库 (Creators)**：直观查看每个博主绑定的全部渠道及更新状态，支持单独针对该博主进行更新。
   - **设置中心 (Settings)**：平台登录态一览、一键全量 JSON 备份与还原、请求安全延迟设置。

---

## 🚀 如何安装与使用

### 1. 构建扩展产物
确保本地处于 `creator-feed-hub/` 目录下：
```bash
npm run build
```
构建产物将自动生成在 `creator-feed-hub/.output/chrome-mv3/` 目录下。

### 2. 在浏览器中加载
1. 打开 Chrome、Edge 或其他 Chromium 内核浏览器。
2. 在地址栏输入 `chrome://extensions/`（Edge 输入 `edge://extensions/`）。
3. 开启右上角的 **「开发者模式」 (Developer mode)**。
4. 点击左上角 **「加载已解压的扩展程序」 (Load unpacked)**。
5. 选中目录：`e:\Claude Code\ddbug\creator-feed-hub\.output\chrome-mv3`。

### 3. 开始使用
* **打开展台**：点击浏览器右上角插件图标，在弹窗中点击「打开全屏展台」，即可进入独立大屏 Dashboard。
* **一键添加关注**：在 B站、Twitter 或 Fantia 博主主页点击插件图标，即可一键建立档案或关联到已有博主。
* **体验样例数据**：在展台的「设置中心」可点击「导入演示博主样例」，立即体验完整更新与交互功能。

---

## 📁 目录架构说明

```
creator-feed-hub/
├── assets/
│   └── main.css               # Tailwind CSS v4 样式层与滚动条美化
├── entrypoints/
│   ├── background.ts          # Manifest V3 后台服务脚本 (Service Worker)
│   ├── popup/                 # 浏览器工具栏快捷弹窗 (一键捕获与绑定)
│   │   ├── index.html
│   │   ├── main.ts
│   │   └── App.vue
│   └── dashboard/             # 独立全屏展示台 (Dashboard)
│       ├── index.html
│       ├── main.ts
│       └── App.vue
├── src/
│   ├── types/                 # 核心数据模型 (Creator, Channel, Post, Settings)
│   ├── db/                    # Dexie.js (IndexedDB) 本地数据库持久化层
│   ├── utils/
│   │   └── urlParser.ts       # 8大主流与小众平台 URL 自动识别与解析器
│   └── adapters/              # 各平台抓取适配器
│       ├── bilibili.ts        # B站动态与视频 Web API 适配
│       ├── youtube.ts         # YouTube 官方 RSS 解析
│       ├── twitter.ts         # Twitter / X Syndication SSR 数据适配
│       ├── fantia.ts          # Fantia 官方内部 REST JSON 适配
│       ├── pixiv.ts           # Pixiv 创作者作品列表适配
│       ├── rplay.ts           # Rplay 频道 API 适配
│       ├── withny.ts          # Withny 动态 API 适配
│       ├── douyin.ts          # 抖音 Web 列表适配
│       └── index.ts           # 统一调度器与增量更新逻辑
├── package.json
├── tsconfig.json
└── wxt.config.ts              # 扩展打包与权限配置
```
