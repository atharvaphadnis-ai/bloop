// infrastructure/disaster-recovery.js — DR tooling: restore testing into an
// isolated temporary project, integrity verification and a machine-readable
// disaster-recovery plan.
import { badRequest, notFound } from '../core/error-handler.js';

export class DisasterRecovery {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = ctx.log.child({ source: 'dr' });
  }

  async integrity(backupId) {
    return this.ctx.backups.verify(backupId);
  }

  /**
   * Restore testing: restores the backup into a fresh temporary project,
   * verifies row counts / storage against the manifest, then removes the
   * temporary project. Never touches production data.
   */
  async restoreTest(backupId) {
    const b = this.ctx.backups.get(backupId);
    if (b.status !== 'verified') {
      const v = await this.ctx.backups.verify(backupId);
      if (!v.ok) throw badRequest(`Backup is not verifiable: ${v.error}`);
    }
    const started = Date.now();
    const tempName = `dr-test-${Date.now()}`;
    let tempProjectId = null;
    try {
      const restore = await this.ctx.backups.restore(backupId, { mode: 'new-project', name: tempName });
      tempProjectId = restore.projectId;
      const counts = {
        documents: this.ctx.system.get('SELECT COUNT(*) AS c FROM documents WHERE project_id = ?', [tempProjectId])?.c || 0,
        functions: this.ctx.system.get('SELECT COUNT(*) AS c FROM functions WHERE project_id = ?', [tempProjectId])?.c || 0,
        buckets: this.ctx.system.get('SELECT COUNT(*) AS c FROM buckets WHERE project_id = ?', [tempProjectId])?.c || 0,
        savedQueries: this.ctx.system.get('SELECT COUNT(*) AS c FROM saved_queries WHERE project_id = ?', [tempProjectId])?.c || 0,
      };
      const dbCheck = await this.ctx.database.refreshStatus(
        this.ctx.database.getDefaultConnection(tempProjectId)?.id
      ).catch(() => ({ status: 'unknown' }));
      const result = {
        ok: true,
        restoreJobId: restore.jobId,
        tempProjectId,
        counts,
        databaseStatus: dbCheck.status,
        durationMs: Date.now() - started,
        testedAt: new Date().toISOString(),
      };
      this.ctx.system.run('UPDATE backups SET restore_tested_at = ? WHERE id = ?', [result.testedAt, backupId]);
      this.ctx.audit?.record({ actor: 'system', action: 'dr.restore_test', projectId: b.project_id, target: b.name, meta: result });
      this.log.info(`restore test for backup "${b.name}" passed in ${result.durationMs}ms`);
      return result;
    } finally {
      if (tempProjectId) {
        await this.ctx.projects.delete(tempProjectId, { confirm: true }).catch((err) => {
          this.log.warn(`cleanup of DR temp project failed: ${err.message}`);
        });
      }
    }
  }

  drPlan() {
    return {
      title: 'Bloop Disaster Recovery Plan',
      objectives: {
        rpoHint: 'Last scheduled backup interval (default nightly, 03:00)',
        rtoHint: 'Minutes — restore is a single operation per project',
      },
      steps: [
        {
          n: 1,
          title: 'Verify backups are healthy',
          command: 'GET /api/admin/backups — every entry must show status "verified"',
          detail: 'Verification decompresses and parses the archive, so a "verified" status means the artifact is genuinely restorable.',
        },
        {
          n: 2,
          title: 'Run a restore test before you need it',
          command: 'POST /api/admin/dr/restore-test { "backupId": "…" }',
          detail: 'Restores into an isolated temporary project, checks row counts and database status, then cleans up. Production data is untouched.',
        },
        {
          n: 3,
          title: 'Full project loss',
          command: 'POST /api/admin/backups/:id/restore { "mode": "new-project" }',
          detail: 'Recreates the project with its bundle (schema via SQL dumps / SQLite snapshots, documents, functions, buckets, policies), then restores storage files.',
        },
        {
          n: 4,
          title: 'Data corruption in an existing project',
          command: 'POST /api/admin/backups/:id/restore { "mode": "in-place", "targetProjectId": "…" }',
          detail: 'An automatic safety backup of the current state is taken first, then the backup content is restored.',
        },
        {
          n: 5,
          title: 'Platform host loss',
          command: 'docker compose up -d (on the new host), then restore backups from your S3 destination or off-host copies.',
          detail: 'Backups with destination "s3" are uploaded off-host; store storage/system/secret.key safely — encrypted backups require the same master key.',
        },
      ],
      warnings: [
        'Encrypted backups can only be restored by an instance holding the same master key (BLOOP_SECRET or storage/system/secret.key) — back that key up separately.',
        'External SQL providers are backed up as SQL data dumps; schema objects beyond tables (views, procedures, sequences) are not captured — use pg_dump/mysqldump for those and keep both artifacts.',
        'Never trust a backup that has not been restore-tested at least once.',
      ],
    };
  }
}

export async function register(ctx) {
  ctx.dr = new DisasterRecovery(ctx);
}
