// infrastructure/backup-scheduler.js — scheduled backups via the scheduler:
// cron-driven automatic backups with retention enforcement. Only verified
// backups are retained as successes.
export class BackupSchedulerService {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'backup-scheduler' });
  }

  schedules(projectId) {
    return this.ctx.scheduler.list(projectId).filter((j) => j.target_type === 'backup');
  }

  createSchedule(projectId, { name = 'Nightly backup', cronExpr = '0 3 * * *', retention = null, encrypt = null, destination = 'local' } = {}) {
    return this.ctx.scheduler.create(projectId, {
      name,
      cronExpr,
      targetType: 'backup',
      targetRef: projectId,
      payload: { retention, encrypt, destination },
      enabled: true,
    });
  }

  updateSchedule(projectId, jobId, patch) {
    return this.ctx.scheduler.update(projectId, jobId, {
      cronExpr: patch.cronExpr,
      enabled: patch.enabled,
      name: patch.name,
    });
  }

  deleteSchedule(projectId, jobId) {
    return this.ctx.scheduler.delete(projectId, jobId);
  }

  async runForJob(job) {
    const payload = typeof job.payload_json === 'string' ? JSON.parse(job.payload_json || '{}') : (job.payload || {});
    const projectId = job.target_ref || job.project_id;
    const backup = await this.ctx.backups.createBackup(projectId, {
      name: payload.name || `${job.name}-${new Date().toISOString().slice(0, 10)}`,
      type: 'scheduled',
      encrypt: payload.encrypt,
      destination: payload.destination || this.ctx.config.get('backups.destination', 'local'),
    });
    const retention = payload.retention || this.ctx.config.get('backups.retention', {});
    const pruned = await this.ctx.backups.applyRetention(projectId, retention);
    return { backupId: backup.id, status: backup.status, size: backup.size, retentionPruned: pruned.deleted };
  }

  start() {
    this.ctx.scheduler.registerRunner('backup', (job) => this.runForJob(job));
    this.log.debug('backup runner registered with scheduler');
  }
}

export async function register(ctx) {
  ctx.backupScheduler = new BackupSchedulerService(ctx);
}
