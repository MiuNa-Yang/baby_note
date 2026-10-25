import express from 'express';
import { readDashboard } from './telemetry.js';
import { AgentInputError, createAgentService } from './domain.js';
import { syncDailyReminder, triggerReminderTest } from './cron-client.js';

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function createAgentRouter(database) {
  const router = express.Router();
  const service = createAgentService(database);
  router.get('/agent-dashboard', (req, res) => res.json(readDashboard(database, req.query)));

  router.get('/meal-plans', (req, res) => {
    res.json(service.listMealPlans({
      baby_id: req.query.baby_id,
      from: req.query.from,
      to: req.query.to,
    }));
  });

  router.put('/meal-plans/:date', (req, res) => {
    res.json(service.saveMealPlan({
      baby_id: req.body?.baby_id,
      date: req.params.date,
      items: req.body?.items,
      note: req.body?.note,
    }));
  });

  router.delete('/meal-plans/:date', (req, res) => {
    res.json(service.deleteMealPlan({
      baby_id: req.query.baby_id,
      date: req.params.date,
    }));
  });

  router.get('/agent-settings', (req, res) => {
    res.json(service.getAgentSettings({ baby_id: req.query.baby_id }));
  });

  router.put('/agent-settings', asyncRoute(async (req, res) => {
    const settings = service.saveAgentSettings(req.body || {});
    const synced = await syncDailyReminder(service, settings.baby_id);
    res.json(synced);
  }));

  router.post('/agent-settings/test-reminder', asyncRoute(async (req, res) => {
    res.json(await triggerReminderTest(service, Number(req.body?.baby_id)));
  }));

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || (error instanceof AgentInputError ? 400 : 500);
    res.status(status).json({
      error: error.message || '请求失败',
      code: error.code || 'agent_error',
      details: error.details || undefined,
    });
  });

  return router;
}
