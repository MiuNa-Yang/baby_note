import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { syncDailyReminder, triggerReminderTest } from './cron-client.js';

test('daily reminder sync uses cc-connect management cron API', async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: body ? JSON.parse(body) : null,
    });

    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/v1/cron?project=babynote-agent') {
      response.end(JSON.stringify({
        ok: true,
        data: {
          jobs: [
            { id: 'cron-old', description: 'babynote-daily-meal-plan:3' },
            { id: 'unrelated', description: 'another-job' },
          ],
        },
      }));
      return;
    }
    if (request.method === 'DELETE' && request.url === '/api/v1/cron/cron-old') {
      response.end(JSON.stringify({ ok: true, data: { message: 'deleted' } }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/cron') {
      response.end(JSON.stringify({ ok: true, data: { id: 'cron-new' } }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/cron/cron-new/exec') {
      response.statusCode = 202;
      response.end(JSON.stringify({ ok: true, data: { id: 'cron-new', status: 'triggered' } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const previousEnv = {
    url: process.env.CC_CONNECT_MANAGEMENT_URL,
    token: process.env.CC_CONNECT_MANAGEMENT_TOKEN,
    project: process.env.CC_CONNECT_PROJECT,
  };
  const address = server.address();
  process.env.CC_CONNECT_MANAGEMENT_URL = `http://127.0.0.1:${address.port}`;
  process.env.CC_CONNECT_MANAGEMENT_TOKEN = 'test-token';
  process.env.CC_CONNECT_PROJECT = 'babynote-agent';
  t.after(() => {
    if (previousEnv.url == null) delete process.env.CC_CONNECT_MANAGEMENT_URL;
    else process.env.CC_CONNECT_MANAGEMENT_URL = previousEnv.url;
    if (previousEnv.token == null) delete process.env.CC_CONNECT_MANAGEMENT_TOKEN;
    else process.env.CC_CONNECT_MANAGEMENT_TOKEN = previousEnv.token;
    if (previousEnv.project == null) delete process.env.CC_CONNECT_PROJECT;
    else process.env.CC_CONNECT_PROJECT = previousEnv.project;
  });

  let settings = {
    baby_id: 3,
    enabled: true,
    target_session_key: 'weixin:dm:family@chatroom',
    reminder_enabled: true,
    reminder_time: '08:35',
    cron_job_id: null,
    cron_sync_status: 'pending',
  };
  const service = {
    getAgentSettings: () => settings,
    updateCronSync: (_babyId, patch) => {
      settings = { ...settings, ...patch };
      return settings;
    },
  };

  const synced = await syncDailyReminder(service, 3);
  assert.equal(synced.cron_job_id, 'cron-new');
  assert.equal(synced.cron_sync_status, 'synced');
  await triggerReminderTest(service, 3);

  assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`), [
    'GET /api/v1/cron?project=babynote-agent',
    'DELETE /api/v1/cron/cron-old',
    'POST /api/v1/cron',
    'POST /api/v1/cron/cron-new/exec',
  ]);
  assert.equal(requests[0].authorization, 'Bearer test-token');
  assert.deepEqual(requests[2].body, {
    project: 'babynote-agent',
    session_key: 'weixin:dm:family@chatroom',
    cron_expr: '35 8 * * *',
    prompt: '调用 build_daily_reminder 工具，baby_id=3。把工具返回的 message 原样作为唯一回复，不要补充解释。',
    description: 'babynote-daily-meal-plan:3',
    silent: true,
    session_mode: 'new_per_run',
    timeout_mins: 5,
  });
});
