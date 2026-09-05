import express from 'express';
import client from 'prom-client';
import config, { NODE_ENV } from '../config';
import mainDebug from '../test/debug';
import googleRouter from './google';
import microsoftRouter from './microsoft';
import zoomRouter from './zoom';
import { globalJobStore } from '../lib/globalJobStore';
import { RedisConsumerService } from '../connect/RedisConsumerService';
import { logAuthGateState, requireBearerToken } from '../middleware/authGate';

const app = express();

app.use(express.json());

// Initialize Redis consumer service
export const redisConsumerService = new RedisConsumerService();

let isbusy = 0;
let gracefulShutdown = 0;

app.get('/isbusy', async (req, res) => {
  // Use the job store's isBusy status
  const jobStoreBusy = globalJobStore.isBusy() ? 1 : 0;
  return res.status(200).json({ success: true, data: jobStoreBusy });
});

app.get('/health', async (req, res) => {
  // Simple health check endpoint for Docker
  return res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Create a Gauge metric for busy status (0 or 1)
const busyStatus = new client.Gauge({
  name: 'isbusy',
  help: 'busy status of the pod (1 = busy, 0 = available)'
});

const isavailable = new client.Gauge({
  name: 'isavailable',
  help: 'available status of the pod (1 = available, 0 = busy)'
});

app.get('/metrics', async (req, res) => {
  // Use the job store's isBusy status for metrics
  const jobStoreBusy = globalJobStore.isBusy() ? 1 : 0;
  busyStatus.set(jobStoreBusy);
  isavailable.set(1 - jobStoreBusy);
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

// Deepcape-fork: /debug käynnistää selaimen (test/debug.ts:11 createBrowserContext),
// eli se on sama sivuvaikutusluokka kuin /join — ja se oli auki, ei vain teoriassa:
// docker-compose.yml:29 asettaa NODE_ENV=development, joka yliajaa .env:n
// production-arvon. Siksi portti on ENSIN ja NODE_ENV-tarkistus vasta sen jälkeen:
// NODE_ENV on konfiguraatio, ei portti, eikä siitä saa tehdä ainoaa estettä.
app.get('/debug', requireBearerToken, async (req, res, next) => {
  if (NODE_ENV === 'development') {
    next();
  }
  else {
    res.status(500).send({});
  }
}, async (req, res) => {
  await mainDebug('baf14', 'https://www.github.com');
  res.status(200).send({});
});

// Deepcape-fork: fail-closed bearer-portti. Mountattu routerien ETEEN, jolloin
// yksikään join-käsittelijä ei ole tavoitettavissa portin ohi — hylkäys tapahtuu
// ennen globalJobStore.addJob:ia ja ennen selaimen käynnistystä (#1789).
// Upstream jätti bearerTokenin tarkistamatta; ks. middleware/authGate.ts.
app.use('/google', requireBearerToken, googleRouter);
app.use('/microsoft', requireBearerToken, microsoftRouter);
app.use('/zoom', requireBearerToken, zoomRouter);

export const setGracefulShutdown = (val: number) =>
  gracefulShutdown = val;

export const getGracefulShutdown = () => gracefulShutdown;

export const setIsBusy = (val: number) =>
  isbusy = val;

export const getIsBusy = () => isbusy;

// Deepcape-fork: kerro portin tila bootissa, jotta väärin konfiguroitu portti
// näkyy ennen ensimmäistä pyyntöä eikä vasta sen jälkeen.
logAuthGateState();

// Start Redis consumer service only if Redis is enabled
if (config.isRedisEnabled) {
  redisConsumerService.start().catch((error) => {
    console.error('Failed to start Redis consumer service:', error);
  });
} else {
  console.info('Redis consumer service not started - Redis is disabled');
}

export default app;
