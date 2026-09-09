# AI设计工具矩阵

## 一、图像生成

| 工具 | 强项 | 提示词要点 | 适用场景 |
|------|------|-----------|---------|
| Midjourney | 艺术感强、风格多样 | `--ar 比例 --v 版本 --style raw` | 海报、插画、概念图 |
| DALL-E 3 | 文字渲染、指令遵循 | 自然语言描述即可 | 含文字设计、创意验证 |
| Stable Diffusion | 开源可控、模型丰富 | ControlNet精准控制 | 批量生成、定制需求 |
| Ideogram | 文字设计极强 | `typography, logo, text:"xxx"` | Logo、海报标题 |
| Flux | 写实+艺术平衡 | `--style raw --ar` | 商业摄影替代 |

---

## 二、UI/UX设计

| 工具 | 功能 | AI能力 | 适用 |
|------|------|-------|------|
| Figma | 协作设计 | AI插件生态（Magician/Font Explorer） | UI系统、原型 |
| Framer | 网站生成 | AI生成网站（`/generate`） | 快速落地页 |
| Uizard | 线稿转UI | 线稿→高保真 | 概念验证 |
| Galileo AI | 文字生成UI | 文本描述→界面 | 快速原型 |

---

## 三、品牌设计

| 工具 | 功能 | 特点 |
|------|------|------|
| Looka | Logo+VI生成 | 行业模板+定制 |
| Brandmark | 品牌视觉系统 | Logo+色彩+字体+应用 |
| Canva | 快速设计 | 模板丰富+AI魔改 |
| Khroma | 配色方案 | 个性化配色推荐 |

---

## 四、提示词模板

### 海报设计
```
[主题] poster design, [风格] style, [色调] color palette, 
[元素] elements, [氛围] mood, 
professional design, high quality, --ar 3:4 --v 6
```

### Logo设计
```
minimalist logo design for [品牌名], [行业] industry, 
[风格] style (geometric/organic/typographic), 
[色彩] colors, clean lines, vector style, white background
```

### 包装设计
```
[产品] packaging design, [风格] aesthetic, 
[目标人群] target audience, [卖点] key feature,
product photography style, --ar 1:1
```

### 国潮风格
```
Chinese traditional [元素] pattern, modern interpretation, 
[色彩] colors, minimalist style, 
Guochao aesthetic, elegant, premium quality, --ar 3:4
```

---

## 五、AI设计工作流

### 概念阶段
```
需求 → Midjourney/DALL-E 批量生成概念 → 筛选优质方向
```

### 深化阶段
```
选定概念 → Stable Diffusion + ControlNet 精修 → 细节调整
```

### 落地阶段
```
AI生成素材 → Figma/PS 排版整合 → 输出成品
```

### 协作要点
- AI生成占30%：概念发散、素材生成
- 人工把控占70%：审美判断、细节打磨、品牌对齐

---

## 六、人机协同原则

| 原则 | 说明 |
|------|------|
| 审美主导 | AI是工具，人是审美决策者 |
| 风格一致 | 建立Prompt库保持品牌调性 |
| 迭代优化 | 生成→筛选→精修→再生成 |
| 版权意识 | 注意AI生成内容的商用授权 |
| 原创保护 | 核心创意由人主导，AI辅助执行 |
