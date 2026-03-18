import type { Request, Response, NextFunction } from 'express';

const requestCounts = new Map<string, { count: number; resetAt: number }>();

export function createRateLimit(maxPerSecond = 10) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const entry = requestCounts.get(ip);

    if (!entry || now > entry.resetAt) {
      requestCounts.set(ip, { count: 1, resetAt: now + 1000 });
      next();
      return;
    }

    entry.count++;
    if (entry.count > maxPerSecond) {
      res.status(429).json({ error: 'Too many requests', retryAfter: Math.ceil((entry.resetAt - now) / 1000) });
      return;
    }

    next();
  };
}
