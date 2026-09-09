# W3C Design Tokens Community Group 规范详解

## 核心概念

设计令牌（Design Tokens）是设计系统中可复用的最小单位，代表一个设计决策。

## 令牌结构

```json
{
  "color": {
    "core": {
      "blue-500": {
        "value": "#3b82f6",
        "$type": "color",
        "$description": "Primary brand blue"
      }
    },
    "semantic": {
      "primary": {
        "value": "{color.core.blue-500}",
        "$type": "color"
      }
    }
  }
}
```

## 值类型（$type）

| 类型 | 说明 | 示例值 |
|------|------|----------|
| `color` | 颜色 | `#3b82f6` / `rgb(59,130,246)` / `hsl(217,91%,60%)` |
| `dimension` | 尺寸 | `16px` / `1rem` / `2em` |
| `fontFamily` | 字体族 | `"Inter, system-ui, sans-serif"` |
| `fontWeight` | 字重 | `400` / `bold` |
| `number` | 数值 | `1.5` |
| `string` | 字符串 | `"Inter"` |
| `strokeStyle` | 边框样式 | `solid` / `dashed` |
| `border` | 边框 | `{ "color": "{color...}", "width": "1px", "style": "solid" }` |
| `transition` | 过渡 | `{ "duration": "200ms", "timingFunction": "ease-in-out" }` |

## 分组规范

- **core**：不随主题变化的原始值（primitive values）
- **semantic**：语义化令牌，随主题变化
- **component**：组件级令牌，最具体

## 引用语法

用 `{path.to.token}` 引用其他令牌的值：

```json
{
  "color": {
    "core": {
      "blue-500": { "value": "#3b82f6" }
    },
    "semantic": {
      "primary": { "value": "{color.core.blue-500}" }
    }
  }
}
```

## 分组输出

推荐输出结构：

```
dist/
├── tokens.css        # CSS 自定义属性
├── _tokens.scss     # SCSS 变量
├── tokens.js        # ES6 模块
├── tokens.android.xml  # Android 资源
├── tokens.ios.json  # iOS plist
└── tokens.figma.json   # Figma Tokens Studio
```
