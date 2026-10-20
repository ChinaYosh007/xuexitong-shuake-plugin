/**
 * 可运行页面路径判定（纯字符串，不读取页面内容）。
 *
 * 2026-10-20 用户授权（验收 §9.27）：独立作业/测验作答页（dowork）纳入刷题自动运行；
 * 正式考试路径一律拒绝。侧边栏路由与课程页守卫共用本模块，避免两处正则漂移。
 */
export function isCourseTaskPath(pathname: string): boolean {
  return /\/mycourse\/studentstudy\/?$/.test(pathname);
}
export function isWorkPagePath(pathname: string): boolean {
  return /^\/mooc-ans\/mooc2\/work\/dowork\/?$/.test(pathname);
}
export function isExamPath(pathname: string): boolean {
  return /\/exam(?:-|\/|$)|\/examination/i.test(pathname);
}
