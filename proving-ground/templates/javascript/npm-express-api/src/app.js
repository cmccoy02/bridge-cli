import express from 'express';
import { z } from 'zod';

const EchoSchema = z.object({
  message: z.string().min(1),
  count: z.number().int().positive().default(1)
});

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.post('/echo', (req, res) => {
    const parsed = EchoSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((issue) => issue.message) });
      return;
    }

    const { message, count } = parsed.data;
    res.json({ echoed: Array.from({ length: count }, () => message) });
  });

  return app;
}
