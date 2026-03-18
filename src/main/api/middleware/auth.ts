import type { Request, Response, NextFunction } from 'express';

export function createAuthMiddleware(validToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    const token = authHeader.slice(7);
    if (token !== validToken) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }

    next();
  };
}
