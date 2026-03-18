import { Router } from 'express';
import type { AdbManager } from '../../adb/AdbManager.js';

export function createDeviceRoutes(adb: AdbManager) {
  const router = Router();

  /** GET /api/devices */
  router.get('/devices', async (_req, res) => {
    try {
      const devices = await adb.listDevices();
      const detailed = [];
      for (const d of devices) {
        const info = await adb.getDeviceInfo(d.serial);
        detailed.push({ ...d, ...info });
      }
      res.json({ count: detailed.length, devices: detailed });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/devices/connect */
  router.post('/devices/connect', async (req, res) => {
    const { ip, port = 5555 } = req.body;
    if (!ip) {
      res.status(400).json({ error: 'ip required' });
      return;
    }

    try {
      const ok = await adb.connectDevice(ip, port);
      res.json({ status: ok ? 'connected' : 'failed', ip, port });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/devices/discover */
  router.post('/devices/discover', async (_req, res) => {
    try {
      const devices = await adb.discoverDevices();
      res.json({ count: devices.length, devices });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/mirror/start */
  router.post('/mirror/start', async (req, res) => {
    const { serial } = req.body;
    if (!serial) {
      res.status(400).json({ error: 'serial required' });
      return;
    }

    try {
      const ok = await adb.startMirror(serial);
      res.json({ status: ok ? 'started' : 'already_running' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** POST /api/mirror/stop */
  router.post('/mirror/stop', async (req, res) => {
    const { serial } = req.body;
    if (!serial) {
      res.status(400).json({ error: 'serial required' });
      return;
    }

    try {
      await adb.stopMirror(serial);
      res.json({ status: 'stopped' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
