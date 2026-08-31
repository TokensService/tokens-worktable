#!/usr/bin/env python3
"""生成 op_test 横版 logo：徽章 + OPTEST 字标（字形转纯矢量路径，无字体依赖）。"""
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
font = TTFont(FONT)
glyph_set = font.getGlyphSet()
cmap = font.getBestCmap()
UPM = font["head"].unitsPerEm  # 2048

# 目标字标 cap-height（字母顶到基线）= 96，字号按 H 的 cap height 换算
CAP = 96.0
cap_units = 1493  # DejaVu Sans Bold 实测 cap height
scale = CAP / cap_units
TRACK = 6  # 字距（px）

def glyph_path(ch):
    g = glyph_set[cmap[ord(ch)]]
    pen = SVGPathPen(glyph_set)
    g.draw(pen)
    return pen.getCommands(), g.width

def layout(text):
    """返回 [(path_d, advance_px)]，坐标已按 scale 缩放、y 轴翻转到 SVG 坐标（基线 y=0）。"""
    out = []
    for ch in text:
        d, adv = glyph_path(ch)
        out.append((d, adv * scale))
    return out

def text_group(text, x0, fill, extra=""):
    """生成一组 <path>，基线在 y=0，起始 x=x0；返回 (paths, 结束 x)。"""
    parts = []
    x = x0
    for d, adv in layout(text):
        # 字体坐标 y 向上，缩放后翻转：translate(x,0) scale(s,-s)
        parts.append(
            f'<path transform="translate({x:.2f} 0) scale({scale:.6f} {-scale:.6f})" d="{d}" fill="{fill}"{extra}/>'
        )
        x += adv + TRACK
    end = x - TRACK
    return "\n    ".join(parts), end

MARK = """<g transform="translate(0 0) scale(0.25)">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#6366F1"/>
        <stop offset="1" stop-color="#06B6D4"/>
      </linearGradient>
    </defs>
    <rect x="16" y="16" width="480" height="480" rx="120" fill="url(#bg)"/>
    <circle cx="157" cy="256" r="84" fill="none" stroke="#FFFFFF" stroke-width="44"/>
    <path d="M 134 252 L 152 270 L 184 230" fill="none" stroke="#4ADE80" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M 311 340 L 311 172 L 377 172 A 62 62 0 0 1 377 296 L 311 296" fill="none" stroke="#FFFFFF" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>
  </g>"""

# 徽章 128x128，基线 y = 64 + 96/2 = 112（cap 顶对齐 y=16 区域微调：视觉中心对齐）
BASE_Y = 112
TEXT_X = 128 + 28

def build(test_fill):
    op_paths, op_end = text_group("OP", TEXT_X, "url(#wordGrad)")
    test_paths, test_end = text_group("TEST", op_end + 14, test_fill)
    width = int(test_end + 8)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="128" viewBox="0 0 {width} 128">
  <defs>
    <linearGradient id="wordGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6366F1"/>
      <stop offset="1" stop-color="#06B6D4"/>
    </linearGradient>
  </defs>
  {MARK}
  <g transform="translate(0 {BASE_Y})">
    {op_paths}
    {test_paths}
  </g>
</svg>
"""

with open("assets/logo/optest-logo-light.svg", "w") as f:
    f.write(build("#0F172A"))
with open("assets/logo/optest-logo-dark.svg", "w") as f:
    f.write(build("#F8FAFC"))
print("ok")
