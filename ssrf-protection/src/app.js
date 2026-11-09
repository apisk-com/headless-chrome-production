import express from 'express';
import { renderPdf, takeScreenshot } from './render.js';
import { checkUrl, httpError } from './url-check.js';

// Turns a request body into a job: { url } or { html }.
function parseJob(body) {
  const { url, html } = body ?? {};
  if ((url === undefined) === (html === undefined)) {
    throw httpError(400, 'Send exactly one of "url" or "html".');
  }
  if (url !== undefined) {
    return { url: checkUrl(url) };
  }
  if (typeof html !== 'string' || html.trim() === '') {
    throw httpError(400, '"html" must be a string that is not empty.');
  }
  return { html };
}

// Sends the result and logs what the guard blocked.
function send(res, contentType, { body, blocked }) {
  if (blocked.length > 0) {
    console.warn(JSON.stringify({ blocked }));
  }
  res.set('X-Blocked-Requests', String(blocked.length));
  res.type(contentType).send(Buffer.from(body));
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/pdf', async (req, res) => {
    send(res, 'application/pdf', await renderPdf(parseJob(req.body)));
  });

  app.post('/screenshot', async (req, res) => {
    send(res, 'image/png', await takeScreenshot(parseJob(req.body)));
  });

  // Express 5 sends errors from async handlers here.
  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }
    let status = error.status ?? 500;
    let message = error.expose ? error.message : 'Rendering failed.';
    if (error.name === 'TimeoutError') {
      status = 504;
      message = 'The page did not load in time.';
    } else if (!error.expose && error.message?.includes('net::ERR_')) {
      // Do not pass on network details: they can show what exists inside.
      status = 502;
      message = 'The page could not be loaded.';
    }
    if (status === 500) {
      console.error(error);
    }
    res.status(status).json({ error: message, code: error.expose ? error.code : undefined });
  });

  return app;
}
