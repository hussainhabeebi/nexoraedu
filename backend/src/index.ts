import { createApp } from './app';
import { config } from './config';
import { startScheduler } from './jobs/scheduler';

const app = createApp();
app.listen(config.port, () => {
  console.log(`Nexora API listening on :${config.port}`);
  if (config.jobsEnabled) startScheduler();
});
