'use strict';

/**
 * Module dependencies.
 */

const { StatsD } = require('hot-shots');
const debugnyan = require('debugnyan');
const fs = require('fs');
const path = require('path');
const pm2 = require('pm2');
const pmx = require('pmx');

/**
 * Constants.
 */

const logger = debugnyan('pm2-datadog');
const { global_tags: globalTagsString, host, interval, port } = pmx.initModule();
const globalTags = [];
if (globalTagsString) {
  let globalTags_ = JSON.parse(globalTagsString);
  if (Array.isArray(globalTags_)) {
    globalTags_.forEach((tag) => {
        globalTags.push(tag)
    })
  }
}
const dogstatsd = new StatsD({ globalTags, host, port });
const { CHECKS: { CRITICAL, OK, WARNING } } = dogstatsd;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Log errors.
 */

dogstatsd.socket.on('error', error => {
  logger.error({ error }, 'Error reporting to DogStatsd');
});

/**
 * Process pm2 events.
 */

pm2.launchBus((err, bus) => {
  logger.info('PM2 connection established');

  bus.on('process:event', ({ at, event, process }) => {
    const { exit_code, name, pm_cwd, NODE_APP_INSTANCE, pm_uptime, restart_time, status, versioning } = process;
    const aggregation_key = `${name}-${pm_uptime}`;
    const file = path.resolve(pm_cwd, 'package.json');
    const tags = [
      `application:${name}`,
      `instance:${NODE_APP_INSTANCE}`,
      `status:${status}`
    ];

    logger.info(`Received event '${event}' with status '${status}'`);

    if (versioning && versioning.branch !== 'HEAD') {
      tags.push(`branch:${versioning.branch}`);
    }

    if (fs.existsSync(file)) {
      tags.push(`version:${require(file).version}`);
    }

    // `delete` is triggered when an app is deleted from PM2.
    if (event === 'delete') {
      dogstatsd.event(`PM2 process '${name}' was deleted`, null, { date_happened: at }, tags);

      return;
    }

    // `exit` is triggered when an app exits.
    if (event === 'exit') {
      dogstatsd.event(`PM2 process '${name}' is ${status}`, null, { aggregation_key, alert_type: 'warning', date_happened: at }, tags);
      dogstatsd.timing('pm2.processes.uptime', new Date() - pm_uptime, tags);

      if (exit_code !== 0) {
        dogstatsd.check('app.is_ok', CRITICAL, { date_happened: at }, [`application:${name}`]);
      }

      return;
    }

    // `restart` is triggered when an app is restarted, either manually or due to a crash.
    if (event === 'restart') {
      dogstatsd.event(`PM2 process '${name}' was restarted`, null, { alert_type: 'success', date_happened: at }, tags);
      dogstatsd.check('app.is_ok', OK, { date_happened: at }, [`application:${name}`]);
      dogstatsd.gauge('pm2.processes.restart', restart_time, tags);

      return;
    }

    // `restart overlimit` is triggered when an app exceeds the restart limit.
    if (event === 'restart overlimit') {
      dogstatsd.event(`PM2 process '${name}' has exceeded the restart limit`, null, { aggregation_key, alert_type: 'error', date_happened: at }, tags);

      return;
    }

    // `start` is triggered when an app is manually started.
    if (event === 'start') {
      dogstatsd.event(`PM2 process '${name}' was manually started`, null, { alert_type: 'success', date_happened: at }, tags);
      dogstatsd.check('app.is_ok', OK, { date_happened: at }, [`application:${name}`]);

      return;
    }

    // `stop` is triggered when an app is manually stopped.
    if (event === 'stop') {
      dogstatsd.event(`PM2 process '${name}' was manually stopped`, null, { alert_type: 'error', date_happened: at }, tags);
      dogstatsd.check('app.is_ok', WARNING, { date_happened: at }, [`application:${name}`]);

      return;
    }
  });
});

/**
 * Report metrics to DataDog.
 */

async function start() {
  pm2.list((err, processes) => {
    dogstatsd.gauge('pm2.processes.installed', processes.length);

    let statuses = {};
    for (const process of processes) {
      if(!statuses[process.name]) {
        statuses[process.name] = {
          online: 0,
          not_oneline: 0,
        };
      }

      const tags = [
        `application:${process.name}`,
        `instance:${process.pm2_env.NODE_APP_INSTANCE}`
      ];

      dogstatsd.gauge('pm2.processes.cpu', process.monit.cpu, tags);
      dogstatsd.gauge('pm2.processes.memory', process.monit.memory, tags);
      dogstatsd.gauge('pm2.processes.restart_time', process.pm2_env.restart_time, tags);
      if(process.pm2_env.status === 'online') {
        statuses[process.name].online++;
      }else{
        statuses[process.name].not_oneline++;
      }
    }

    Object.keys(statuses).forEach((name) => {
      const tags = [
          `application:${name}`,
      ];
      const total = statuses[name].online + statuses[name].not_oneline;
      dogstatsd.gauge('pm2.processes.online_rate', statuses[name].online/total, tags);
      dogstatsd.gauge('pm2.processes.not_online_rate', statuses[name].not_oneline/total, tags);
      dogstatsd.gauge('pm2.processes.online', statuses[name].online, tags);
      dogstatsd.gauge('pm2.processes.not_online', statuses[name].not_oneline, tags);

    })
  });

  await sleep(interval);
  await start();
}

logger.info({ globalTags, host, interval, port }, `Starting pm2-datadog`);

start();
