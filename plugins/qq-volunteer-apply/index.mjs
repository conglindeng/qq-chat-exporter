import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CONFIG = {
  adminQQ: '',
  whitelistGroups: [],
  recruitKeywords: ['志愿者招募', '招募志愿者', '志愿者征集', '志愿者报名'],
  defaultApplyText: '25秘书转2班华雪',
  adminWindowMinutes: 30,
  listenAheadMinutes: 2,
  listenLateMinutes: 5,
  dedupHours: 24,
  timezone: 'Asia/Shanghai'
};

const TASK_STATUS = {
  WAIT_ADMIN: 'WAIT_ADMIN',
  READY: 'READY',
  WAIT_UNMUTE: 'WAIT_UNMUTE',
  SENDING: 'SENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED'
};

const TERMINAL_STATUS = new Set([
  TASK_STATUS.SUCCESS,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
  TASK_STATUS.EXPIRED
]);

let pluginInstance = null;
let pluginInitializing = false; // 防止并发初始化

function nowTs() {
  return Date.now();
}

function formatTs(ts) {
  if (!ts) return '未知';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function normalizeText(text) {
  return String(text || '').replace(/\r/g, '').replace(/\u00A0/g, ' ').trim();
}

function ensureFile(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallbackValue, null, 2), 'utf8');
  }
}

function isNetworkError(error) {
  const msg = String(error?.message || error || '');
  return /(network|timeout|timed out|ECONN|ENET|socket)/i.test(msg);
}

function adjustAmPm(period, hour) {
  if (period === '下午' || period === '晚上') return hour < 12 ? hour + 12 : hour;
  if (period === '中午') return hour < 11 ? hour + 12 : hour;
  if (period === '凌晨') return hour === 12 ? 0 : hour;
  if (period === '上午' || period === '早上') return hour === 12 ? 0 : hour;
  return hour;
}

function findStartCandidate(text) {
  const lines = text.split('\n').map((v) => v.trim()).filter(Boolean);
  const startLine = lines.find((line) => /开始|开抢/.test(line) && /(\d{1,2}[:：点时])/.test(line));
  if (startLine) return startLine;
  const anyStart = lines.find((line) => /开始|开抢/.test(line));
  if (anyStart) return anyStart;
  const recruitLine = lines.find((line) => /招募/.test(line) && /(\d{1,2}[:：点时])/.test(line));
  if (recruitLine) return recruitLine;
  return text;
}

function parseStartTime(rawText, baseTs = Date.now()) {
  const text = normalizeText(rawText);
  if (!text) return null;
  const candidate = findStartCandidate(text);
  const now = new Date(baseTs);

  let m = candidate.match(/(\d{1,2})月(\d{1,2})[日号]?\s*(上午|下午|中午|晚上|凌晨|早上)?\s*(\d{1,2})(?:[:：点时](\d{1,2})?)?/);
  if (m) {
    const month = Number(m[1]) - 1;
    const day = Number(m[2]);
    const hour = adjustAmPm(m[3] || '', Number(m[4]));
    const minute = m[5] ? Number(m[5]) : 0;
    let d = new Date(now.getFullYear(), month, day, hour, minute, 0, 0);
    if (d.getTime() < baseTs) {
      // 如果日期已过，判断是否应该加一年
      // 只有当月份比当前月份小2个月以上，或者月份相同但日期已过，才加一年
      const monthDiff = month - now.getMonth();
      if (monthDiff < -1 || (monthDiff === 0 && day < now.getDate())) {
        d.setFullYear(d.getFullYear() + 1);
      }
    }
    return d.getTime();
  }

  m = candidate.match(/(今天|明天)\s*(上午|下午|中午|晚上|凌晨|早上)?\s*(\d{1,2})(?:[:：点时](\d{1,2})?)?/);
  if (m) {
    const dayOffset = m[1] === '明天' ? 1 : 0;
    const hour = adjustAmPm(m[2] || '', Number(m[3]));
    const minute = m[4] ? Number(m[4]) : 0;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute, 0, 0).getTime();
  }

  const wdMap = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  m = candidate.match(/(?:周|星期)([一二三四五六日天])\s*(上午|下午|中午|晚上|凌晨|早上)?\s*(\d{1,2})(?:[:：点时](\d{1,2})?)?/);
  if (m) {
    const targetW = wdMap[m[1]];
    const hour = adjustAmPm(m[2] || '', Number(m[3]));
    const minute = m[4] ? Number(m[4]) : 0;
    const d = new Date(baseTs);
    d.setHours(hour, minute, 0, 0);
    const deltaRaw = targetW - d.getDay();
    let delta = deltaRaw;
    if (delta < 0) delta += 7;
    if (delta === 0 && d.getTime() <= baseTs) delta = 7;
    d.setDate(d.getDate() + delta);
    return d.getTime();
  }

  m = candidate.match(/(\d{1,2})[:：](\d{1,2})/);
  if (m) {
    const d = new Date(baseTs);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() < baseTs) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  m = candidate.match(/(上午|下午|中午|晚上|凌晨|早上)?\s*(\d{1,2})点(?:半|整|(\d{1,2})分?)?/);
  if (m) {
    const hour = adjustAmPm(m[1] || '', Number(m[2]));
    const minute = m[3] ? Number(m[3]) : /半/.test(m[0]) ? 30 : 0;
    const d = new Date(baseTs);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() < baseTs) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  return null;
}

function parsePatchTime(input, baseTs = Date.now()) {
  const text = normalizeText(input);
  const m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})/);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0).getTime();
  }
  return parseStartTime(text, baseTs);
}

class VolunteerApplyPlugin {
  constructor(bridge, skipEventSubscription = false) {
    this.bridge = bridge;
    this.interval = null;
    this.unsubscribers = [];
    this.tickRunning = false; // 防止 tick 并发执行
    this.skipEventSubscription = skipEventSubscription; // 跳过手动订阅（使用 plugin_onmessage 回调）

    this.configPath = path.join(__dirname, 'config.json');
    this.tasksPath = path.join(__dirname, 'tasks.json');
    this.runtimePath = path.join(__dirname, 'runtime-state.json');

    this.config = this.loadConfig();
    this.tasks = this.loadTasks();
    this.runtime = this.loadRuntime();
  }

  log(...args) {
    this.bridge?.core?.context?.logger?.log?.('[VolunteerApply]', ...args) || console.log('[VolunteerApply]', ...args);
  }

  warn(...args) {
    this.bridge?.core?.context?.logger?.logWarn?.('[VolunteerApply]', ...args) || console.warn('[VolunteerApply]', ...args);
  }

  error(...args) {
    this.bridge?.core?.context?.logger?.logError?.('[VolunteerApply]', ...args) || console.error('[VolunteerApply]', ...args);
  }

  loadConfig() {
    ensureFile(this.configPath, DEFAULT_CONFIG);
    const raw = fs.readFileSync(this.configPath, 'utf8');
    const cfg = JSON.parse(raw || '{}');
    return {
      ...DEFAULT_CONFIG,
      ...cfg,
      whitelistGroups: Array.isArray(cfg.whitelistGroups) ? cfg.whitelistGroups.map((v) => String(v)) : [],
      recruitKeywords: Array.isArray(cfg.recruitKeywords) ? cfg.recruitKeywords : DEFAULT_CONFIG.recruitKeywords
    };
  }

  loadTasks() {
    ensureFile(this.tasksPath, { tasks: [] });
    const raw = fs.readFileSync(this.tasksPath, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  }

  loadRuntime() {
    ensureFile(this.runtimePath, { activeTaskId: null });
    const raw = fs.readFileSync(this.runtimePath, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return { activeTaskId: parsed.activeTaskId || null };
  }

  saveAll() {
    try {
      fs.writeFileSync(this.tasksPath, JSON.stringify({ tasks: this.tasks }, null, 2), 'utf8');
      fs.writeFileSync(this.runtimePath, JSON.stringify(this.runtime, null, 2), 'utf8');
    } catch (error) {
      this.error('保存状态文件失败:', error?.message || error);
    }
  }

  getActiveTask() {
    if (!this.runtime.activeTaskId) return null;
    return this.tasks.find((t) => t.taskId === this.runtime.activeTaskId) || null;
  }

  generateTaskId() {
    return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  extractText(event) {
    if (typeof event?.raw_message === 'string') return event.raw_message;
    if (typeof event?.message === 'string') return event.message;
    if (Array.isArray(event?.message)) {
      return event.message
        .map((seg) => {
          if (typeof seg === 'string') return seg;
          if (seg?.type === 'text') return seg?.data?.text || '';
          return '';
        })
        .join('');
    }
    return '';
  }

  isRecruitMessage(text) {
    const clean = normalizeText(text);
    if (!clean) return false;
    return this.config.recruitKeywords.some((k) => clean.includes(k));
  }

  parseActivityKey(text) {
    const clean = normalizeText(text);
    const m = clean.match(/活动内容[：:]\s*(.+)/);
    if (!m) return '';
    const activityKey = m[1].trim();
    // 限制活动内容最大长度为 100 字符，防止恶意超长输入
    return activityKey.slice(0, 100);
  }

  parseRecruit(text) {
    const clean = normalizeText(text);
    return {
      isRecruit: this.isRecruitMessage(clean),
      activityKey: this.parseActivityKey(clean),
      startTime: parseStartTime(clean, nowTs()),
      rawText: clean
    };
  }

  async callAction(name, params) {
    const { actions, instance, ctx } = this.bridge;

    if (ctx?.actions?.call) {
      return ctx.actions.call(name, params || {});
    }

    const handler = actions?.get?.(name);
    if (!handler?.handle) {
      throw new Error(`action ${name} 不可用`);
    }
    const result = await handler.handle(params || {}, 'plugin', instance?.config);
    return result?.data ?? result;
  }

  async sendPrivate(userId, text) {
    await this.callAction('send_private_msg', { user_id: Number(userId), message: text });
  }

  async sendGroup(groupId, text) {
    await this.callAction('send_group_msg', { group_id: Number(groupId), message: text });
  }

  async notifyAdmin(text) {
    const adminQQ = String(this.config.adminQQ || '');
    if (!adminQQ) {
      this.warn('未配置 adminQQ，跳过管理员通知:', text);
      return;
    }
    try {
      await this.sendPrivate(adminQQ, text);
    } catch (error) {
      this.error('发送管理员私聊失败', error?.message || error);
    }
  }

  isAllMutedOffEvent(event) {
    if (event?.post_type !== 'notice' || event?.notice_type !== 'group_ban') return false;
    if (Number(event?.user_id) !== 0) return false;
    return Number(event?.duration) === 0;
  }

  isPrivateFromAdmin(event) {
    return (
      event?.post_type === 'message' &&
      event?.message_type === 'private' &&
      String(event?.user_id || '') === String(this.config.adminQQ || '')
    );
  }

  isWhiteGroup(groupId) {
    return this.config.whitelistGroups.includes(String(groupId));
  }

  isTerminal(status) {
    return TERMINAL_STATUS.has(status);
  }

  async handleGroupMessage(event) {
    const groupId = String(event?.group_id || '');
    if (!groupId || !this.isWhiteGroup(groupId)) return;

    const text = this.extractText(event);
    const parsed = this.parseRecruit(text);
    if (!parsed.isRecruit) return;

    const active = this.getActiveTask();
    if (active && !this.isTerminal(active.status)) {
      await this.notifyAdmin(`当前已有进行中任务，已忽略新招募。当前活动：${active.activityKey}`);
      return;
    }

    if (!parsed.activityKey) {
      await this.notifyAdmin('检测到招募但缺少“活动内容”，本次未建任务。');
      return;
    }

    const dedupTs = nowTs() - this.config.dedupHours * 3600 * 1000;
    const dup = this.tasks.find((t) => t.activityKey === parsed.activityKey && t.createdAt >= dedupTs && !this.isTerminal(t.status));
    if (dup) return;

    const createdAt = nowTs();
    const task = {
      taskId: this.generateTaskId(),
      activityKey: parsed.activityKey,
      groupId,
      status: TASK_STATUS.WAIT_ADMIN,
      rawRecruitText: parsed.rawText,
      parsedStartTime: parsed.startTime || null,
      finalStartTime: parsed.startTime || null,
      applyText: this.config.defaultApplyText,
      adminWindowDeadline: createdAt + this.config.adminWindowMinutes * 60 * 1000,
      listenWindowStart: null,
      listenWindowEnd: null,
      retryCount: 0,
      createdAt,
      updatedAt: createdAt,
      failReason: '',
      cancelReason: ''
    };

    this.tasks.push(task);
    this.runtime.activeTaskId = task.taskId;
    this.saveAll();

    await this.notifyAdmin([
      '检测到志愿者招募',
      `活动内容：${task.activityKey}`,
      `开始时间：${formatTs(task.finalStartTime)}`,
      `30分钟内回复：是 / 否 / 补时 yyyy-MM-dd HH:mm`,
      `取消任务：取消 ${task.activityKey}`
    ].join('\n'));
  }

  parseAdminCommand(text) {
    const clean = normalizeText(text);
    const cancel = clean.match(/^取消\s+(.+)$/);
    if (cancel) return { type: 'CANCEL', activityKey: cancel[1].trim() };

    if (/^否\b/.test(clean)) return { type: 'NO' };

    const yes = clean.match(/^是(?:\s+(.+))?$/);
    if (yes) return { type: 'YES', applyText: (yes[1] || '').trim() };

    const patch = clean.match(/^补时\s+(.+)$/);
    if (patch) return { type: 'PATCH_TIME', parsedTime: parsePatchTime(patch[1]), rawTime: patch[1].trim() };

    return { type: 'UNKNOWN' };
  }

  async handleAdminPrivate(event) {
    const command = this.parseAdminCommand(this.extractText(event));
    const task = this.getActiveTask();

    if (command.type === 'CANCEL') {
      if (!task || this.isTerminal(task.status)) return;
      if (task.activityKey !== command.activityKey) return;
      task.status = TASK_STATUS.CANCELLED;
      task.cancelReason = '管理员取消';
      task.updatedAt = nowTs();
      this.runtime.activeTaskId = null;
      this.saveAll();
      await this.notifyAdmin(`任务结束：${task.status}\n活动内容：${task.activityKey}`);
      return;
    }

    if (!task || task.status !== TASK_STATUS.WAIT_ADMIN) return;

    if (nowTs() > task.adminWindowDeadline) {
      task.status = TASK_STATUS.EXPIRED;
      task.failReason = '管理员确认超时';
      task.updatedAt = nowTs();
      this.runtime.activeTaskId = null;
      this.saveAll();
      await this.notifyAdmin(`任务结束：${task.status}\n活动内容：${task.activityKey}\n原因：${task.failReason}`);
      return;
    }

    if (command.type === 'NO') {
      task.status = TASK_STATUS.CANCELLED;
      task.cancelReason = '管理员拒绝报名';
      task.updatedAt = nowTs();
      this.runtime.activeTaskId = null;
      this.saveAll();
      return;
    }

    if (command.type === 'PATCH_TIME') {
      if (!command.parsedTime) {
        await this.notifyAdmin('补时格式无法识别，请使用：补时 yyyy-MM-dd HH:mm');
        return;
      }
      task.finalStartTime = command.parsedTime;
      // 同时更新监听窗口
      task.listenWindowStart = task.finalStartTime - this.config.listenAheadMinutes * 60 * 1000;
      task.listenWindowEnd = task.finalStartTime + this.config.listenLateMinutes * 60 * 1000;
      task.updatedAt = nowTs();
      this.saveAll();
      await this.notifyAdmin(`已更新开始时间：${formatTs(task.finalStartTime)}\n监听窗口：${formatTs(task.listenWindowStart)} ~ ${formatTs(task.listenWindowEnd)}`);
      return;
    }

    if (command.type === 'YES') {
      if (command.applyText) task.applyText = command.applyText;
      if (!task.finalStartTime) {
        await this.notifyAdmin('缺少开始时间，请先发送：补时 yyyy-MM-dd HH:mm');
        return;
      }
      task.listenWindowStart = task.finalStartTime - this.config.listenAheadMinutes * 60 * 1000;
      task.listenWindowEnd = task.finalStartTime + this.config.listenLateMinutes * 60 * 1000;
      task.status = TASK_STATUS.READY;
      task.updatedAt = nowTs();
      this.saveAll();
      await this.notifyAdmin(`已确认报名\n活动内容：${task.activityKey}\n报名内容：${task.applyText}`);
      await this.tryImmediateMuteCheck(task);
      return;
    }
  }

  async tryImmediateMuteCheck(task) {
    if (!task?.finalStartTime) return;
    const now = nowTs();
    if (!task.listenWindowStart) task.listenWindowStart = task.finalStartTime - this.config.listenAheadMinutes * 60 * 1000;
    if (!task.listenWindowEnd) task.listenWindowEnd = task.finalStartTime + this.config.listenLateMinutes * 60 * 1000;
    this.saveAll();

    if (now < task.listenWindowStart || now > task.listenWindowEnd) return;
    if (task.status !== TASK_STATUS.READY && task.status !== TASK_STATUS.WAIT_UNMUTE) return;

    try {
      const allMuted = await this.queryGroupAllMuted(task.groupId);
      if (!allMuted) {
        await this.trySendTask(task, true);
      }
    } catch (error) {
      this.warn('查询群禁言状态失败:', error?.message || error);
    }
  }

  async queryGroupAllMuted(groupId) {
    const data = await this.callAction('get_group_info', { group_id: Number(groupId) });
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof data?.shutup_all_timestamp === 'number') {
      return data.shutup_all_timestamp > nowSec;
    }
    if (typeof data?.group_all_shut === 'number') {
      return data.group_all_shut === 1;
    }
    if (typeof data?.is_ban_all === 'boolean') {
      return data.is_ban_all;
    }
    return true;
  }

  async trySendTask(task, forceWindowCheck = false) {
    if (!task || this.isTerminal(task.status)) return;
    const now = nowTs();
    if (!task.listenWindowStart || !task.listenWindowEnd) return;
    if (forceWindowCheck && (now < task.listenWindowStart || now > task.listenWindowEnd)) return;

    task.status = TASK_STATUS.SENDING;
    task.updatedAt = now;
    this.saveAll();

    const delays = [1000, 3000, 5000];
    let lastError = null;
    for (let i = 0; i < 3; i += 1) {
      task.retryCount = i + 1;
      this.saveAll();
      try {
        await this.sendGroup(task.groupId, task.applyText);
        task.status = TASK_STATUS.SUCCESS;
        task.updatedAt = nowTs();
        this.runtime.activeTaskId = null;
        this.saveAll();
        await this.notifyAdmin(`任务结束：${task.status}\n活动内容：${task.activityKey}`);
        return;
      } catch (error) {
        lastError = error;
        if (!isNetworkError(error)) {
          task.status = TASK_STATUS.FAILED;
          task.failReason = String(error?.message || error);
          task.updatedAt = nowTs();
          this.runtime.activeTaskId = null;
          this.saveAll();
          await this.notifyAdmin(`任务结束：${task.status}\n活动内容：${task.activityKey}\n原因：${task.failReason}`);
          return;
        }
        if (i < 2) {
          await new Promise((resolve) => setTimeout(resolve, delays[i]));
        }
      }
    }

    task.status = TASK_STATUS.FAILED;
    task.failReason = String(lastError?.message || lastError || '网络错误重试失败');
    task.updatedAt = nowTs();
    this.runtime.activeTaskId = null;
    this.saveAll();
    await this.notifyAdmin(`任务结束：${task.status}\n活动内容：${task.activityKey}\n原因：${task.failReason}`);
  }

  async onOneBotEvent(event) {
    try {
      if (!event || typeof event !== 'object') return;

      if (event.post_type === 'message' && event.message_type === 'group') {
        await this.handleGroupMessage(event);
        return;
      }

      if (this.isPrivateFromAdmin(event)) {
        await this.handleAdminPrivate(event);
        return;
      }

      if (this.isAllMutedOffEvent(event)) {
        const task = this.getActiveTask();
        if (!task || this.isTerminal(task.status)) return;
        if (String(task.groupId) !== String(event.group_id)) return;
        const now = nowTs();
        if (!task.listenWindowStart || !task.listenWindowEnd) return;
        if (now < task.listenWindowStart || now > task.listenWindowEnd) return;
        if (task.status !== TASK_STATUS.WAIT_UNMUTE && task.status !== TASK_STATUS.READY) return;
        await this.trySendTask(task, true);
      }
    } catch (error) {
      this.error('处理事件失败:', error?.stack || error);
    }
  }

  async tick() {
    // 防止并发执行
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      const task = this.getActiveTask();
      if (!task || this.isTerminal(task.status)) return;

      const now = nowTs();
      if (task.status === TASK_STATUS.WAIT_ADMIN && now > task.adminWindowDeadline) {
        task.status = TASK_STATUS.EXPIRED;
        task.failReason = '管理员确认超时';
        task.updatedAt = now;
        this.runtime.activeTaskId = null;
        this.saveAll();
        await this.notifyAdmin(`任务结束：${task.status}\n活动内容：${task.activityKey}\n原因：${task.failReason}`);
        return;
      }

      if (task.status === TASK_STATUS.READY) {
        if (task.listenWindowStart && task.listenWindowEnd && now >= task.listenWindowStart && now <= task.listenWindowEnd) {
          task.status = TASK_STATUS.WAIT_UNMUTE;
          task.updatedAt = now;
          this.saveAll();
          await this.notifyAdmin(`已进入解禁监听窗口\n活动内容：${task.activityKey}\n窗口结束：${formatTs(task.listenWindowEnd)}`);
          await this.tryImmediateMuteCheck(task);
        }
      }

      if (task.status === TASK_STATUS.WAIT_UNMUTE && task.listenWindowEnd && now > task.listenWindowEnd) {
        task.status = TASK_STATUS.EXPIRED;
        task.failReason = '解禁等待超时';
        task.updatedAt = now;
        this.runtime.activeTaskId = null;
        this.saveAll();
        await this.notifyAdmin(`任务结束：${task.status}\n活动内容：${task.activityKey}\n原因：${task.failReason}`);
      }
    } finally {
      this.tickRunning = false;
    }
  }

  subscribeEvents() {
    // 如果使用 plugin_onmessage 回调方式，跳过手动订阅
    if (this.skipEventSubscription) {
      this.log('使用 plugin_onmessage 回调模式，跳过手动事件订阅');
      return;
    }

    const eventNames = [
      'message',
      'notice',
      'message.group',
      'message.private',
      'notice.group_ban'
    ];

    const candidates = [
      this.bridge?.ctx?.events,
      this.bridge?.obContext,
      this.bridge?.obContext?.events,
      this.bridge?.obContext?.eventBus,
      this.bridge?.core?.events,
      this.bridge?.core?.eventBus,
      this.bridge?.instance?.events
    ].filter(Boolean);

    let subscribedCount = 0;
    for (const emitter of candidates) {
      if (typeof emitter?.on !== 'function') continue;
      const hasOff = typeof emitter?.off === 'function' || typeof emitter?.removeListener === 'function';
      for (const eventName of eventNames) {
        const handler = async (payload) => {
          await this.onOneBotEvent(payload);
        };
        try {
          emitter.on(eventName, handler);
          subscribedCount += 1;
          if (hasOff) {
            this.unsubscribers.push(() => {
              if (typeof emitter.off === 'function') emitter.off(eventName, handler);
              else emitter.removeListener(eventName, handler);
            });
          }
        } catch (_) {}
      }
    }

    if (subscribedCount > 0) {
      this.log(`手动订阅了 ${subscribedCount} 个事件源`);
    } else {
      this.warn('未能订阅任何事件源，请确保 NapCat 版本支持或使用 plugin_onmessage 回调');
    }
  }

  async start() {
    this.log('启动插件');
    if (!this.config.adminQQ) {
      this.warn('config.json 未配置 adminQQ，插件只会记录日志，不会发送管理员通知');
    }
    this.subscribeEvents();
    this.interval = setInterval(async () => {
      await this.tick();
    }, 1000);
  }

  async stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    for (const fn of this.unsubscribers) {
      try {
        fn();
      } catch (_) {}
    }
    this.unsubscribers = [];
    this.log('插件已停止');
  }
}

function buildBridge(core, obContext, actions, instance, ctx) {
  return { core, obContext, actions, instance, ctx };
}

export async function plugin_init(core, obContext, actions, instance) {
  try {
    const bridge = buildBridge(core, obContext, actions, instance, null);
    pluginInstance = new VolunteerApplyPlugin(bridge);
    await pluginInstance.start();
  } catch (error) {
    console.error('[VolunteerApply] 初始化失败', error);
  }
}

export async function plugin_cleanup() {
  try {
    if (pluginInstance) {
      await pluginInstance.stop();
      pluginInstance = null;
    }
  } catch (error) {
    console.error('[VolunteerApply] 清理失败', error);
  }
}

// 兼容 NapCat 新插件规范
export async function plugin_onmessage(ctx, event) {
  try {
    // 使用标志位防止并发初始化
    if (!pluginInstance && !pluginInitializing) {
      pluginInitializing = true;
      try {
        const bridge = buildBridge(ctx?.core, null, null, null, ctx);
        // 使用 plugin_onmessage 回调时，跳过手动事件订阅，避免重复处理
        pluginInstance = new VolunteerApplyPlugin(bridge, true);
        await pluginInstance.start();
      } finally {
        pluginInitializing = false;
      }
    }
    if (pluginInstance) {
      await pluginInstance.onOneBotEvent(event);
    }
  } catch (error) {
    console.error('[VolunteerApply] plugin_onmessage 处理失败', error);
  }
}

export async function plugin_onevent(ctx, event) {
  return plugin_onmessage(ctx, event);
}
