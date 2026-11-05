# 04 — 设置图标迁移到官方 slot

**What to build:** Team 设置导航在桌面和窄屏使用官方图标扩展点显示 Team 标记，不再观察或修改宿主 DOM。
**Blocked by:** 01, 02
**Status:** done

- [x] 图标通过 `settings.section.icon` 注册，id 与 Team section 完全一致，并使用宿主提供的尺寸。（`active` 故意不读：宿主自己的 `navIcon(id)` 字形也忽略它——行内墨水恒定，只有背景变；Vera 已确认这是宿主先例。）
- [x] MutationObserver、DOM 标记、旧 CSS 覆盖及其无效测试断言全部删除，没有并行保留旧路径。
- [x] 设置页打开、语言切换、active 变化和插件卸载后均正确渲染或清理，不出现重复 section 或残留图标。
- [x] 桌面与 390×844 浏览器证据通过，普通 DSH 进出恢复和控制台检查无回归。
