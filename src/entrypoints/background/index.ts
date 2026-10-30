// Listeners are registered synchronously at the top level, because Chrome's
// service worker is torn down after about 30 s of inactivity (TASKS.md §2.6).
// There are none yet: the tracker, the guard, the badge and the menus arrive
// with M0.2 and later.
export default defineBackground(() => {});
