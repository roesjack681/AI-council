import { CouncilDB } from '../database/db';
import { CouncilService } from '../services/council-service';
import { browserPort } from './browser-port';
import { trustedSender } from '../protocols/commands';
import { log } from '../utils/logger';
const db = new CouncilDB();
const service = new CouncilService(db, browserPort);
const ready = service.initialize();
async function updateBadge(): Promise<void> {
  const count = await db.discussions
    .where('status')
    .anyOf('COMPLETED', 'UNRESOLVED', 'FAILED')
    .count();
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#22694d' });
  await chrome.action.setTitle({
    title: count ? `AI Council · ${count} 份已结束任务报告` : '打开 AI Council',
  });
}
async function fail(code: string): Promise<void> {
  try {
    await log(db, 'error', code, '后台操作失败；请打开侧边栏查看本地日志。');
  } catch {
    console.error('AI Council: DATABASE_UNAVAILABLE');
  }
}
async function schedule(): Promise<void> {
  if (!(await chrome.alarms.get('council-tick')))
    await chrome.alarms.create('council-tick', { periodInMinutes: 0.5 });
}
chrome.runtime.onMessage.addListener(
  (raw: unknown, sender, respond: (response: unknown) => void) => {
    if (!trustedSender(sender, chrome.runtime.id)) {
      respond({ ok: false, error: 'UNTRUSTED_SENDER' });
      return false;
    }
    void ready
      .then(() => service.execute(raw))
      .then(async (result) => {
        await updateBadge().catch(() => fail('BADGE_UPDATE_FAILED'));
        respond(result);
      })
      .catch(() =>
        respond({
          ok: false,
          error: 'DATABASE_UNAVAILABLE: 本地数据库无法访问，请检查存储权限与磁盘空间。',
        }),
      );
    return true;
  },
);
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .then(schedule)
    .catch(() => fail('INSTALL_SETUP_FAILED'));
});
chrome.runtime.onStartup.addListener(() => {
  void ready.then(schedule).catch(() => fail('STARTUP_FAILED'));
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'council-tick')
    void ready
      .then(() => service.execute({ type: 'tick' }))
      .then(updateBadge)
      .catch(() => fail('SCHEDULER_FAILED'));
});
void ready
  .then(schedule)
  .then(updateBadge)
  .catch(() => fail('INITIALIZATION_FAILED'));
