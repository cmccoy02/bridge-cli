import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../src/app.js';

describe('express api', () => {
  const app = createApp();

  it('reports health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('echoes a validated message', async () => {
    const res = await request(app).post('/echo').send({ message: 'hi', count: 2 });
    expect(res.status).toBe(200);
    expect(res.body.echoed).toEqual(['hi', 'hi']);
  });

  it('rejects an invalid body', async () => {
    const res = await request(app).post('/echo').send({ message: '' });
    expect(res.status).toBe(400);
  });
});
