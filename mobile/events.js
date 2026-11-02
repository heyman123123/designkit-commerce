/* DesignKit 移动端 · 任务实时推送
 *
 * 后端 /v1/w/{slug}/events 是只读 GET，中间件允许用 ?access_token= 传令牌，
 * 因此可以直接用 EventSource（Authorization 头无法由 EventSource 设置）。
 *
 * 后端连接建立时会补发最近 2 分钟的任务快照；这里做「握手宽限 + 短时去重」，
 * 避免重连后同一批事件重复触发渲染。不支持 EventSource 时返回 null，
 * 调用方退回轮询。
 */

import { session } from '../web/assets/core.js';

const GRACE_MS = 1200;
const DEDUPE_MS = 4000;

export function eventsURL() {
  if (!session.slug || !session.access) return '';
  return `/v1/w/${encodeURIComponent(session.slug)}/events?access_token=${encodeURIComponent(session.access)}`;
}

/**
 * connectJobEvents 连接任务推送流。
 * @param {(job: any) => void} onJob 每条去重后的事件
 * @param {{ onState?: (state: 'live' | 'offline') => void }} [opts]
 * @returns {null | (() => void)} 不支持时返回 null；否则返回关闭函数
 */
export function connectJobEvents(onJob, opts = {}) {
  const url = eventsURL();
  if (!url || typeof EventSource === 'undefined') return null;

  let es;
  try {
    es = new EventSource(url);
  } catch {
    return null;
  }

  const seen = new Map();
  let armed = false;
  const armTimer = setTimeout(() => {
    armed = true;
  }, GRACE_MS);

  const emitState = (state) => {
    if (opts.onState) opts.onState(state);
  };

  es.addEventListener('job', (e) => {
    let job;
    try {
      job = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!job || !job.id) return;
    const key = [job.id, job.status, job.progress, job.review_status, job.error || ''].join('|');
    const last = seen.get(key) || 0;
    if (!armed || Date.now() - last < DEDUPE_MS) return;
    seen.set(key, Date.now());
    onJob(job);
  });

  es.onopen = () => emitState('live');
  es.onerror = () => emitState('offline');

  return () => {
    clearTimeout(armTimer);
    try {
      es.close();
    } catch {
      /* 忽略关闭异常 */
    }
  };
}
