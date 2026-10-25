const DESCRIPTION_PREFIX = 'babynote-daily-meal-plan:';

function managementConfig() {
  return {
    baseUrl: String(process.env.CC_CONNECT_MANAGEMENT_URL || '').replace(/\/$/, ''),
    token: String(process.env.CC_CONNECT_MANAGEMENT_TOKEN || ''),
    project: String(process.env.CC_CONNECT_PROJECT || 'babynote-agent'),
  };
}

async function request(path, options = {}) {
  const config = managementConfig();
  if (!config.baseUrl) throw new Error('尚未配置 cc-connect Management API 地址');
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || payload?.message || `cc-connect 返回 ${response.status}`);
  }
  return payload?.data ?? payload;
}

function cronExpression(time) {
  const [hour, minute] = String(time).split(':').map(Number);
  return `${minute} ${hour} * * *`;
}

export async function syncDailyReminder(service, babyId) {
  const settings = service.getAgentSettings({ baby_id: babyId });
  const config = managementConfig();
  if (!config.baseUrl) {
    return service.updateCronSync(babyId, {
      cron_sync_status: 'waiting_for_cc_connect',
      cron_sync_error: '配置 cc-connect 后会自动同步每日提醒',
    });
  }
  if (!settings.target_session_key) {
    return service.updateCronSync(babyId, {
      cron_sync_status: 'waiting_for_channel',
      cron_sync_error: '请先填写微信群或私聊会话标识',
    });
  }

  const description = `${DESCRIPTION_PREFIX}${babyId}`;
  try {
    const listed = await request(`/api/v1/cron?project=${encodeURIComponent(config.project)}`);
    const jobs = Array.isArray(listed?.jobs) ? listed.jobs : [];
    for (const job of jobs.filter((entry) => entry.description === description)) {
      await request(`/api/v1/cron/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
    }

    if (!settings.enabled || !settings.reminder_enabled) {
      return service.updateCronSync(babyId, {
        cron_sync_status: 'disabled',
        cron_sync_error: null,
      });
    }

    const created = await request('/api/v1/cron', {
      method: 'POST',
      body: JSON.stringify({
        project: config.project,
        session_key: settings.target_session_key,
        cron_expr: cronExpression(settings.reminder_time),
        prompt: `调用 build_daily_reminder 工具，baby_id=${babyId}。把工具返回的 message 原样作为唯一回复，不要补充解释。`,
        description,
        silent: true,
        session_mode: 'new_per_run',
        timeout_mins: 5,
      }),
    });
    return service.updateCronSync(babyId, {
      cron_job_id: created?.id,
      cron_sync_status: 'synced',
      cron_sync_error: null,
    });
  } catch (error) {
    return service.updateCronSync(babyId, {
      cron_sync_status: 'error',
      cron_sync_error: error.message || '提醒同步失败',
    });
  }
}

export async function triggerReminderTest(service, babyId) {
  const settings = service.getAgentSettings({ baby_id: babyId });
  if (!settings.cron_job_id || settings.cron_sync_status !== 'synced') {
    const error = new Error('提醒任务尚未同步，请先保存 Agent 设置');
    error.status = 409;
    throw error;
  }
  await request(`/api/v1/cron/${encodeURIComponent(settings.cron_job_id)}/exec`, { method: 'POST' });
  return { ok: true, message: '测试提醒已触发' };
}
