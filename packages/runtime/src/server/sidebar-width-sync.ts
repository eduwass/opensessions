export const MIN_SIDEBAR_WIDTH = 20;

export function clampSidebarWidth(width: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, width);
}
