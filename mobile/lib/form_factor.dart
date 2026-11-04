/// 形态判定：短边 ≥ 600dp 视为平板/折叠屏展开，保持桌面布局；否则注入移动适配层。
const double tabletBreakpointDp = 600;

bool shouldInjectMobileAdaptation(double shortestSideDp) => shortestSideDp < tabletBreakpointDp;

bool isWideLayout(double shortestSideDp) => shortestSideDp >= tabletBreakpointDp;
