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

const { WebSocketManager } = require('@discordjs/ws');
const origFetchGWI = WebSocketManager.prototype.fetchGatewayInformation;
WebSocketManager.prototype.fetchGatewayInformation = async function (force) {
  if (this.gatewayInformation) {
    if (this.gatewayInformation.expiresAt <= Date.now()) {
      this.gatewayInformation = null;
    } else if (!force) {
      return this.gatewayInformation.data;
    }
  }
  try {
    const data = await this.options.rest.get('/gateway');
    const result = {
      url: data.url,
      shards: 1,
      session_start_limit: {
        total: 1000,
        remaining: 999,
        reset_after: 0,
        max_concurrency: 1
      }
    };
    this.gatewayInformation = { data: result, expiresAt: Date.now() + 60000 };
    return result;
  } catch {
    const data = await origFetchGWI.call(this, force);
    return data;
  }
};

const { REST } = require('@discordjs/rest');
const origSetToken = REST.prototype.setToken;
REST.prototype.setToken = function (token) {
  if (token === null) return this;
  return origSetToken.call(this, token);
};

module.exports = true;
