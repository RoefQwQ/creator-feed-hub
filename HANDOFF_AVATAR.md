# Creator Feed Hub 头像问题交接记录

## 用户目标

- 在 Popup 添加/关注创作者时，获取当前页面对应创作者的头像。
- 不能把当前登录用户头像识别为创作者头像。
- 一个创作者可能绑定多个平台账号，并拥有多个平台头像。
- 提供机制让用户选择其中一个作为创作者主头像，并保存选择结果。

## 已确认事实

- 当前 Chrome 加载目录为：`.output/chrome-mv3`。
- 源码修改不会自动更新该目录；需要重新生成输出后，在 `chrome://extensions` 重新加载扩展。
- 当前截图对应 Bilibili 创作者主页。页面上能看到创作者头像，但 Popup 添加界面没有正确显示该头像。
- 之前曾出现 Popup 把当前登录用户头像识别为创作者头像的问题。
- 不能使用“扫描页面所有图片、取第一张图片或按关键词猜头像”的方式解决，因为会再次误识别。
- 当前尚未通过真实 DOM 调试确认 Bilibili 页面头像元素的准确结构、属性和加载时机。
- 当前尚未确认最终可靠的头像提取方案。

## 已发生的代码变更

提交记录：

```text
5e10929 fix: normalize platform avatar URLs
de58a4b feat: choose primary creator avatar
0545627 fix: capture Bilibili avatar when following
1874ba4 fix: avoid selecting viewer avatar
```

### URL 规范化

已加入头像/媒体 URL 规范化，处理协议相对 URL，例如：

```text
//host/path -> https://host/path
```

### 主头像选择

`Creator` 已增加：

```ts
primaryAvatarUrl?: string
```

Dashboard 创作者卡片已有“选择主头像”入口，能够列出该创作者绑定账号中已有 `avatarUrl` 的账号，选择后写入本地数据库并更新 `Creator.avatar` 与 `Creator.primaryAvatarUrl`。

该功能已经执行过构建，但真实界面操作尚未由自动化环境验收。

### Popup Bilibili 识别代码

Popup 的 `extractActiveTabAuthorMeta` 负责从当前页面提取姓名和头像，并在添加时写入 Creator/Channel。

该处经过多次尝试，最近修改过 Bilibili 分支。源码需要接手 agent 先重新读取和检查，不能假定现有选择器已经正确。

## 接手时必须注意

- 不启动新的 Chrome/Chromium 窗口。
- 不重启用户 Chrome。
- 不使用 relay/CDP 接管用户登录环境，除非用户明确授权。
- 不修改平台同步请求逻辑，除非用户另行要求。
- 不把尚未验证的 DOM 结构、根因或方案写成结论。
- 不继续盲目添加选择器。
- 不使用全页面图片扫描作为头像识别兜底。
- 修改前先读取当前文件实际内容；修改后先做静态检查。
- 构建成功不等于头像功能已验证成功。

## 当前待解决问题

1. 确认 Popup 获取到的当前 Tab 页面 DOM 中，创作者头像实际是什么元素和属性。
2. 确认该头像与当前登录用户头像如何区分。
3. 确认 Popup 执行脚本的时机是否早于页面头像渲染。
4. 在不误识别的前提下修复提取逻辑。
5. 生成 `.output/chrome-mv3` 后由用户手动重新加载和验收。

## 交接原则

本文件只记录用户目标、已观察现象、已经发生的修改和明确限制。未经过实际页面或代码验证的内容不作为根因、结论或固定开发方向。
