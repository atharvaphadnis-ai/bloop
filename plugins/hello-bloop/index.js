// plugins/hello-bloop/index.js — example plugin demonstrating the real
// plugin surface: register(ctx) receives a permission-scoped context.
//
// Enable it with:
//   bloop plugins install plugins/hello-bloop
//   (or POST /api/admin/plugins/hello-bloop/enable)
// Then visit:  GET /api/plugins/hello-bloop/hello

export function register(ctx) {
  const log = ctx.log.child({ source: 'hello-bloop' });

  // permission-gated route registration
  if (ctx.hasPermission('routes')) {
    ctx.addRoute('GET', '/api/plugins/hello-bloop/hello', async (req, res) => {
      const greeting = ctx.hasPermission('settings')
        ? (ctx.settings?.get?.('greeting') || 'Hello from a Bloop plugin!')
        : 'Hello from a Bloop plugin!';
      res.json(200, {
        plugin: ctx.manifest.name,
        version: ctx.manifest.version,
        greeting,
        requestId: req.id,
      });
    });
    log.info('registered route GET /api/plugins/hello-bloop/hello');
  }

  // event listeners
  if (ctx.hasPermission('events')) {
    ctx.bus.on('project.created', (payload) => {
      log.info(`a project was created: ${payload.name}`);
    });
    ctx.bus.on('auth.login', (payload) => {
      log.info(`login event on project ${payload.projectId}`);
    });
  }

  log.info('hello-bloop plugin initialized');

  // optional cleanup hook (called on disable / shutdown)
  return {
    shutdown() {
      log.info('hello-bloop shutting down');
    },
  };
}
