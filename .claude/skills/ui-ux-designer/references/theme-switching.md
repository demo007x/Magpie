# 主题切换完整实现

## CSS 部分

```css
/* 默认（Light） */
:root, [data-theme="light"] {
  --color-bg: #ffffff;
  --color-bg-secondary: #f8f9fa;
  --color-text: #1a1a2e;
  --color-text-secondary: #6b7280;
  --color-border: #e5e7eb;
  --color-primary: #3b82f6;
  --color-primary-hover: #2563eb;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
  --shadow-md: 0 4px 6px rgba(0,0,0,0.1);
}

/* Dark */
[data-theme="dark"] {
  --color-bg: #1a1a2e;
  --color-bg-secondary: #252540;
  --color-text: #e5e7eb;
  --color-text-secondary: #9ca3af;
  --color-border: #374151;
  --color-primary: #60a5fa;
  --color-primary-hover: #3b82f6;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
  --shadow-md: 0 4px 6px rgba(0,0,0,0.4);
}

/* High Contrast (无障碍) */
[data-theme="high-contrast"] {
  --color-bg: #000000;
  --color-text: #ffffff;
  --color-border: #ffffff;
  --color-primary: #ffff00;
  --color-primary-hover: #ffffff;
}
```

## JavaScript 部分

```js
// theme-manager.js

const THEME_KEY = 'preferred-theme';
const VALID_THEMES = ['light', 'dark', 'high-contrast', 'auto'];

function getStoredTheme() {
  return localStorage.getItem(THEME_KEY);
}

function setStoredTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
}

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  const actualTheme = theme === 'auto' ? getSystemTheme() : theme;
  document.documentElement.setAttribute('data-theme', actualTheme);
  
  // 更新 meta theme-color（移动端）
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.content = actualTheme === 'dark' ? '#1a1a2e' : '#ffffff';
  }
}

function initTheme() {
  const stored = getStoredTheme();
  const theme = stored && VALID_THEMES.includes(stored) ? stored : 'auto';
  applyTheme(theme);
  
  // 监听系统主题变化
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (getStoredTheme() === 'auto') {
      applyTheme('auto');
    }
  });
}

function switchTheme(theme) {
  if (!VALID_THEMES.includes(theme)) return;
  setStoredTheme(theme);
  applyTheme(theme);
}

// 初始化
document.addEventListener('DOMContentLoaded', initTheme);
```

## Tailwind 部分

```js
// tailwind.config.js
module.exports = {
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--color-bg)',
        'bg-secondary': 'var(--color-bg-secondary)',
        text: 'var(--color-text)',
        'text-secondary': 'var(--color-text-secondary)',
        border: 'var(--color-border)',
        primary: 'var(--color-primary)',
        'primary-hover': 'var(--color-primary-hover)',
      }
    }
  }
}
```

## React Hook 示例

```tsx
// useTheme.ts
import { useState, useEffect } from 'react';

type Theme = 'light' | 'dark' | 'high-contrast' | 'auto';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('preferred-theme');
    return (stored as Theme) || 'auto';
  });

  useEffect(() => {
    const actual = theme === 'auto'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      : theme;
    document.documentElement.setAttribute('data-theme', actual);
    localStorage.setItem('preferred-theme', theme);
  }, [theme]);

  return { theme, setTheme };
}
```
