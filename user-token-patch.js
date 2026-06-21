const undici = require('undici');

function stripBotPrefix(headers) {
  if (!headers) return;
  if (headers instanceof Map || headers instanceof Headers || (typeof undici.Headers !== 'undefined' && headers instanceof undici.Headers)) {
    for (const [key, val] of headers.entries()) {
      if (key.toLowerCase() === 'authorization' && val.startsWith('Bot ')) {
        headers.set(key, val.slice(4));
      }
    }
  } else if (typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'authorization' && typeof headers[key] === 'string' && headers[key].startsWith('Bot ')) {
        headers[key] = headers[key].slice(4);
      }
    }
  }
}

const originalFetch = undici.fetch;
undici.fetch = async function (url, init) {
  if (init) stripBotPrefix(init.headers);
  return originalFetch.call(this, url, init);
};

if (undici.Agent) {
  const origRequest = undici.Agent.prototype.request;
  if (origRequest) {
    undici.Agent.prototype.request = async function (opts) {
      if (opts) stripBotPrefix(opts.headers);
      return origRequest.call(this, opts);
    };
  }
  const origDispatch = undici.Agent.prototype.dispatch;
  if (origDispatch) {
    undici.Agent.prototype.dispatch = function (opts, handler) {
      if (opts) stripBotPrefix(opts.headers);
      return origDispatch.call(this, opts, handler);
    };
  }
}

if (undici.Dispatcher) {
  const origRequest = undici.Dispatcher.prototype.request;
  if (origRequest) {
    undici.Dispatcher.prototype.request = async function (opts) {
      if (opts) stripBotPrefix(opts.headers);
      return origRequest.call(this, opts);
    };
  }
  const origDispatch = undici.Dispatcher.prototype.dispatch;
  if (origDispatch) {
    undici.Dispatcher.prototype.dispatch = function (opts, handler) {
      if (opts) stripBotPrefix(opts.headers);
      return origDispatch.call(this, opts, handler);
    };
  }
}

// Patch Client to fix READY event for user tokens
const { Client: OrigClient } = require('discord.js');

const origOn = OrigClient.prototype.on;
OrigClient.prototype.on = function (event, ...args) {
  return origOn.call(this, event, ...args);
};

// Listen for Raw event and inject missing application data for user tokens
const origEmit = OrigClient.prototype.emit;
OrigClient.prototype.emit = function (event, ...args) {
  if (event === 'raw' && args[0] && args[0].t === 'READY') {
    const data = args[0].d;
    if (data && !data.application) {
      data.application = { id: '0', flags: 0 };
    }
  }
  return origEmit.call(this, event, ...args);
};

module.exports = true;
