# op_test Logo

OPTEST 品牌标识。设计语言沿用 Web 侧边栏的「圆角方块 + OP」基因，升级为渐变徽章：
**O 内嵌对勾**（呼应「测试通过」），字标为粗体几何无衬线，全部纯矢量路径，无字体依赖。

## 文件

| 文件 | 用途 |
| --- | --- |
| `optest-mark.svg` | 主徽章（512×512，渐变底 + OP 对勾），App 图标 / 头像 / favicon 源 |
| `optest-mark-mono.svg` | 单色徽章（`currentColor` 描边），侧边栏等跟随主题色的场景 |
| `optest-logo-light.svg` / `.png` | 横版组合（徽章 + OPTEST），深色字，用于浅色背景 |
| `optest-logo-dark.svg` / `.png` | 横版组合，白色字，用于深色背景 |
| `optest-mark-{32,64,128,256,512}.png` | 徽章 PNG 尺寸集（32 可作 favicon） |
| `preview-*.png` | 带底色的成品预览图 |
| `gen_horizontal.py` | 横版生成脚本（fontTools 将字形转路径，改字标后重跑即可） |

## 色板

| 角色 | 色值 |
| --- | --- |
| 渐变起（靛蓝） | `#6366F1` |
| 渐变止（青） | `#06B6D4` |
| 对勾（绿） | `#4ADE80` |
| 徽章内图形 | `#FFFFFF` |
| 字标（浅底） | `#0F172A` |
| 字标（深底） | `#F8FAFC` |

## 使用建议

- 最小尺寸：徽章在 32px 下仍清晰（32px 以下建议只用 O+对勾局部）。
- 徽章周围保留 ≥ 1/8 边长的安全区；不要拉伸、旋转渐变或改对勾颜色含义。
- 应用到 dsh web：替换 `deepseek-harness/apps/web/public/favicon.svg` 与侧边栏
  `OpTestMark`（`packages/client/ui-sidebar/src/client/SidebarRoot.tsx`），改完需
  `./dsh.sh build && ./dsh.sh restart`。
