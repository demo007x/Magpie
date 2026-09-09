# 跨平台样式同步方案对比

## 方案对比表

| 方案 | 原理 | 优点 | 缺点 | 推荐场景 |
|------|------|------|------|----------|
| Style Dictionary | 令牌 → 多格式输出 | 生态成熟、支持格式多 | 需要 Node.js 构建步骤 | 中大型项目 |
| Tailwind Config | 单一 config → 多框架 | 轻量、无构建依赖 | 仅限 Tailwind 生态 | Tailwind 项目 |
| CSS 自定义属性 | 运行时读取 CSS 变量 | 零依赖、浏览器原生 | 不支持复杂转换 | 小型项目 / 快速原型 |
| Figma Tokens Studio | 设计工具 → 代码 | 设计师主导、无代码 | 需要手动同步 | 设计驱动团队 |
| 手写同步脚本 | 自定义转换逻辑 | 完全可控 | 维护成本高 | 特殊需求 |

## Style Dictionary 完整配置

```js
// style-dictionary.config.js
module.exports = {
  source: ['design-tokens/**/*.json'],
  platforms: {
    css: {
      transformGroup: 'web',
      buildPath: 'dist/css/',
      files: [
        {
          destination: 'tokens.css',
          format: 'css/variables',
          options: {
            outputReferences: true,  // 保留引用关系
          }
        },
        {
          destination: 'theme-dark.css',
          format: 'css/variables',
          options: {
            selector: '[data-theme="dark"]',
            outputReferences: true,
          }
        }
      ]
    },
    scss: {
      transformGroup: 'scss',
      buildPath: 'dist/scss/',
      files: [{ destination: '_tokens.scss', format: 'scss/variables' }]
    },
    js: {
      transformGroup: 'js',
      buildPath: 'dist/js/',
      files: [{ destination: 'tokens.js', format: 'javascript/es6' }]
    },
    android: {
      transformGroup: 'android',
      buildPath: 'dist/android/',
      files: [{ destination: 'tokens.xml', format: 'android/resources' }]
    },
    ios: {
      transformGroup: 'ios',
      buildPath: 'dist/ios/',
      files: [{ destination: 'tokens.plist', format: 'ios/plist' }]
    }
  }
};
```

## Figma Tokens Studio 工作流

```
设计团队在 Figma 中编辑令牌
        ↓
点击 "Push to GitHub"
        ↓
GitHub Actions 自动触发
        ↓
Style Dictionary 构建
        ↓
合并到 main 分支
        ↓
开发团队拉取更新
```

### GitHub Actions 配置示例

```yaml
name: Sync Design Tokens
on:
  push:
    paths: ['design-tokens/**']

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npx style-dictionary build
      - uses: actions/create-pull-request@v5
        with:
          title: 'chore: update design tokens'
          body: 'Auto-generated from Figma Tokens Studio'
```

## 小程序跨平台同步方案

微信小程序不支持 CSS 自定义属性，需要用 JS 动态设置：

```js
// app.js
App({
  globalData: {
    theme: 'light',
    tokens: require('./tokens.json'),
  },
  
  switchTheme(theme) {
    this.globalData.theme = theme;
    const tokens = this.globalData.tokens[theme];
    // 动态设置页面样式
    const pages = getCurrentPages();
    pages.forEach(page => {
      page.setData({ themeTokens: tokens });
    });
  }
});
```
