# 阶段 3 原创视觉资产

状态：已生成并接入首页。以下资产只表达通用的“紫藤深宅”氛围，不包含真实剧本、角色、线索或剧情暗示。

## 交付文件

| 文件 | 用途 | 规格 | 发布体积 |
| --- | --- | --- | --- |
| `public/images/home/manor-winter-garden.webp` | 首页首屏宅邸氛围背景 | 1717 × 916，WebP | 约 93 KB |
| `public/images/home/wisteria-cascade.webp` | 页边透明紫藤枝饰 | 720 × 1080，WebP alpha | 约 249 KB |
| `public/images/home/aubergine-silk-texture.webp` | 全页与首屏低对比纹理 | 640 × 640，可平铺 WebP | 约 7 KB |

发布文件由生成结果做无内容改动的尺寸与编码优化。透明枝饰必须保留 alpha；纹理替换时应重新检查四边衔接。

## 生成方式

- 模式：Codex 内置 `image_gen`。
- 分类：`stylized-concept`。
- 输入图：无。
- 共同限制：无文字、无标志、无水印、无人物、无角色画像、无武器、无血迹、无线索卡、无文件、无剧情专属物件。

## 最终 Prompt

### 宅邸氛围主图

```text
Use case: stylized-concept
Asset type: responsive landing page hero background for a Chinese mystery-game website
Primary request: an original, atmospheric grand manor winter garden at night, elegant and quietly suspenseful but not frightening
Scene/backdrop: empty opulent conservatory inside an old luxury mansion, tall arched windows, dark carved wood, muted stone floor, abundant wisteria vines and soft foliage, faint mist outside the glass
Subject: architecture and plants only; no people and no narrative props
Style/medium: cinematic painterly realism with refined editorial finish, believable materials, subtle fine grain
Composition/framing: very wide landscape composition; keep the left half dark, calm, and low-detail as safe negative space for a large headline; architectural depth and wisteria interest concentrated toward the center-right; edges must crop gracefully for desktop, tablet, and mobile cover usage
Lighting/mood: moonlit violet ambience with a restrained warm antique-gold glow in the distant interior, luxurious, secretive, sophisticated
Color palette: deep aubergine, charcoal plum, dusty lilac, desaturated moss green, restrained antique gold
Materials/textures: velvet darkness, aged wood grain, lightly weathered stone, glass reflections, delicate petals
Constraints: generic atmosphere only; no text; no letters; no logos; no watermark; no people; no faces; no portraits; no weapons; no blood; no crime scene; no clue cards; no documents; no readable symbols; no branded architecture; no story-specific objects
Avoid: horror gore, haunted-house clichés, bright neon purple, oversaturated fantasy, obvious AI symmetry, busy detail on the left
```

### 透明紫藤枝饰

```text
Use case: stylized-concept
Asset type: transparent botanical overlay for a responsive luxury mystery-game website
Primary request: one original cascading wisteria botanical spray, refined and natural, designed as a decorative corner overlay
Subject: slender winding vine with several elegant clusters of dusty-purple wisteria blossoms and a restrained number of muted moss-green leaves
Style/medium: painterly botanical realism with crisp cutout edges and delicate translucent petals
Composition/framing: tall diagonal cascade entering from the upper right and flowing downward; irregular organic silhouette; generous empty transparent area around the plant; must crop gracefully on desktop, tablet, and mobile
Lighting/mood: dim moonlit highlights with subtle antique-gold rim light, sophisticated and quiet
Color palette: dusty lilac, muted aubergine, desaturated moss green, tiny antique-gold accents
Materials/textures: fine petals, believable leaves, slender woody stem
Constraints: genuinely transparent background with preserved alpha channel; isolated plant only; no rectangle or backdrop; no text; no logo; no watermark; no people; no insects; no vases; no ribbons; no crime or story objects
Avoid: bright neon purple, oversaturated flowers, wedding decoration, symmetrical bouquet, hard white halo, opaque checkerboard pattern
```

### 深紫轻纹理

```text
Use case: stylized-concept
Asset type: seamless tileable website background texture
Primary request: a subtle, luxurious dark aubergine texture combining aged silk wallpaper, faint handmade-paper fibers, and barely visible botanical wisteria shadows
Scene/backdrop: flat evenly lit material sample, not a room or scene
Subject: texture only, no focal object
Style/medium: refined matte material texture, realistic but restrained
Composition/framing: square seamless tile; uniform visual density; every edge must connect cleanly to its opposite edge; no central medallion and no obvious repeated motif
Lighting/mood: low contrast, quiet, tactile, sophisticated
Color palette: near-black plum, deep aubergine, charcoal violet, extremely subtle dusty lilac fibers
Materials/textures: fine silk weave, faint paper grain, whisper-soft organic leaf shadows
Constraints: truly seamless on all four edges; no text; no letters; no logos; no watermark; no objects; no hard lighting; no border; no frame; no vignette; no bright spots
Avoid: visible flowers, decorative wallpaper pattern, high contrast, noise speckles, scratches, stains, obvious tile repetition, purple neon
```

## 复核要求

替换或重新生成资产后至少检查：

1. 主图在电脑、Pad、手机 `cover` 裁切下不遮挡标题与账户入口。
2. 紫藤枝饰仍含真实透明通道，透明像素最小值应为 0。
3. 纹理左右边、上下边不存在肉眼可见接缝。
4. 页面在 320px 宽度无横向溢出，装饰不拦截指针与键盘操作。
5. 公共仓库中没有生成源参考、真实剧本内容或本机生成路径。
