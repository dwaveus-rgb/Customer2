const origFetch = globalThis.fetch;
globalThis.fetch = async function (url, init) {
  if (init && init.headers) {
    const h = init.headers;
    if (h instanceof Headers) {
      const auth = h.get('authorization');
      if (auth && auth.startsWith('Bot ')) {
        h.set('authorization', auth.slice(4));
      }
    } else if (typeof h === 'object') {
      for (const key of Object.keys(h)) {
        if (key.toLowerCase() === 'authorization' && typeof h[key] === 'string' && h[key].startsWith('Bot ')) {
          h[key] = h[key].slice(4);
        }
      }
    }
  }
  return origFetch.call(this, url, init);
};

const { Client } = require('discord.js');

const origEmit = Client.prototype.emit;
Client.prototype.emit = function (event, ...args) {
  if (event === 'raw' && args[0] && args[0].t === 'READY') {
    const data = args[0].d;
    if (data && !data.application) {
      data.application = { id: '0', flags: 0 };
    }
  }
  return origEmit.call(this, event, ...args);
};

module.exports = true;
