// Trusted local code: plugins run with the bot process's full privileges.
export default {
  apiVersion: 1,
  name: 'example',
  async start(api) {
    api.registerCommand('ticketstats', {
      level: 2,
      description: 'Show the number of conversations observed by this plugin.',
      async execute(context) { await context.respond(`Observed conversations: ${api.get('opened') || 0}`); },
    });
  },
  hooks: {
    async threadOpen(_event, api) { api.set('opened', (api.get('opened') || 0) + 1); },
  },
};
